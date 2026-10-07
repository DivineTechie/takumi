"""Unit tests for sessions, events, and session recomputation."""

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from services.api.main import app

client = TestClient(app)


def test_create_session_uid_from_token_and_status_checks():
    mock_db = MagicMock()
    mock_skill_doc = MagicMock()
    mock_skill_doc.exists = True
    mock_skill_doc.to_dict.return_value = {
        "status": "published",
        "steps": [{"n": 1}, {"n": 2}],
    }
    mock_db.collection.return_value.document.return_value.get.return_value = mock_skill_doc

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_abc", "role": "trainee"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            response = client.post(
                "/api/sessions",
                json={"skill_id": "skill_1", "language": "en"},
                headers={"Authorization": "Bearer token"},
            )

            assert response.status_code == 201
            data = response.json()
            assert data["trainee_uid"] == "trainee_abc"  # Sourced strictly from token
            assert data["status"] == "live"
            assert data["id"].startswith("ses_")
            assert len(data["steps"]) == 2
            assert data["steps"][0] == {"n": 1, "state": "pending", "attempts": 0, "mistakes": 0, "secs": 0.0}


def test_create_session_unpublished_skill_returns_404():
    mock_db = MagicMock()
    mock_skill_doc = MagicMock()
    mock_skill_doc.exists = True
    mock_skill_doc.to_dict.return_value = {"status": "draft"}
    mock_db.collection.return_value.document.return_value.get.return_value = mock_skill_doc

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_abc", "role": "trainee"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            response = client.post(
                "/api/sessions",
                json={"skill_id": "skill_draft", "language": "en"},
                headers={"Authorization": "Bearer token"},
            )
            assert response.status_code == 404
            assert "not published" in response.json()["detail"]


def test_post_event_ownership_and_status_409():
    mock_db = MagicMock()
    mock_session_doc = MagicMock()
    mock_session_doc.exists = True
    # Session owned by trainee_other, completed status
    mock_session_doc.to_dict.return_value = {
        "trainee_uid": "trainee_other",
        "status": "completed",
        "skill_id": "skill_1",
        "language": "en",
    }
    mock_db.collection.return_value.document.return_value.get.return_value = mock_session_doc

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_my", "role": "trainee"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            # Other trainee posting -> 403
            response = client.post(
                "/api/sessions/ses_123/events",
                json={"step": 1, "type": "step_done", "source": "watcher"},
                headers={"Authorization": "Bearer token"},
            )
            assert response.status_code == 403

    # Now same trainee, but session is not live -> 409
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_other", "role": "trainee"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            response = client.post(
                "/api/sessions/ses_123/events",
                json={"step": 1, "type": "step_done", "source": "watcher"},
                headers={"Authorization": "Bearer token"},
            )
            assert response.status_code == 409
            assert "status 'completed'" in response.json()["detail"]


def test_post_event_streams_to_bigquery_and_resilient_to_bq_failure():
    mock_db = MagicMock()
    mock_session_ref = MagicMock()
    mock_session_doc = MagicMock()
    mock_session_doc.exists = True
    mock_session_doc.to_dict.return_value = {
        "trainee_uid": "trainee_my",
        "status": "live",
        "skill_id": "skill_wiring",
        "language": "vi",
    }
    mock_session_ref.get.return_value = mock_session_doc
    mock_db.collection.return_value.document.return_value = mock_session_ref

    mock_bq = MagicMock()
    mock_bq.insert_rows_json.side_effect = Exception("BigQuery transient outage")

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_my", "role": "trainee"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            with patch("services.api.bigquery_client.get_bigquery_client", return_value=mock_bq):
                response = client.post(
                    "/api/sessions/ses_123/events",
                    json={
                        "step": 2,
                        "type": "step_done",
                        "source": "watcher",
                        "reason": "Brown wire connected",
                        "latency_ms": 400,
                    },
                    headers={"Authorization": "Bearer token"},
                )

                # Still returns 201 because Firestore is source of truth
                assert response.status_code == 201
                data = response.json()
                assert data["step"] == 2
                assert data["type"] == "step_done"
                assert "t" in data

                # BigQuery insert was attempted with copied fields
                mock_bq.insert_rows_json.assert_called_once()
                call_args = mock_bq.insert_rows_json.call_args
                rows = call_args[0][1]
                assert len(rows) == 1
                assert rows[0]["session_id"] == "ses_123"
                assert rows[0]["skill_id"] == "skill_wiring"
                assert rows[0]["trainee_uid"] == "trainee_my"
                assert rows[0]["language"] == "vi"
                assert rows[0]["step"] == 2


def test_patch_session_recomputes_steps_and_result():
    mock_db = MagicMock()
    mock_session_ref = MagicMock()
    mock_session_doc = MagicMock()
    mock_session_doc.exists = True
    start_time = datetime(2026, 10, 5, 14, 0, 0, tzinfo=timezone.utc)
    mock_session_doc.to_dict.return_value = {
        "id": "ses_999",
        "trainee_uid": "trainee_1",
        "status": "live",
        "started_at": start_time.isoformat(),
        "steps": [
            {"n": 1, "state": "pending", "attempts": 0, "mistakes": 0, "secs": 0.0},
            {"n": 2, "state": "pending", "attempts": 0, "mistakes": 0, "secs": 0.0},
        ],
    }
    mock_session_ref.get.return_value = mock_session_doc
    mock_db.collection.return_value.document.return_value = mock_session_ref

    # Mock events subcollection
    ev1 = MagicMock()
    ev1.to_dict.return_value = {"step": 1, "type": "mistake", "latency_ms": 200}
    ev2 = MagicMock()
    ev2.to_dict.return_value = {"step": 1, "type": "verify", "latency_ms": 800}
    ev3 = MagicMock()
    ev3.to_dict.return_value = {"step": 1, "type": "step_done", "latency_ms": 500}
    ev4 = MagicMock()
    ev4.to_dict.return_value = {"step": 2, "type": "safety_stop", "latency_ms": 100}

    mock_session_ref.collection.return_value.stream.return_value = [ev1, ev2, ev3, ev4]

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            # Client trying to send extra keys like steps or result -> 422
            bad_response = client.patch(
                "/api/sessions/ses_999",
                json={"status": "completed", "steps": []},
                headers={"Authorization": "Bearer token"},
            )
            assert bad_response.status_code == 422

            # Valid patch with ONLY status
            response = client.patch(
                "/api/sessions/ses_999",
                json={"status": "completed"},
                headers={"Authorization": "Bearer token"},
            )

            assert response.status_code == 200
            data = response.json()
            assert data["status"] == "completed"
            assert data["ended_at"] is not None

            # Check recomputed steps
            steps = data["steps"]
            # Step 1: 1 mistake, 1 verify + 1 step_done = 2 attempts, done
            assert steps[0]["n"] == 1
            assert steps[0]["state"] == "done"
            assert steps[0]["attempts"] == 2
            assert steps[0]["mistakes"] == 1
            assert steps[0]["secs"] == 1.5

            # Step 2: 0 verify, 0 step_done, 0 mistakes, not done
            assert steps[1]["n"] == 2
            assert steps[1]["state"] == "pending"

            # Check recomputed result
            result = data["result"]
            assert result["steps_done"] == 1
            assert result["mistakes"] == 1
            assert result["safety_stops"] == 1
            assert result["duration_s"] > 0


def test_create_session_initializes_current_step_to_1():
    mock_db = MagicMock()
    mock_skill_doc = MagicMock()
    mock_skill_doc.exists = True
    mock_skill_doc.to_dict.return_value = {
        "status": "published",
        "steps": [{"n": 1}, {"n": 2}],
    }
    mock_db.collection.return_value.document.return_value.get.return_value = mock_skill_doc

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_abc", "role": "trainee"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            response = client.post(
                "/api/sessions",
                json={"skill_id": "skill_1", "language": "en"},
                headers={"Authorization": "Bearer token"},
            )
            assert response.status_code == 201
            data = response.json()
            assert data["current_step"] == 1


def test_post_event_12_minute_rule_rejects_abandoned_live_sessions():
    mock_db = MagicMock()
    mock_session_doc = MagicMock()
    mock_session_doc.exists = True
    mock_session_doc.to_dict.return_value = {
        "trainee_uid": "trainee_abc",
        "status": "live",
        "started_at": "2026-10-06T00:00:00Z",
    }
    mock_db.collection.return_value.document.return_value.get.return_value = mock_session_doc

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_abc", "role": "trainee"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            response = client.post(
                "/api/sessions/ses_old/events",
                json={"step": 1, "type": "coach_line", "source": "coach", "reason": "Hi"},
                headers={"Authorization": "Bearer token"},
            )
            assert response.status_code == 409
            assert "abandoned" in response.json()["detail"].lower()


def test_post_event_reason_truncation():
    mock_db = MagicMock()
    mock_session_ref = MagicMock()
    mock_session_doc = MagicMock()
    mock_session_doc.exists = True
    mock_session_doc.to_dict.return_value = {
        "trainee_uid": "trainee_abc",
        "status": "live",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "current_step": 1,
    }
    mock_session_ref.get.return_value = mock_session_doc
    mock_db.collection.return_value.document.return_value = mock_session_ref

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_abc", "role": "trainee"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            with patch("services.api.main.stream_session_event"):
                long_line = "A" * 400
                res = client.post(
                    "/api/sessions/ses_123/events",
                    json={"step": 1, "type": "coach_line", "source": "coach", "reason": long_line},
                    headers={"Authorization": "Bearer token"},
                )
                assert res.status_code == 201
                assert len(res.json()["reason"]) == 300

                long_verify = "B" * 1200
                res2 = client.post(
                    "/api/sessions/ses_123/events",
                    json={"step": 1, "type": "verify", "source": "verify", "reason": long_verify},
                    headers={"Authorization": "Bearer token"},
                )
                assert res2.status_code == 201
                assert len(res2.json()["reason"]) == 1000


def test_post_event_image_b64_validation_and_storage_upload():
    mock_db = MagicMock()
    mock_session_ref = MagicMock()
    mock_session_doc = MagicMock()
    mock_session_doc.exists = True
    mock_session_doc.to_dict.return_value = {
        "trainee_uid": "trainee_abc",
        "status": "live",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "current_step": 1,
    }
    mock_session_ref.get.return_value = mock_session_doc
    mock_db.collection.return_value.document.return_value = mock_session_ref

    sample_b64 = (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_abc", "role": "trainee"}):
        with patch("services.api.main.get_firestore_client", return_value=mock_db):
            with patch("services.api.main.stream_session_event"):
                with patch("services.api.main.upload_frame_jpeg", return_value="gs://takumi-cup-2026.firebasestorage.app/sessions/ses_123/frames/evt1.jpg"):
                    # 1. Image on coach_line -> 422
                    res_bad_type = client.post(
                        "/api/sessions/ses_123/events",
                        json={"step": 1, "type": "coach_line", "source": "coach", "image_b64": sample_b64},
                        headers={"Authorization": "Bearer token"},
                    )
                    assert res_bad_type.status_code == 422

                    # 2. Huge image (> 300KB) -> 413
                    huge_b64 = "A" * (450 * 1024)
                    res_too_large = client.post(
                        "/api/sessions/ses_123/events",
                        json={"step": 1, "type": "mistake", "source": "watcher", "image_b64": huge_b64},
                        headers={"Authorization": "Bearer token"},
                    )
                    assert res_too_large.status_code == 413

                    # 3. Valid mistake event with image -> 201
                    res_ok = client.post(
                        "/api/sessions/ses_123/events",
                        json={"step": 1, "type": "mistake", "source": "watcher", "image_b64": sample_b64},
                        headers={"Authorization": "Bearer token"},
                    )
                    assert res_ok.status_code == 201
                    assert res_ok.json()["frame_uri"] == "gs://takumi-cup-2026.firebasestorage.app/sessions/ses_123/frames/evt1.jpg"

