"""Trace-back agent: tools, safety checks and endpoint guards (no model calls)."""

from unittest.mock import patch

from fastapi.testclient import TestClient

from services.forge.agents.traceback import TracebackReport, TracebackTools, sanitise
from services.forge.auth import AuthUser, verify_auth_token
from services.forge.main import app


class _Snap:
    def __init__(self, data):
        self._data, self.exists = data, data is not None

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class _Col:
    def __init__(self, store, name):
        self.store, self.name = store, name

    def document(self, doc_id):
        store, path = self.store, f"{self.name}/{doc_id}"

        class _Doc:
            def get(self):
                return _Snap(store.get(path))

        return _Doc()

    def stream(self):
        prefix = self.name + "/"
        return [_Snap(d) for p, d in self.store.items() if p.startswith(prefix) and "/" not in p[len(prefix):]]


class FakeDB:
    def __init__(self, store):
        self.store = store

    def collection(self, name):
        return _Col(self.store, name)


def _record(issues, incomplete=()):
    return {"skill_id": "skill_cable", "station": "Cable station", "operator_uid": "op_secret",
            "incomplete_steps": list(incomplete), "issues": issues}


def _db():
    return FakeDB({
        "skills/skill_cable": {"title": "Cable station", "steps": [{"n": 2, "instruction": "Fit adapter", "success_criteria": "Adapter on"}]},
        "units/F1": {"id": "F1", "status": "failed", "inspections": ["i1"],
                     "station_records": [_record([{"step": 2, "type": "mistake", "reason": "reversed"}])]},
        "inspections/i1": {"ai_verdict": "defective", "confirm": {"defect": "adapter reversed"}, "human_decision": "confirmed_defect"},
        "units/A": {"id": "A", "status": "passed", "station_records": [_record([{"step": 2, "type": "mistake", "reason": "reversed"}])]},
        "units/B": {"id": "B", "status": "in_progress", "station_records": [_record([], incomplete=[2])]},
        "units/C": {"id": "C", "status": "passed", "station_records": [_record([{"step": 3, "type": "mistake"}])]},
        "units/D": {"id": "D", "status": "on_hold", "station_records": [_record([{"step": 2, "type": "mistake"}])]},
    })


def test_history_hides_operator_and_lists_issues():
    tools = TracebackTools(_db())
    h = tools.get_unit_history("F1")
    assert h["inspections"][0]["defect"] == "adapter reversed"
    assert h["stations"][0]["issues"][0]["reason"] == "reversed"
    assert "op_secret" not in str(h)
    assert ("skill_cable", 2) in tools.seen_steps
    assert tools.get_unit_history("nope") == {"error": "unit nope not found"}


def test_similar_units_same_step_only_and_skips_failed_or_held():
    tools = TracebackTools(_db())
    r = tools.find_similar_units("skill_cable", 2, "F1")
    assert sorted(u["unit_id"] for u in r["units"]) == ["A", "B"]
    b = next(u for u in r["units"] if u["unit_id"] == "B")
    assert b["issue_types"] == ["step_not_verified"]
    assert tools.seen_candidates == {"A", "B"}


def test_work_instruction():
    tools = TracebackTools(_db())
    assert tools.get_work_instruction("skill_cable", 2)["instruction"] == "Fit adapter"
    assert "error" in tools.get_work_instruction("skill_cable", 9)


def test_sanitise_drops_unbacked_holds_and_flags_unrecorded_step():
    tools = TracebackTools(_db())
    tools.get_unit_history("F1")
    tools.find_similar_units("skill_cable", 2, "F1")
    report = TracebackReport(
        summary="x", root_cause_skill_id="skill_cable", root_cause_step=2, confidence="high",
        hold_unit_ids=["A", "B", "C", "F1", "invented", "A"],
    )
    clean = sanitise(report, tools, "F1")
    assert clean.hold_unit_ids == ["A", "B"]
    assert clean.confidence == "high"

    wrong_step = sanitise(TracebackReport(summary="x", root_cause_skill_id="skill_cable", root_cause_step=3, confidence="high"), tools, "F1")
    assert wrong_step.confidence == "low"


def test_endpoint_requires_supervisor_and_never_fakes_output():
    client = TestClient(app)
    previous = app.dependency_overrides.get(verify_auth_token)
    app.dependency_overrides[verify_auth_token] = lambda: AuthUser(uid="t1", role="trainee", email=None)
    try:
        assert client.post("/forge/agents/traceback", json={"unit_id": "F1"}).status_code == 403
        app.dependency_overrides[verify_auth_token] = lambda: AuthUser(uid="s1", role="supervisor", email=None)
        assert client.post("/forge/agents/traceback", json={"unit_id": "bad/id"}).status_code == 422
        with patch("services.forge.main.MOCK_MODELS", True):
            assert client.post("/forge/agents/traceback", json={"unit_id": "F1"}).status_code == 503
    finally:
        if previous is None:
            app.dependency_overrides.pop(verify_auth_token, None)
        else:
            app.dependency_overrides[verify_auth_token] = previous
