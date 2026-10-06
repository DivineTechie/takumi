"""Unit tests for supervisor insight endpoints (/api/insights/matrix, /api/insights/skill/{id}, /api/sessions/{id}/replay)."""

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
import pytest
from fastapi.testclient import TestClient

from services.api.main import app, clear_insights_cache

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_cache():
    clear_insights_cache()
    yield
    clear_insights_cache()


# ==========================================
# 1. Authorization tests (Non-supervisor -> 403)
# ==========================================


def test_supervisor_endpoints_require_supervisor_role():
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        res1 = client.get("/api/insights/matrix", headers={"Authorization": "Bearer token"})
        assert res1.status_code == 403

        res2 = client.get("/api/insights/skill/skill_wiring", headers={"Authorization": "Bearer token"})
        assert res2.status_code == 403

        res3 = client.get("/api/sessions/ses_123/replay", headers={"Authorization": "Bearer token"})
        assert res3.status_code == 403

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "master_1", "role": "master"}):
        res4 = client.get("/api/insights/matrix", headers={"Authorization": "Bearer token"})
        assert res4.status_code == 403


# ==========================================
# 2. GET /api/insights/matrix
# ==========================================


def test_insights_matrix_excludes_smoke_trainee_and_privacy_first_names():
    mock_db = MagicMock()

    # Published skills
    skill_doc = MagicMock()
    skill_doc.id = "skill_terminal_wiring_v1"
    skill_doc.to_dict.return_value = {"title": "Wire a DIN-rail terminal block", "status": "published"}

    # Passports (certified)
    passport_doc = MagicMock()
    passport_doc.to_dict.return_value = {
        "trainee_uid": "trainee_certified_1",
        "skill_id": "skill_terminal_wiring_v1",
    }

    # Sessions
    ses1 = MagicMock()
    ses1.to_dict.return_value = {
        "trainee_uid": "smoke-trainee",  # MUST BE EXCLUDED
        "skill_id": "skill_terminal_wiring_v1",
        "status": "completed",
        "started_at": "2026-10-06T10:00:00Z",
        "result": {"mistakes": 2},
    }
    ses2 = MagicMock()
    ses2.to_dict.return_value = {
        "trainee_uid": "user_real_9876",
        "skill_id": "skill_terminal_wiring_v1",
        "status": "completed",
        "started_at": "2026-10-06T11:00:00Z",
        "result": {"mistakes": 1},
    }
    ses3 = MagicMock()
    ses3.to_dict.return_value = {
        "trainee_uid": "user_real_9876",
        "skill_id": "skill_terminal_wiring_v1",
        "status": "completed",
        "started_at": "2026-10-06T12:00:00Z",
        "result": {"mistakes": 0},
    }

    def mock_collection(col_name):
        col_mock = MagicMock()
        if col_name == "skills":
            col_mock.where.return_value.stream.return_value = [skill_doc]
        elif col_name == "passports":
            col_mock.stream.return_value = [passport_doc]
        elif col_name == "sessions":
            col_mock.stream.return_value = [ses1, ses2, ses3]
        return col_mock

    mock_db.collection.side_effect = mock_collection

    def mock_get_user(uid):
        u = MagicMock()
        if uid == "user_real_9876":
            u.display_name = "Alice Smith"
            u.email = "alice@example.com"  # Must NOT leak
        else:
            u.display_name = None
            u.email = f"{uid}@example.com"
        return u

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "sup_1", "role": "supervisor"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            with patch("services.api.main.fb_auth.get_user", side_effect=mock_get_user):
                res = client.get("/api/insights/matrix", headers={"Authorization": "Bearer token"})
                assert res.status_code == 200
                data = res.json()

                # Trainees
                trainee_uids = [t["uid"] for t in data["trainees"]]
                assert "smoke-trainee" not in trainee_uids
                assert "user_real_9876" in trainee_uids
                assert "trainee_certified_1" in trainee_uids

                # First names only
                alice = next(t for t in data["trainees"] if t["uid"] == "user_real_9876")
                assert alice["first_name"] == "Alice"  # First token only

                cert_user = next(t for t in data["trainees"] if t["uid"] == "trainee_certified_1")
                assert cert_user["first_name"] == "Trainee ed_1"  # Trainee <last4> fallback

                # NEVER leak emails
                raw_json = res.text
                assert "@example.com" not in raw_json
                assert "email" not in raw_json.lower()

                # Cells verification
                alice_cell = next(
                    c for c in data["cells"]
                    if c["uid"] == "user_real_9876" and c["skill_id"] == "skill_terminal_wiring_v1"
                )
                assert alice_cell["status"] == "learning"
                assert alice_cell["sessions"] == 2
                assert alice_cell["mistakes_trend"] == [1, 0]

                cert_cell = next(
                    c for c in data["cells"]
                    if c["uid"] == "trainee_certified_1" and c["skill_id"] == "skill_terminal_wiring_v1"
                )
                assert cert_cell["status"] == "certified"


# ==========================================
# 3. GET /api/insights/skill/{skill_id}
# ==========================================


def test_insights_skill_parameterized_sql_and_step_lag_timing():
    mock_db = MagicMock()
    skill_doc = MagicMock()
    skill_doc.exists = True
    skill_doc.to_dict.return_value = {
        "title": "Wire a DIN-rail terminal block",
        "steps": [
            {"n": 1, "instruction": "Insert blue wire into terminal 1"},
            {"n": 2, "instruction": "Insert brown wire into terminal 2"},
        ],
    }
    mock_db.collection("skills").document.return_value.get.return_value = skill_doc

    mock_bq = MagicMock()

    # R1: step counts
    row_counts_1 = MagicMock()
    row_counts_1.step = 1
    row_counts_1.sessions_reached = 10
    row_counts_1.sessions_with_mistake = 4
    row_counts_1.safety_stops = 1

    row_counts_2 = MagicMock()
    row_counts_2.step = 2
    row_counts_2.sessions_reached = 8
    row_counts_2.sessions_with_mistake = 2
    row_counts_2.safety_stops = 0

    # R2: step durations from LAG
    row_dur_1 = MagicMock()
    row_dur_1.step = 1
    row_dur_1.step_secs = 25.0

    row_dur_2 = MagicMock()
    row_dur_2.step = 1
    row_dur_2.step_secs = 35.0

    row_dur_3 = MagicMock()
    row_dur_3.step = 2
    row_dur_3.step_secs = 18.0

    # R3: totals
    row_tot_1 = MagicMock()
    row_tot_1.session_id = "ses_1"
    row_tot_1.duration_s = 60.0
    row_tot_1.max_step_done = 2

    row_tot_2 = MagicMock()
    row_tot_2.session_id = "ses_2"
    row_tot_2.duration_s = 50.0
    row_tot_2.max_step_done = 2

    mock_job_1 = MagicMock()
    mock_job_1.result.return_value = [row_counts_1, row_counts_2]

    mock_job_2 = MagicMock()
    mock_job_2.result.return_value = [row_dur_1, row_dur_2, row_dur_3]

    mock_job_3 = MagicMock()
    mock_job_3.result.return_value = [row_tot_1, row_tot_2]

    mock_bq.query.side_effect = [mock_job_1, mock_job_2, mock_job_3]

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "sup_1", "role": "supervisor"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            with patch("services.api.main.get_bigquery_client", return_value=mock_bq):
                res = client.get("/api/insights/skill/skill_terminal_wiring_v1", headers={"Authorization": "Bearer token"})
                assert res.status_code == 200
                data = res.json()

                # Verify SQL calls were parameterized (job_config.query_parameters)
                assert mock_bq.query.call_count == 3
                for call in mock_bq.query.call_args_list:
                    sql_query, kwargs = call[0][0], call[1]
                    assert "@skill_id" in sql_query
                    assert "@excluded_uids" in sql_query
                    # Must NOT concatenate skill_id directly into query text
                    assert "'skill_terminal_wiring_v1'" not in sql_query
                    job_config = kwargs.get("job_config")
                    assert job_config is not None
                    param_names = [p.name for p in job_config.query_parameters]
                    assert "skill_id" in param_names
                    assert "excluded_uids" in param_names

                # Verify step 1 stats
                step1 = data["steps"][0]
                assert step1["n"] == 1
                assert step1["sessions_reached"] == 10
                assert step1["mistake_rate"] == 0.4  # 4 / 10
                assert step1["median_secs"] == 30.0  # median(25.0, 35.0)
                assert step1["safety_stops"] == 1

                # Verify totals
                assert data["totals"]["sessions"] == 2
                assert data["totals"]["completed"] == 2
                assert data["totals"]["median_duration_s"] == 55.0  # median(50.0, 60.0)


# ==========================================
# 4. GET /api/sessions/{id}/replay
# ==========================================


def test_session_replay_replaces_trainee_uid_with_first_name_and_signs_urls():
    mock_db = MagicMock()
    session_doc = MagicMock()
    session_doc.exists = True
    session_doc.to_dict.return_value = {
        "id": "ses_test_1",
        "skill_id": "skill_wiring",
        "trainee_uid": "trainee_bob_123",
        "status": "completed",
        "started_at": "2026-10-06T10:00:00Z",
    }
    mock_db.collection("sessions").document.return_value.get.return_value = session_doc

    event1 = MagicMock()
    event1.to_dict.return_value = {
        "t": "2026-10-06T10:00:10Z",
        "step": 1,
        "type": "coach_line",
        "source": "coach",
        "reason": "Welcome to the training.",
    }

    event2 = MagicMock()
    event2.to_dict.return_value = {
        "t": "2026-10-06T10:00:30Z",
        "step": 1,
        "type": "mistake",
        "source": "watcher",
        "reason": "Wire in terminal 2",
        "frame_uri": "gs://takumi-cup-2026.firebasestorage.app/sessions/ses_test_1/frames/evt_abc.jpg",
    }

    mock_db.collection("sessions").document.return_value.collection.return_value.order_by.return_value.stream.return_value = [
        event1,
        event2,
    ]

    mock_user = MagicMock()
    mock_user.display_name = "Bob Marley"
    mock_user.email = "bob@reggae.com"

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "sup_1", "role": "supervisor"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            with patch("services.api.main.fb_auth.get_user", return_value=mock_user):
                with patch(
                    "services.api.main.get_signed_url_for_gs_uri",
                    return_value="https://storage.googleapis.com/signed/evt_abc.jpg?token=mock_15m",
                ):
                    res = client.get("/api/sessions/ses_test_1/replay", headers={"Authorization": "Bearer token"})
                    assert res.status_code == 200
                    data = res.json()

                    # Privacy verification: trainee_uid replaced with first_name
                    assert data["session"]["first_name"] == "Bob"
                    assert "trainee_uid" not in data["session"]

                    # No email in response
                    raw_text = res.text
                    assert "bob@reggae.com" not in raw_text

                    # Signed frame URL replaced
                    events = data["events"]
                    assert len(events) == 2
                    assert events[1]["frame_uri"] == "https://storage.googleapis.com/signed/evt_abc.jpg?token=mock_15m"


def test_insights_matrix_stale_live_session_counts_as_learning():
    mock_db = MagicMock()

    # Published skills
    skill_doc = MagicMock()
    skill_doc.id = "skill_terminal_wiring_v1"
    skill_doc.to_dict.return_value = {"title": "Wire a DIN-rail terminal block", "status": "published"}

    # Passports (none)
    mock_db.collection("skills").where.return_value.stream.return_value = [skill_doc]
    mock_db.collection("passports").stream.return_value = []

    # Stale live session (> 12 minutes old)
    ses_stale = MagicMock()
    ses_stale.to_dict.return_value = {
        "trainee_uid": "trainee_stale_1",
        "skill_id": "skill_terminal_wiring_v1",
        "status": "live",
        "started_at": "2026-10-06T00:00:00Z",  # hours ago
    }

    mock_db.collection("sessions").stream.return_value = [ses_stale]

    def mock_collection(col_name):
        col_mock = MagicMock()
        if col_name == "skills":
            col_mock.where.return_value.stream.return_value = [skill_doc]
        elif col_name == "passports":
            col_mock.stream.return_value = []
        elif col_name == "sessions":
            col_mock.stream.return_value = [ses_stale]
        return col_mock

    mock_db.collection.side_effect = mock_collection

    mock_user = MagicMock()
    mock_user.display_name = "Charlie Chaplin"

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "sup_1", "role": "supervisor"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            with patch("services.api.main.fb_auth.get_user", return_value=mock_user):
                res = client.get("/api/insights/matrix", headers={"Authorization": "Bearer token"})
                assert res.status_code == 200
                data = res.json()
                charlie_cell = next(
                    c for c in data["cells"]
                    if c["uid"] == "trainee_stale_1" and c["skill_id"] == "skill_terminal_wiring_v1"
                )
                assert charlie_cell["status"] == "learning"
                assert charlie_cell["sessions"] == 1


def test_insights_skill_unreached_steps_and_incomplete_sessions_return_null():
    mock_db = MagicMock()
    skill_doc = MagicMock()
    skill_doc.exists = True
    skill_doc.to_dict.return_value = {
        "title": "Wire a DIN-rail terminal block",
        "steps": [
            {"n": 1, "instruction": "Step 1"},
            {"n": 2, "instruction": "Step 2"},
        ],
    }
    mock_db.collection("skills").document.return_value.get.return_value = skill_doc

    mock_bq = MagicMock()

    # R1: only step 1 reached
    row_counts_1 = MagicMock()
    row_counts_1.step = 1
    row_counts_1.sessions_reached = 2
    row_counts_1.sessions_with_mistake = 0
    row_counts_1.safety_stops = 0

    mock_job_1 = MagicMock()
    mock_job_1.result.return_value = [row_counts_1]

    # R2: no step completed timing
    mock_job_2 = MagicMock()
    mock_job_2.result.return_value = []

    # R3: sessions incomplete (max_step_done = 0)
    row_tot = MagicMock()
    row_tot.session_id = "s1"
    row_tot.duration_s = 25.0
    row_tot.max_step_done = 0

    mock_job_3 = MagicMock()
    mock_job_3.result.return_value = [row_tot]

    mock_bq.query.side_effect = [mock_job_1, mock_job_2, mock_job_3]

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "sup_1", "role": "supervisor"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            with patch("services.api.main.get_bigquery_client", return_value=mock_bq):
                res = client.get("/api/insights/skill/skill_terminal_wiring_v1", headers={"Authorization": "Bearer token"})
                assert res.status_code == 200
                data = res.json()

                # Step 1 reached but not completed -> median_secs must be None, mistake_rate 0.0
                s1 = data["steps"][0]
                assert s1["sessions_reached"] == 2
                assert s1["mistake_rate"] == 0.0
                assert s1["median_secs"] is None
                assert s1["safety_stops"] == 0

                # Step 2 never reached -> must be null
                s2 = data["steps"][1]
                assert s2["sessions_reached"] == 0
                assert s2["mistake_rate"] is None
                assert s2["median_secs"] is None
                assert s2["safety_stops"] is None

                # Totals: 0 completed -> median_duration_s must be null
                assert data["totals"]["completed"] == 0
                assert data["totals"]["median_duration_s"] is None


def test_session_replay_stale_live_session_marked_abandoned():
    mock_db = MagicMock()
    session_doc = MagicMock()
    session_doc.exists = True
    session_doc.to_dict.return_value = {
        "id": "ses_stale_live",
        "skill_id": "skill_wiring",
        "trainee_uid": "trainee_123",
        "status": "live",
        "started_at": "2026-10-06T00:00:00Z",  # hours ago (> 12m)
    }
    mock_db.collection("sessions").document.return_value.get.return_value = session_doc
    mock_db.collection("sessions").document.return_value.collection.return_value.order_by.return_value.stream.return_value = []

    mock_user = MagicMock()
    mock_user.display_name = "Dave"

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "sup_1", "role": "supervisor"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            with patch("services.api.main.fb_auth.get_user", return_value=mock_user):
                res = client.get("/api/sessions/ses_stale_live/replay", headers={"Authorization": "Bearer token"})
                assert res.status_code == 200
                data = res.json()
                assert data["session"]["status"] == "abandoned"

