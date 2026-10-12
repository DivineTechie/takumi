"""Tests for the Studio service endpoints (no model calls, no cloud)."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from services.forge import gemini, main
from services.forge.auth import AuthUser, verify_auth_token
from services.forge.config import STUDIO_RUNS_PER_DAY
from services.forge.gemini import StudioModelError
from services.forge.main import app
from services.forge.models.state import ForgeState
from services.forge.regenerate import regenerate_part
from services.forge.tests.studio_fakes import FakeGenai

client = TestClient(app)


class _Doc:
    def __init__(self, store, path):
        self.store, self.path = store, path

    def get(self, transaction=None):
        d = self.store.get(self.path)
        return SimpleNamespace(exists=d is not None, to_dict=lambda: dict(d) if d is not None else None)

    def set(self, data, merge=False):
        self.store[self.path] = {**(self.store.get(self.path) or {}), **data} if merge else dict(data)

    def update(self, data):
        if self.path not in self.store:
            raise KeyError(self.path)
        self.store[self.path].update(data)

    def delete(self):
        self.store.pop(self.path, None)


class StoreDB:
    def __init__(self, store=None):
        self.store = store or {}

    def collection(self, name):
        return SimpleNamespace(document=lambda doc_id: _Doc(self.store, f"{name}/{doc_id}"))


def _store():
    return {
        "captures/cap_1": {"id": "cap_1", "master_uid": "m1", "skill_title": "Wire a terminal block", "source_language": "ja",
                           "status": "uploaded", "transcript": [{"t": 3.0, "speaker": "master", "text": "Left is neutral."}]},
        "captures/cap_2": {"id": "cap_2", "master_uid": "someone_else", "skill_title": "Other", "status": "uploaded"},
        "skills/skill_1": {"id": "skill_1", "title": "Wire", "capture_id": "cap_1", "languages": ["en", "vi"],
                           "steps": [{"n": 1, "instruction": "Insert the blue wire.", "success_criteria": "x", "why": "y"}]},
        "forge_jobs/job_1": {"capture_id": "cap_1", "skill_id": "skill_1", "status": "running", "started_at": "t", "finished_at": None},
    }


@pytest.fixture
def as_role():
    def set_role(role, uid="m1"):
        app.dependency_overrides[verify_auth_token] = lambda: AuthUser(uid=uid, role=role, email=None)
    yield set_role
    app.dependency_overrides.pop(verify_auth_token, None)


def test_dev_token_is_rejected_outside_local_dev():
    """Regression: a made-up "dev_" token must never authenticate in a deployed service."""
    app.dependency_overrides.pop(verify_auth_token, None)
    with patch("services.forge.auth.LOCAL_DEV", False):
        for headers in ({}, {"Authorization": "Bearer dev_probe"}, {"Authorization": "Bearer not-a-token"}):
            res = client.get("/forge/jobs/job_12345", headers=headers)
            assert res.status_code in (401, 503), headers


def test_healthz_and_title():
    res = client.get("/healthz")
    assert res.status_code == 200 and res.json() == {"status": "ok"}
    assert app.title == "TAKUMI Studio and agents"


def test_only_masters_start_the_studio(as_role):
    db = StoreDB(_store())
    with patch.object(main, "get_firestore_client", return_value=db), patch.object(main, "MOCK_MODELS", False):
        for role in ("trainee", "supervisor", None):
            as_role(role)
            assert client.post("/forge/jobs", json={"capture_id": "cap_1"}).status_code == 403
    assert not any(k.startswith("forge_jobs/job_2") for k in db.store)


def test_studio_unavailable_offline(as_role):
    as_role("master")
    with patch.object(main, "get_firestore_client", return_value=None):
        assert client.post("/forge/jobs", json={"capture_id": "cap_1"}).status_code == 503
        assert client.get("/forge/jobs/job_1").status_code == 503
        assert client.post("/forge/steps/regenerate", json={"skill_id": "skill_1", "n": 1, "part": "why"}).status_code == 503


def test_master_starts_a_run_on_their_own_capture(as_role):
    as_role("master")
    db = StoreDB(_store())
    run = AsyncMock()
    with patch.object(main, "get_firestore_client", return_value=db), patch.object(main, "MOCK_MODELS", False), \
            patch.object(main, "reserve_studio_run", return_value=1), patch.object(main, "execute_forge_job_task", run):
        assert client.post("/forge/jobs", json={"capture_id": "missing"}).status_code == 404
        assert client.post("/forge/jobs", json={"capture_id": "cap_2"}).status_code == 403
        assert client.post("/forge/jobs", json={"capture_id": "../x"}).status_code == 422
        res = client.post("/forge/jobs", json={"capture_id": "cap_1"})
    assert res.status_code == 202
    job_id, skill_id = res.json()["job_id"], res.json()["skill_id"]
    assert db.store[f"forge_jobs/{job_id}"]["status"] == "queued"
    placeholder = db.store[f"skills/{skill_id}"]
    assert placeholder["title"] == "Wire a terminal block" and placeholder["steps"] == [] and placeholder["languages"] == []
    assert db.store["captures/cap_1"]["status"] == "forging"
    assert run.await_count == 1


def test_daily_studio_cap_returns_429(as_role):
    as_role("master")
    db = StoreDB(_store())
    with patch.object(main, "get_firestore_client", return_value=db), patch.object(main, "MOCK_MODELS", False), \
            patch.object(main, "reserve_studio_run", return_value=None), patch.object(main, "execute_forge_job_task", AsyncMock()):
        res = client.post("/forge/jobs", json={"capture_id": "cap_1"})
    assert res.status_code == 429
    assert f"{STUDIO_RUNS_PER_DAY} recordings per day" in res.json()["detail"]
    assert not any(k.startswith("forge_jobs/job_2") for k in db.store)


def test_reserve_counts_up_to_the_cap():
    db = StoreDB()
    ref = db.collection("rate_limits").document("forge_m1_20261012")
    txn = SimpleNamespace(set=lambda r, data, merge: r.set(data, merge=merge))
    counts = [main._reserve(txn, ref, "20261012") for _ in range(STUDIO_RUNS_PER_DAY + 1)]
    assert counts == list(range(1, STUDIO_RUNS_PER_DAY + 1)) + [None]
    assert db.store["rate_limits/forge_m1_20261012"]["studio_runs"] == STUDIO_RUNS_PER_DAY


def test_job_status_is_read_not_invented(as_role):
    db = StoreDB(_store())
    with patch.object(main, "get_firestore_client", return_value=db):
        as_role("trainee")
        assert client.get("/forge/jobs/job_1").status_code == 403
        as_role("supervisor")
        assert client.get("/forge/jobs/job_404").status_code == 404
        res = client.get("/forge/jobs/job_1")
    assert res.status_code == 200 and res.json()["status"] == "running" and res.json()["job_id"] == "job_1"


def test_failed_run_marks_job_and_capture_and_drops_the_empty_lesson():
    db = StoreDB({
        **_store(),
        "skills/skill_new": {"id": "skill_new", "steps": []},
        "forge_jobs/job_new": {"status": "running"},
    })
    main.mark_job_failed(db, ForgeState(job_id="job_new", capture_id="cap_1", skill_id="skill_new"))
    assert db.store["forge_jobs/job_new"]["status"] == "failed" and db.store["forge_jobs/job_new"]["finished_at"]
    assert db.store["captures/cap_1"]["status"] == "failed"
    assert "skills/skill_new" not in db.store
    main.mark_job_failed(db, ForgeState(job_id="job_1", capture_id="cap_1", skill_id="skill_1"))
    assert "skills/skill_1" in db.store  # a lesson with steps is never deleted


def test_regenerate_returns_real_model_output(as_role):
    db = StoreDB(_store())
    regen = AsyncMock(return_value={"text": "Insert the blue wire into the left terminal.", "translations": {"vi": "Cắm dây xanh."}})
    with patch.object(main, "get_firestore_client", return_value=db), patch.object(main, "MOCK_MODELS", False), \
            patch("services.forge.regenerate.regenerate_part", regen):
        as_role("trainee")
        assert client.post("/forge/steps/regenerate", json={"skill_id": "skill_1", "n": 1, "part": "instruction"}).status_code == 403
        as_role("master", uid="someone_else")
        assert client.post("/forge/steps/regenerate", json={"skill_id": "skill_1", "n": 1, "part": "instruction"}).status_code == 403
        as_role("master")
        assert client.post("/forge/steps/regenerate", json={"skill_id": "nope", "n": 1, "part": "instruction"}).status_code == 404
        assert client.post("/forge/steps/regenerate", json={"skill_id": "skill_1", "n": 9, "part": "instruction"}).status_code == 404
        assert client.post("/forge/steps/regenerate", json={"skill_id": "skill_1", "n": 1, "part": "card"}).status_code == 422
        res = client.post("/forge/steps/regenerate", json={"skill_id": "skill_1", "n": 1, "part": "instruction"})
        assert res.status_code == 200
        assert res.json() == {"skill_id": "skill_1", "n": 1, "part": "instruction",
                              "text": "Insert the blue wire into the left terminal.", "translations": {"vi": "Cắm dây xanh."}}
        skill_arg, step_arg, part_arg, transcript_arg = regen.await_args.args
        assert step_arg["n"] == 1 and part_arg == "instruction" and transcript_arg[0]["text"] == "Left is neutral."
        assert db.store["skills/skill_1"]["steps"][0]["instruction"] == "Insert the blue wire."  # nothing saved

        regen.side_effect = StudioModelError("timeout")
        assert client.post("/forge/steps/regenerate", json={"skill_id": "skill_1", "n": 1, "part": "why"}).status_code == 502


def test_regenerate_part_uses_the_model_answer_and_only_lesson_languages(monkeypatch):
    def answer(model, contents, config):
        assert "Rewrite the step's success criteria" in contents[0]
        assert "[15.0s] master: Left is neutral." in contents[0] and "Later." not in contents[0]
        return json.dumps({"text": "The blue ferrule is inside the left terminal.", "translations": [
            {"language": "vi", "text": "Đầu cos xanh nằm trong cổng trái."},
            {"language": "xx", "text": "ignored"},
            {"language": "hi", "text": " "},
        ]})

    monkeypatch.setattr(gemini, "get_client", lambda: FakeGenai(answer))
    skill = {"title": "Wire", "languages": ["en", "vi", "hi"], "steps": [{"n": 1, "instruction": "Insert the blue wire."}]}
    step = {"n": 1, "instruction": "Insert the blue wire.", "success_criteria": "Seated properly.", "clip": {"start_s": 10, "end_s": 20}}
    transcript = [{"t": 15.0, "speaker": "master", "text": "Left is neutral."}, {"t": 90.0, "speaker": "master", "text": "Later."}]
    out = asyncio.run(regenerate_part(skill, step, "success_criteria", transcript))
    assert out == {"text": "The blue ferrule is inside the left terminal.", "translations": {"vi": "Đầu cos xanh nằm trong cổng trái."}}
