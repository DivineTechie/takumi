"""Supervisor review requests to the Standard Work Studio (P21)."""

from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from services.api.main import app

client = TestClient(app)
AUTH = {"Authorization": "Bearer t"}
BODY = {"skill_id": "skill_cable", "step": 2, "reason": "Trace-back of SN-0042", "suggested_instruction": "Fit the adapter with the mark facing up",
        "source": "traceback", "unit_id": "SN-0042"}


def _db(skill):
    db = MagicMock()
    skill_snap = MagicMock(exists=skill is not None)
    skill_snap.to_dict.return_value = skill
    new_ref = MagicMock(id="rr_1")

    def collection(name):
        col = MagicMock()
        if name == "skills":
            col.document.return_value.get.return_value = skill_snap
        else:
            col.document.return_value = new_ref
        return col

    db.collection.side_effect = collection
    return db, new_ref


def _as(role):
    return patch("services.api.auth.auth.verify_id_token", return_value={"uid": "u1", "role": role})


def test_only_supervisors_can_create():
    db, _ = _db({"steps": [{"n": 2}]})
    with _as("master"), patch("services.api.review_requests.get_firestore_client", return_value=db):
        assert client.post("/api/review-requests", json=BODY, headers=AUTH).status_code == 403


def test_unknown_skill_or_step_is_404():
    for skill in (None, {"steps": [{"n": 1}]}):
        db, ref = _db(skill)
        with _as("supervisor"), patch("services.api.review_requests.get_firestore_client", return_value=db):
            assert client.post("/api/review-requests", json=BODY, headers=AUTH).status_code == 404
        ref.set.assert_not_called()


def test_creates_open_request():
    db, ref = _db({"steps": [{"n": 1}, {"n": 2}]})
    with _as("supervisor"), patch("services.api.review_requests.get_firestore_client", return_value=db):
        res = client.post("/api/review-requests", json=BODY, headers=AUTH)
    assert res.status_code == 201
    saved = ref.set.call_args.args[0]
    assert saved["status"] == "open" and saved["step"] == 2 and saved["source"] == "traceback"
    assert saved["created_by_uid"] == "u1"
    assert "suggested_success_criteria" not in saved
