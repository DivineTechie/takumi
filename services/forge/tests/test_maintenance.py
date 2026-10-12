"""Maintenance agent tools, alarm guide and endpoint guards (no model calls)."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from services.forge.agents.maintenance import MaintenanceTools, WorkOrderDraft
from services.forge.auth import AuthUser, verify_auth_token
from services.forge.main import app
from services.forge.tests.test_demand import FakeDB
from shared.ops.alarm_guide import lookup

NOW = datetime(2026, 10, 11, 12, 0, tzinfo=timezone.utc)


def _store():
    def ago(**kw):
        return (NOW - timedelta(**kw)).isoformat()

    return {
        "machines/m1": {"id": "m1", "name": "Press 2", "source": "VIRTUAL", "state": "stopped", "last_alarm": "E-221 COOLANT LOW", "last_count": 380},
        "machines/m2": {"id": "m2", "name": "Lathe", "source": "LIVE", "state": "running", "last_alarm": None},
        "machine_events/old": {"machine_id": "m1", "event_type": "alarm", "alarm_text": "E-221 COOLANT LOW", "ts": ago(days=9)},
        "machine_events/a0": {"machine_id": "m1", "event_type": "alarm", "alarm_text": "E-221 COOLANT LOW", "ts": ago(days=2)},
        "machine_events/s0": {"machine_id": "m1", "event_type": "state_change", "to_state": "stopped", "ts": ago(days=2)},
        "machine_events/r0": {"machine_id": "m1", "event_type": "state_change", "to_state": "running", "ts": ago(days=2, minutes=-20)},
        "machine_events/s1": {"machine_id": "m1", "event_type": "state_change", "to_state": "stopped", "ts": ago(minutes=6)},
        "machine_events/a1": {"machine_id": "m1", "event_type": "alarm", "alarm_text": "E-221 COOLANT LOW", "ts": ago(minutes=6)},
        "machine_events/c1": {"machine_id": "m1", "event_type": "count", "count": 380, "ts": ago(minutes=5)},
        "machine_events/other": {"machine_id": "m2", "event_type": "alarm", "alarm_text": "E-104 SPINDLE OVERLOAD", "ts": ago(minutes=3)},
        "work_orders/w0": {"machine_id": "m1", "alarm_text": "E-221 COOLANT LOW", "status": "approved", "created_at": ago(days=2),
                           "draft": {"title": "Refill coolant"}, "decision_note": "topped up"},
    }


def test_alarm_guide_matches_code_or_title():
    assert lookup("E-221 COOLANT LOW")["title"] == "Coolant low"
    assert lookup("e221 coolant low")["code"] == "E-221"
    assert lookup("SPINDLE OVERLOAD on screen")["code"] == "E-104"
    assert lookup("E-999 UNKNOWN") is None and lookup(None) is None
    assert "not a vendor manual" in lookup("E-310")["source"]


def test_status_reports_minutes_stopped_from_last_stop():
    s = MaintenanceTools(FakeDB(_store()), "m1", now=NOW).get_machine_status()
    assert s["state"] == "stopped" and s["alarm_text"] == "E-221 COOLANT LOW" and s["minutes_stopped"] == 6.0
    assert "stopped_since" not in s  # people read the draft: minutes, never a raw timestamp


def test_history_is_this_machine_last_7_days_only():
    h = MaintenanceTools(FakeDB(_store()), "m1", now=NOW).get_machine_history()
    assert h["stops"] == 2
    assert h["alarm_counts"] == {"E-221 COOLANT LOW": 2}  # the 9-day-old alarm and m2's alarm are excluded
    assert all(e["event_type"] != "count" for e in h["latest_events"])


def test_past_work_orders_and_unknown_machine():
    t = MaintenanceTools(FakeDB(_store()), "m1", now=NOW)
    assert t.get_past_work_orders()["work_orders"][0]["note"] == "topped up"
    assert "error" in MaintenanceTools(FakeDB(_store()), "nope", now=NOW).get_machine_status()
    assert "error" in t.lookup_alarm_guide("E-999 X")


class _WritableDB(FakeDB):
    """FakeDB whose documents can also be set (for the endpoint)."""

    def collection(self, name):
        col = super().collection(name)
        store = self.store
        get_doc = col.document

        def document(doc_id):
            d = get_doc(doc_id)
            d.set = lambda data: store.__setitem__(f"{name}/{doc_id}", dict(data))
            return d

        col.document = document
        return col


def _client_as(role):
    app.dependency_overrides[verify_auth_token] = lambda: AuthUser(uid="s", role=role, email=None)
    return TestClient(app)


def test_endpoint_guards_saves_draft_and_dedups():
    previous = app.dependency_overrides.get(verify_auth_token)
    db = _WritableDB(_store())
    draft = WorkOrderDraft(title="Press 2: coolant low", summary="x", operator_alert="Press 2 stopped.").model_dump()
    run = AsyncMock(return_value={"draft": draft, "machine": {}, "agent_steps": [{"agent": "maintenance_lead", "tool": "get_machine_status", "args": {}}]})
    try:
        assert _client_as("trainee").post("/forge/agents/maintenance", json={"machine_id": "m1"}).status_code == 403
        client = _client_as("supervisor")
        with patch("services.forge.main.get_firestore_client", return_value=db), patch("services.forge.main.MOCK_MODELS", False), \
                patch("services.forge.agents.maintenance.run_maintenance", run):
            assert client.post("/forge/agents/maintenance", json={"machine_id": "m2"}).status_code == 409
            assert client.post("/forge/agents/maintenance", json={"machine_id": "zz"}).status_code == 404
            first = client.post("/forge/agents/maintenance", json={"machine_id": "m1"}).json()
            assert first["status"] == "draft" and first["source"] == "HOME RIG" and first["existing"] is False
            assert db.store[f"work_orders/{first['id']}"]["draft"]["title"] == "Press 2: coolant low"
            second = client.post("/forge/agents/maintenance", json={"machine_id": "m1"}).json()
            assert second["existing"] is True and second["id"] == first["id"]
            assert run.await_count == 1
    finally:
        if previous is None:
            app.dependency_overrides.pop(verify_auth_token, None)
        else:
            app.dependency_overrides[verify_auth_token] = previous
