"""Tests for Machine Watch day statistics and the summary / soak-run endpoints (P17 pass 2)."""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from services.api.machine_stats import compute_machine_day
from services.api.main import app

client = TestClient(app)

T0 = datetime(2026, 10, 10, 8, 0, 0, tzinfo=timezone.utc)


def _ev(minutes: float, event_type: str, **kw):
    return {"ts": (T0 + timedelta(minutes=minutes)).isoformat(), "event_type": event_type, **kw}


def test_day_stats_timeline_availability_stops_and_alarms():
    events = [
        _ev(0, "state_change", to_state="running", source="HOME RIG"),
        _ev(0, "count", count=100),
        _ev(30, "state_change", to_state="stopped"),
        _ev(30, "alarm", alarm_text="E-104 SPINDLE OVERLOAD"),
        _ev(40, "alarm_cleared"),
        _ev(40, "state_change", to_state="running"),
        _ev(50, "state_change", to_state="idle"),
        _ev(55, "count", count=280),
        _ev(56, "count", count=9999, flag="rejected_misread"),
        _ev(60, "state_change", to_state="stopped"),
        _ev(60, "alarm", alarm_text="E-104 SPINDLE OVERLOAD"),
    ]
    stats = compute_machine_day(events, ideal_cycle_s=10.0, window_start=T0, window_end=T0 + timedelta(minutes=70))

    assert [s["state"] for s in stats["segments"]] == ["running", "stopped", "running", "idle", "stopped"]
    assert stats["running_s"] == 40 * 60
    assert stats["stopped_s"] == 20 * 60
    assert stats["idle_s"] == 10 * 60
    assert stats["availability"] == round(40 / 70, 4)
    assert stats["stops"] == 2
    assert stats["parts"] == 180  # rejected misread ignored
    assert stats["performance"] == round(180 * 10 / 2400, 4)
    assert stats["top_alarms"] == [{"alarm_text": "E-104 SPINDLE OVERLOAD", "count": 2}]
    assert stats["source"] == "HOME RIG"


def test_day_stats_empty_and_out_of_window():
    empty = compute_machine_day([], 10.0, T0, T0 + timedelta(hours=1))
    assert empty["availability"] is None
    assert empty["performance"] is None
    assert empty["segments"] == []

    outside = [_ev(-30, "state_change", to_state="running")]
    stats = compute_machine_day(outside, 10.0, T0, T0 + timedelta(hours=1))
    assert stats["events"] == 0
    assert stats["availability"] is None


def _snap(data):
    s = MagicMock()
    s.to_dict.return_value = dict(data)
    return s


def _db(machines, events, soak_runs=()):
    db = MagicMock()

    def collection(name):
        col = MagicMock()
        if name == "machines":
            col.stream.return_value = [_snap(m) for m in machines]
        elif name == "machine_events":
            q = MagicMock()
            q.stream.return_value = [_snap(e) for e in events]
            col.where.return_value = q
        elif name == "soak_runs":
            q = MagicMock()
            q.stream.return_value = [_snap(r) for r in soak_runs]
            col.where.return_value = q
        return col

    db.collection.side_effect = collection
    return db


def test_summary_endpoint_supervisor_only_and_uses_events():
    now = datetime.now(timezone.utc)
    events = [
        {"ts": (now - timedelta(minutes=20)).isoformat(), "machine_id": "m1", "event_type": "state_change",
         "to_state": "running", "source": "LIVE"},
        {"ts": (now - timedelta(minutes=10)).isoformat(), "machine_id": "m1", "event_type": "state_change",
         "to_state": "stopped", "source": "LIVE"},
    ]
    db = _db([{"id": "m1", "name": "Press 1", "ideal_cycle_s": 12}], events)

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "t1", "role": "trainee"}):
        assert client.get("/api/machines/summary", headers={"Authorization": "Bearer x"}).status_code == 403

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "s1", "role": "supervisor"}), \
         patch("services.api.machines.get_firestore_client", return_value=db):
        resp = client.get("/api/machines/summary", headers={"Authorization": "Bearer x"})
        assert resp.status_code == 200
        (m,) = resp.json()["machines"]
        assert m["name"] == "Press 1"
        assert m["stops"] == 1
        assert m["source"] == "LIVE"
        assert 0.4 < m["availability"] < 0.6

        bad = client.get("/api/machines/summary?day=10-10-2026", headers={"Authorization": "Bearer x"})
        assert bad.status_code == 400


def test_my_soak_runs_newest_first():
    runs = [
        {"id": "a", "created_by": "u1", "started_at": "2026-10-10T08:00:00+00:00"},
        {"id": "b", "created_by": "u1", "started_at": "2026-10-10T09:00:00+00:00"},
    ]
    db = _db([], [], runs)
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "u1", "role": "trainee"}), \
         patch("services.api.machines.get_firestore_client", return_value=db):
        resp = client.get("/api/soak/mine", headers={"Authorization": "Bearer x"})
    assert resp.status_code == 200
    assert [r["id"] for r in resp.json()] == ["b", "a"]
