"""Unit records (P16): serial on Station Watch sessions, station records, history, holds."""

from unittest.mock import patch

from fastapi.testclient import TestClient
from google.cloud import firestore

from services.api.main import app
from services.api.units import build_station_record

client = TestClient(app)
AUTH = {"Authorization": "Bearer token"}


class _Snap:
    def __init__(self, data):
        self._data = data
        self.exists = data is not None

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class _Doc:
    def __init__(self, store, path):
        self.store, self.path = store, path

    def get(self):
        return _Snap(self.store.get(self.path))

    def set(self, data, merge=False):
        if merge and self.path in self.store:
            self.store[self.path].update(data)
        else:
            self.store[self.path] = dict(data)

    def update(self, data):
        cur = self.store[self.path]
        for k, v in data.items():
            if isinstance(v, firestore.ArrayUnion):
                cur[k] = list(cur.get(k) or []) + [x for x in v.values if x not in (cur.get(k) or [])]
            else:
                cur[k] = v

    def collection(self, name):
        return _Col(self.store, f"{self.path}/{name}")

    @property
    def reference(self):
        return self


class _Col:
    def __init__(self, store, path, filters=()):
        self.store, self.path, self.filters = store, path, filters

    def document(self, doc_id):
        return _Doc(self.store, f"{self.path}/{doc_id}")

    def where(self, field, op, value):
        return _Col(self.store, self.path, self.filters + ((field, op, value),))

    def stream(self):
        ops = {"==": lambda a, b: a == b, ">=": lambda a, b: a is not None and a >= b, "<=": lambda a, b: a is not None and a <= b}
        prefix = self.path + "/"
        out = []
        for p, d in self.store.items():
            if p.startswith(prefix) and "/" not in p[len(prefix):] and all(ops[o](d.get(f), v) for f, o, v in self.filters):
                out.append(_Snap(d))
        return out


class FakeDB:
    def __init__(self):
        self.store = {}

    def collection(self, name):
        return _Col(self.store, name)


def _user(uid, role):
    return patch("services.api.auth.auth.verify_id_token", return_value={"uid": uid, "role": role})


def _db(db):
    return patch("services.api.main.get_firestore_client", return_value=db), patch(
        "services.api.units.get_firestore_client", return_value=db
    )


def _seed_skill(db):
    db.store["skills/skill_cable"] = {
        "id": "skill_cable",
        "title": "Cable and adapter assembly",
        "status": "published",
        "steps": [{"n": 1, "instruction": "Insert cable"}, {"n": 2, "instruction": "Fit adapter"}, {"n": 3, "instruction": "Apply label"}],
    }


def test_build_station_record_summarises_issues():
    session = {
        "id": "ses_1",
        "skill_id": "skill_cable",
        "trainee_uid": "op_1",
        "status": "completed",
        "started_at": "2026-10-10T08:00:00+00:00",
        "ended_at": "2026-10-10T08:05:00+00:00",
        "steps": [{"n": 1, "state": "done"}, {"n": 2, "state": "done"}, {"n": 3, "state": "active"}],
        "result": {"steps_done": 2, "mistakes": 1, "safety_stops": 0},
    }
    events = [
        {"t": "2026-10-10T08:01:00+00:00", "step": 2, "type": "mistake", "reason": "adapter reversed", "frame_uri": "gs://b/f.jpg"},
        {"t": "2026-10-10T08:00:30+00:00", "step": 1, "type": "step_done"},
    ]
    skill = {"title": "Cable and adapter assembly", "steps": [{"n": 2, "instruction": "Fit adapter"}]}
    r = build_station_record(session, events, skill)
    assert r["station"] == "Cable and adapter assembly"
    assert r["incomplete_steps"] == [3]
    assert r["issues"] == [{
        "step": 2, "step_title": "Fit adapter", "type": "mistake", "reason": "adapter reversed",
        "t": "2026-10-10T08:01:00+00:00", "frame_uri": "gs://b/f.jpg",
    }]


def test_session_with_serial_creates_unit_and_records_station_once():
    db = FakeDB()
    _seed_skill(db)
    p1, p2 = _db(db)
    with _user("op_1", "trainee"), p1, p2:
        res = client.post("/api/sessions", json={"skill_id": "skill_cable", "language": "en", "unit_id": "SN-0001", "product_id": "cable_kit"}, headers=AUTH)
        assert res.status_code == 201
        sid = res.json()["id"]
        assert db.store["units/SN-0001"]["status"] == "in_progress"
        assert db.store["units/SN-0001"]["product_id"] == "cable_kit"

        db.store[f"sessions/{sid}/events/e1"] = {"t": "2026-10-10T08:01:00+00:00", "step": 2, "type": "mistake", "reason": "adapter reversed"}
        db.store[f"sessions/{sid}/events/e2"] = {"t": "2026-10-10T08:02:00+00:00", "step": 1, "type": "step_done"}
        with patch("services.api.main.issue_passport_if_eligible", return_value=(None, 0)):
            assert client.patch(f"/api/sessions/{sid}", json={"status": "completed"}, headers=AUTH).status_code == 200
            # A second PATCH must not add a duplicate station record
            client.patch(f"/api/sessions/{sid}", json={"status": "completed"}, headers=AUTH)

    records = db.store["units/SN-0001"]["station_records"]
    assert len(records) == 1
    assert records[0]["session_id"] == sid
    assert records[0]["issues"][0]["reason"] == "adapter reversed"
    assert records[0]["issues"][0]["step_title"] == "Fit adapter"


def test_session_rejects_bad_serial():
    db = FakeDB()
    _seed_skill(db)
    p1, p2 = _db(db)
    with _user("op_1", "trainee"), p1, p2:
        res = client.post("/api/sessions", json={"skill_id": "skill_cable", "language": "en", "unit_id": "bad/serial"}, headers=AUTH)
    assert res.status_code == 422
    assert not any(k.startswith("units/") for k in db.store)


def test_history_permissions_and_operator_hidden_from_non_supervisors():
    db = FakeDB()
    db.store["units/SN-7"] = {
        "id": "SN-7", "status": "needs_review", "created_by": "op_1", "inspections": [],
        "station_records": [{"session_id": "ses_9", "operator_uid": "op_1", "issues": [{"step": 2, "frame_uri": None}]}],
    }
    p1, p2 = _db(db)
    with p1, p2:
        with _user("op_2", "trainee"):
            assert client.get("/api/units/SN-7/history", headers=AUTH).status_code == 403
        with _user("op_1", "trainee"):
            res = client.get("/api/units/SN-7/history", headers=AUTH)
            assert res.status_code == 200
            assert "operator_uid" not in res.json()["station_records"][0]
        with _user("sup_1", "supervisor"):
            res = client.get("/api/units/SN-7/history", headers=AUTH)
            assert res.json()["station_records"][0]["operator_uid"] == "op_1"


def test_hold_and_release_are_supervisor_only_and_restore_status():
    db = FakeDB()
    db.store["units/A"] = {"id": "A", "status": "passed", "created_at": "2026-10-10T08:00:00+00:00"}
    db.store["units/B"] = {"id": "B", "status": "failed", "created_at": "2026-10-10T08:01:00+00:00"}
    p1, p2 = _db(db)
    with p1, p2:
        with _user("op_1", "trainee"):
            assert client.post("/api/units/hold", json={"unit_ids": ["A"], "reason": "suspect"}, headers=AUTH).status_code == 403
        with _user("sup_1", "supervisor"):
            res = client.post("/api/units/hold", json={"unit_ids": ["A", "B", "missing"], "reason": "same step 2 mistake", "source": "traceback"}, headers=AUTH)
            assert res.json()["held"] == ["A"]
            assert {s["id"] for s in res.json()["skipped"]} == {"B", "missing"}
            assert db.store["units/A"]["status"] == "on_hold"
            assert db.store["units/A"]["holds"][0]["previous_status"] == "passed"

            listed = client.get("/api/units?status=on_hold", headers=AUTH).json()
            assert [u["id"] for u in listed] == ["A"]

            assert client.post("/api/units/A/release", headers=AUTH).json()["status"] == "passed"
            assert client.post("/api/units/A/release", headers=AUTH).status_code == 409
