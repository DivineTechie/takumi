"""Unit tests for Skill Passport issuance rules, name validation, concurrency lock,
public endpoint allowlist, and X-Forwarded-For rate limiting.
"""

from unittest.mock import MagicMock, patch
from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest

from services.api.main import app
from services.api.passports import (
    _public_rate_limits,
    check_public_rate_limit,
    evaluate_passport_eligibility,
    issue_passport_if_eligible,
    validate_trainee_name,
)


# --- 1. Pure Issuance Rule Tests ---


def test_issuance_rule_clean_three_runs_passes():
    total_steps = 4
    sessions = [
        {
            "id": "ses_1",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 2, "safety_stops": 0},
            "started_at": "2026-10-06T10:00:00Z",
        },
        {
            "id": "ses_2",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 1, "safety_stops": 0},
            "started_at": "2026-10-06T11:00:00Z",
        },
        {
            "id": "ses_3",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
            "started_at": "2026-10-06T12:00:00Z",
        },
    ]
    eligible, clean_ids = evaluate_passport_eligibility(sessions, total_steps)
    assert eligible is True
    assert clean_ids == ["ses_1", "ses_2", "ses_3"]


def test_issuance_rule_insufficient_runs_fails():
    total_steps = 4
    sessions = [
        {
            "id": "ses_1",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
            "started_at": "2026-10-06T10:00:00Z",
        },
        {
            "id": "ses_2",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
            "started_at": "2026-10-06T11:00:00Z",
        },
    ]
    eligible, clean_ids = evaluate_passport_eligibility(sessions, total_steps)
    assert eligible is False
    assert clean_ids == ["ses_1", "ses_2"]


def test_issuance_rule_safety_stop_disqualifies_run():
    total_steps = 4
    sessions = [
        {
            "id": "ses_1",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
            "started_at": "2026-10-06T10:00:00Z",
        },
        {
            "id": "ses_2",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 1},  # Has safety stop!
            "started_at": "2026-10-06T11:00:00Z",
        },
        {
            "id": "ses_3",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
            "started_at": "2026-10-06T12:00:00Z",
        },
    ]
    eligible, clean_ids = evaluate_passport_eligibility(sessions, total_steps)
    assert eligible is False
    assert clean_ids == ["ses_1", "ses_3"]


def test_issuance_rule_last_run_mistakes_greater_than_one_fails():
    total_steps = 4
    sessions = [
        {
            "id": "ses_1",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
            "started_at": "2026-10-06T10:00:00Z",
        },
        {
            "id": "ses_2",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
            "started_at": "2026-10-06T11:00:00Z",
        },
        {
            "id": "ses_3",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 2, "safety_stops": 0},  # 2 mistakes on last run!
            "started_at": "2026-10-06T12:00:00Z",
        },
    ]
    eligible, clean_ids = evaluate_passport_eligibility(sessions, total_steps)
    assert eligible is False
    assert len(clean_ids) == 3


def test_issuance_rule_incomplete_steps_disqualifies_run():
    total_steps = 4
    sessions = [
        {
            "id": "ses_1",
            "status": "completed",
            "result": {"steps_done": 3, "mistakes": 0, "safety_stops": 0},  # incomplete
            "started_at": "2026-10-06T10:00:00Z",
        },
        {
            "id": "ses_2",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
            "started_at": "2026-10-06T11:00:00Z",
        },
        {
            "id": "ses_3",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
            "started_at": "2026-10-06T12:00:00Z",
        },
    ]
    eligible, clean_ids = evaluate_passport_eligibility(sessions, total_steps)
    assert eligible is False


# --- 2. Name Validation Tests ---


def test_name_validation_allowed_scripts_and_symbols():
    # Devanagari vowel signs (marks), Vietnamese combining marks, hyphens, apostrophes
    assert validate_trainee_name("तुषार") is True
    assert validate_trainee_name("Nguyễn") is True
    assert validate_trainee_name("D'Souza") is True
    assert validate_trainee_name("Jean-Luc") is True
    assert validate_trainee_name("Tushar") is True
    assert validate_trainee_name("Takeshi") is True


def test_name_validation_rejected_inputs():
    # Email, digits, empty, too long
    assert validate_trainee_name("tushar@example.com") is False
    assert validate_trainee_name("Trainee123") is False
    assert validate_trainee_name("user_99") is False
    assert validate_trainee_name("") is False
    assert validate_trainee_name("A" * 31) is False


# --- 3. Concurrency Lock & Idempotency Tests ---


def test_issue_passport_concurrent_lock_handling():
    mock_db = MagicMock()
    lock_ref = MagicMock()
    mock_db.collection.return_value.document.return_value = lock_ref

    # 1. First completion: lock does not exist, succeeds
    lock_snap_first = MagicMock()
    lock_snap_first.exists = False
    lock_ref.get.return_value = lock_snap_first

    mock_skill_doc = MagicMock()
    mock_skill_doc.exists = True
    mock_skill_doc.to_dict.return_value = {
        "title": "Wire Terminals",
        "steps": [{}, {}, {}, {}],
    }

    # Setup session stream with 3 qualifying sessions
    mock_s1 = MagicMock()
    mock_s1.to_dict.return_value = {
        "id": "ses_1",
        "status": "completed",
        "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
    }
    mock_s2 = MagicMock()
    mock_s2.to_dict.return_value = {
        "id": "ses_2",
        "status": "completed",
        "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
    }
    current_session = {
        "id": "ses_3",
        "status": "completed",
        "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
    }

    def mock_collection(col_name):
        col_mock = MagicMock()
        if col_name == "skills":
            col_mock.document.return_value.get.return_value = mock_skill_doc
        elif col_name == "passport_locks":
            col_mock.document.return_value = lock_ref
        elif col_name == "sessions":
            col_mock.where.return_value.where.return_value.stream.return_value = [mock_s1, mock_s2]
        return col_mock

    mock_db.collection.side_effect = mock_collection

    # Mock transaction runner
    def mock_transactional_decorator(fn):
        def wrapper(*args, **kwargs):
            txn = MagicMock()
            return fn(txn)
        return wrapper

    with patch("google.cloud.firestore.transactional", mock_transactional_decorator):
        issued_id, count = issue_passport_if_eligible(
            db=mock_db,
            trainee_uid="uid_1",
            skill_id="skill_1",
            current_session=current_session,
            user_display_name="Tushar Aggarwal",
        )
        assert issued_id is not None
        assert issued_id.startswith("pp_")
        assert len(issued_id) == 19  # pp_ + 16 chars
        assert count == 3

    # 2. Second concurrent completion: lock already exists
    lock_snap_second = MagicMock()
    lock_snap_second.exists = True
    lock_ref.get.return_value = lock_snap_second

    with patch("google.cloud.firestore.transactional", mock_transactional_decorator):
        second_id, count2 = issue_passport_if_eligible(
            db=mock_db,
            trainee_uid="uid_1",
            skill_id="skill_1",
            current_session=current_session,
            user_display_name="Tushar Aggarwal",
        )
        assert second_id is None  # Idempotent lock prevents duplicate creation!
        assert count2 == 3


# --- 4. Public Endpoint Allowlist & 404 Tests ---


def test_public_passport_endpoint_unknown_404():
    client = TestClient(app)
    with patch("services.api.main.get_firestore_client") as mock_get_fs:
        mock_db = MagicMock()
        mock_doc = MagicMock()
        mock_doc.get.return_value.exists = False
        mock_db.collection.return_value.document.return_value = mock_doc
        mock_get_fs.return_value = mock_db

        resp = client.get("/api/passports/pp_unknown12345678")
        assert resp.status_code == 404
        assert resp.json()["detail"] == "This certificate could not be found."


def test_public_passport_endpoint_allowlisted_fields_only():
    client = TestClient(app)
    with patch("services.api.main.get_firestore_client") as mock_get_fs:
        mock_db = MagicMock()
        mock_doc = MagicMock()
        mock_doc.get.return_value.exists = True
        mock_doc.get.return_value.to_dict.return_value = {
            "id": "pp_safe123456789012",
            "trainee_uid": "SECRET_TRAINEE_UID",
            "skill_id": "skill_terminal_wiring_v1",
            "session_ids": ["ses_1", "ses_2", "ses_3"],
            "issued_at": "2026-10-06T12:00:00Z",
            "verify_url": "https://takumi-cup-2026.web.app/passport/pp_safe123456789012",
            "display_first_name": "Tushar",
            "skill_title": "Terminal Wiring",
            "master_display_name": "Master K.",
            "language": "hi",
            "mistakes_last_run": 0,
            "badge_path": "passports/badges/skill_terminal_wiring_v1.png",
            "email": "trainee_omitted_field",
        }
        mock_db.collection.return_value.document.return_value = mock_doc
        mock_get_fs.return_value = mock_db

        with patch("services.api.main.get_badge_signed_url_if_exists", return_value="https://storage.googleapis.com/signed_badge.png"):
            resp = client.get("/api/passports/pp_safe123456789012")
            assert resp.status_code == 200
            data = resp.json()

            # Verify allowlist fields present
            assert data["id"] == "pp_safe123456789012"
            assert data["display_first_name"] == "Tushar"
            assert data["skill_title"] == "Terminal Wiring"
            assert data["master_display_name"] == "Master K."
            assert data["language"] == "hi"
            assert data["issued_at"] == "2026-10-06T12:00:00Z"
            assert data["sessions_count"] == 3
            assert data["verified"] is True
            assert data["badge_url"] == "https://storage.googleapis.com/signed_badge.png"

            # Strict privacy check: private fields must NOT be present
            assert "trainee_uid" not in data
            assert "session_ids" not in data
            assert "email" not in data


# --- 5. X-Forwarded-For Public Rate Limit Tests ---


def test_public_rate_limit_first_address_in_xff():
    _public_rate_limits.clear()

    # Create dummy mock request
    req1 = MagicMock()
    req1.headers = {"x-forwarded-for": "203.0.113.195, 70.41.3.18, 150.172.238.178"}
    req1.client.host = "10.0.0.1"

    # Make 60 requests from 203.0.113.195
    for _ in range(60):
        check_public_rate_limit(req1, limit=60, window_s=60)

    # 61st request from same first IP should raise 429
    with pytest.raises(HTTPException) as exc_info:
        check_public_rate_limit(req1, limit=60, window_s=60)
    assert exc_info.value.status_code == 429

    # Request with different first IP in X-Forwarded-For should succeed
    req2 = MagicMock()
    req2.headers = {"x-forwarded-for": "198.51.100.42, 70.41.3.18"}
    req2.client.host = "10.0.0.1"
    check_public_rate_limit(req2, limit=60, window_s=60)


def test_preview_sessions_never_eligible_for_passport():
    total_steps = 4
    # 2 clean trainee sessions + 1 preview session (even though clean) should NOT be eligible
    sessions = [
        {
            "id": "ses_1",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
            "started_at": "2026-10-06T10:00:00Z",
            "preview": False,
        },
        {
            "id": "ses_2",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
            "started_at": "2026-10-06T11:00:00Z",
            "preview": False,
        },
        {
            "id": "ses_preview",
            "status": "completed",
            "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
            "started_at": "2026-10-06T12:00:00Z",
            "preview": True,
        },
    ]
    eligible, clean_ids = evaluate_passport_eligibility(sessions, total_steps)
    assert eligible is False
    assert clean_ids == ["ses_1", "ses_2"]


def test_issue_passport_skips_preview_session():
    mock_db = MagicMock()
    preview_session = {
        "id": "ses_preview",
        "status": "completed",
        "preview": True,
        "result": {"steps_done": 4, "mistakes": 0, "safety_stops": 0},
    }
    passport_id, clean_runs = issue_passport_if_eligible(
        db=mock_db,
        trainee_uid="master_1",
        skill_id="skill_wiring",
        current_session=preview_session,
    )
    assert passport_id is None
    assert clean_runs == 0
    # Make sure no queries or writes occurred
    mock_db.collection.assert_not_called()

