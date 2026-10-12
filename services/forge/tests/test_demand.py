"""Demand agent tools and guards (no model calls)."""

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi.testclient import TestClient

from services.forge.agents.demand import DemandReport, DemandTools, OrderVerdict, sanitise
from services.forge.auth import AuthUser, verify_auth_token
from services.forge.main import app

NOW = datetime(2026, 10, 11, 12, 0, tzinfo=timezone.utc)


class _Snap:
    def __init__(self, d):
        self._d, self.exists = d, d is not None

    def to_dict(self):
        return dict(self._d) if self._d is not None else None


class _Col:
    def __init__(self, store, name, filters=()):
        self.store, self.name, self.filters = store, name, filters

    def document(self, doc_id):
        store, path = self.store, f"{self.name}/{doc_id}"

        class _Doc:
            def get(self):
                return _Snap(store.get(path))

        return _Doc()

    def where(self, field, op, value):
        return _Col(self.store, self.name, self.filters + ((field, op, value),))

    def stream(self):
        ok = {"==": lambda a, b: a == b, ">=": lambda a, b: a is not None and a >= b}
        prefix = self.name + "/"
        return [_Snap(d) for p, d in self.store.items()
                if p.startswith(prefix) and "/" not in p[len(prefix):] and all(ok[o](d.get(f), v) for f, o, v in self.filters)]


class FakeDB:
    def __init__(self, store):
        self.store = store

    def collection(self, name):
        return _Col(self.store, name)


def _db():
    store = {
        "machines/m1": {"id": "m1", "name": "Press 2", "source": "VIRTUAL", "ideal_cycle_s": 8, "state": "stopped", "last_alarm": "E-221 COOLANT LOW"},
        "orders/o1": {"id": "o1", "name": "Order A", "quantity": 900, "status": "open", "machine_ids": ["m1"],
                      "created_at": (NOW - timedelta(hours=2)).isoformat(), "due_at": (NOW + timedelta(hours=2)).isoformat()},
        "orders/o2": {"id": "o2", "name": "Old", "quantity": 5, "status": "closed", "machine_ids": ["m1"],
                      "created_at": (NOW - timedelta(hours=2)).isoformat(), "due_at": (NOW + timedelta(hours=2)).isoformat()},
    }
    for i, (mins, count) in enumerate([(110, 0), (40, 300), (20, 380), (5, 380)]):
        store[f"machine_events/c{i}"] = {"machine_id": "m1", "event_type": "count", "count": count, "ts": (NOW - timedelta(minutes=mins)).isoformat()}
    store["machine_events/s1"] = {"machine_id": "m1", "event_type": "state_change", "to_state": "stopped", "ts": (NOW - timedelta(minutes=15)).isoformat()}
    store["machine_events/a1"] = {"machine_id": "m1", "event_type": "alarm", "alarm_text": "E-221 COOLANT LOW", "ts": (NOW - timedelta(minutes=15)).isoformat()}
    return FakeDB(store)


def test_orders_tool_uses_shared_projection_and_only_open_orders():
    tools = DemandTools(_db(), now=NOW)
    r = tools.list_open_orders()
    assert [o["order_id"] for o in r["orders"]] == ["o1"]
    o = r["orders"][0]
    assert o["made"] == 380 and o["source"] == "HOME RIG"
    assert o["on_track"] is False and o["shortfall"] > 0


def test_machine_history_counts_stops_and_alarms():
    h = DemandTools(_db(), now=NOW).get_machine_history("m1")
    assert h["stops_last_8h"] == 1 and h["alarms_last_8h"] == ["E-221 COOLANT LOW"] and h["state"] == "stopped"
    assert "error" in DemandTools(_db(), now=NOW).get_machine_history("nope")


def test_sanitise_drops_unknown_orders():
    tools = DemandTools(_db(), now=NOW)
    tools.list_open_orders()
    rep = sanitise(DemandReport(summary="x", orders=[OrderVerdict(order_id="o1", verdict="at risk"), OrderVerdict(order_id="ghost", verdict="ok")]), tools)
    assert [o.order_id for o in rep.orders] == ["o1"]


def test_endpoint_supervisor_only_and_no_fake_output():
    client = TestClient(app)
    previous = app.dependency_overrides.get(verify_auth_token)
    try:
        app.dependency_overrides[verify_auth_token] = lambda: AuthUser(uid="t", role="trainee", email=None)
        assert client.post("/forge/agents/demand").status_code == 403
        app.dependency_overrides[verify_auth_token] = lambda: AuthUser(uid="s", role="supervisor", email=None)
        with patch("services.forge.main.MOCK_MODELS", True):
            assert client.post("/forge/agents/demand").status_code == 503
    finally:
        if previous is None:
            app.dependency_overrides.pop(verify_auth_token, None)
        else:
            app.dependency_overrides[verify_auth_token] = previous
