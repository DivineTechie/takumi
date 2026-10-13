import json
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi.testclient import TestClient

from services.api.main import app


def test_kill_switch_sessions_disabled():
    from services.api.auth import AuthUser, verify_auth_token
    from services.api.main import require_station_user

    mock_user = AuthUser(uid="trainee_1", role="trainee", email="t@example.com", email_verified=True, display_name="Trainee")
    app.dependency_overrides[verify_auth_token] = lambda: mock_user
    app.dependency_overrides[require_station_user] = lambda: mock_user
    client = TestClient(app)

    try:
        with patch("services.api.main.SESSIONS_ENABLED", False), \
             patch("services.api.main.check_rate_limit"):

            # 1. POST /api/live-token for purpose 'coach' returns 503
            resp_token = client.post(
                "/api/live-token",
                headers={"Authorization": "Bearer fake_token"},
                json={"purpose": "coach"},
            )
            assert resp_token.status_code == 503
            assert resp_token.json()["detail"] == "Coaching is paused for maintenance."

            # 2. POST /api/sessions returns 503
            resp_session = client.post(
                "/api/sessions",
                headers={"Authorization": "Bearer fake_token"},
                json={"skill_id": "skill_1", "language": "en"},
            )
            assert resp_session.status_code == 503
            assert resp_session.json()["detail"] == "Coaching is paused for maintenance."
    finally:
        app.dependency_overrides.pop(verify_auth_token, None)
        app.dependency_overrides.pop(require_station_user, None)


def test_api_status_public_and_returns_metrics():
    client = TestClient(app)

    mock_bq = MagicMock()
    # Mock sessions count query
    mock_job_sessions = MagicMock()
    mock_job_sessions.result.return_value = [{"session_count": 8}]

    # Mock decision_to_audio query
    mock_job_d2a = MagicMock()
    mock_job_d2a.result.return_value = [{"p50": 420, "p90": 650}]

    # Mock api_calls query
    mock_job_apis = MagicMock()
    mock_job_apis.result.return_value = [
        {"endpoint": "watch", "p50": 380, "p90": 510},
        {"endpoint": "verify", "p50": 620, "p90": 890},
        {"endpoint": "point", "p50": 410, "p90": 590},
    ]

    mock_bq.query.side_effect = [mock_job_sessions, mock_job_d2a, mock_job_apis]

    with patch("services.api.main.get_bigquery_client", return_value=mock_bq), \
         patch("services.api.main.check_deep_health", new=AsyncMock(return_value=True)), \
         patch.dict("services.api.main._STATUS_CACHE", {"data": None, "cached_at": 0.0}):
        resp = client.get("/api/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["api"] == "ok"
        assert data["gemini"] == "ok"
        assert data["window_days"] == 7
        assert "sessions_enabled" in data
        last_24h = data["recent"]
        assert last_24h["sessions"] == 8
        assert last_24h["p50_ms"]["watch"] == 380
        assert last_24h["p50_ms"]["verify"] == 620
        assert last_24h["p50_ms"]["point"] == 410
        assert last_24h["p50_ms"]["decision_to_audio"] == 420
        assert last_24h["p90_ms"]["watch"] == 510


def test_csp_report_returns_204_and_logs(caplog):
    from services.api.telemetry import StructuredJsonFormatter

    client = TestClient(app)
    csp_payload = {
        "csp-report": {
            "document-uri": "https://takumi-cup-2026.web.app/",
            "referrer": "",
            "violated-directive": "style-src",
            "effective-directive": "style-src",
            "original-policy": "default-src 'self' ...",
            "disposition": "report",
            "blocked-uri": "http://evil.com/style.css",
            "status-code": 200
        }
    }

    with caplog.at_level("WARNING"):
        resp = client.post("/api/csp-report", json=csp_payload)
    assert resp.status_code == 204

    record = next(r for r in caplog.records if r.getMessage() == "CSP violation reported")
    entry = json.loads(StructuredJsonFormatter().format(record))
    assert entry["event"] == "csp_violation"
    assert entry["effective_directive"] == "style-src"
    assert entry["blocked_uri"] == "http://evil.com/style.css"


def test_api_calls_timing_measurement_with_delay():
    import asyncio
    import base64
    import io
    from PIL import Image

    img = Image.new("RGB", (100, 100), color=(0, 128, 255))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    sample_b64 = base64.b64encode(buf.getvalue()).decode()

    async def fake_call_watch(*args, **kwargs):
        await asyncio.sleep(1.234)
        return {"state": "in_progress", "reason": "ok", "fix": "", "rule": None, "secs": 1.23}

    recorded_rows = []

    client = TestClient(app)
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.check_rate_limit"), \
         patch("services.api.main.call_watch", side_effect=fake_call_watch), \
         patch("services.api.main.stream_api_call", side_effect=lambda row: recorded_rows.append(row)):

        response = client.post(
            "/api/watch",
            headers={"Authorization": "Bearer fake_token"},
            json={
                "step": 1,
                "instruction": "Insert wire",
                "success_criteria": "Wire in slot",
                "common_mistakes": [],
                "safety_rules": [],
                "image_b64": sample_b64,
            },
        )
        assert response.status_code == 200
        assert len(recorded_rows) == 1
        row = recorded_rows[0]
        assert row["endpoint"] == "watch"
        assert row["status"] == 200
        assert 1200 <= row["total_ms"] <= 1300, f"Expected total_ms in [1200, 1300], got {row['total_ms']}"
        assert 1200 <= row["model_ms"] <= 1300, f"Expected model_ms in [1200, 1300], got {row['model_ms']}"



def test_api_status_reports_gemini_unavailable():
    from fastapi import HTTPException

    mock_bq = MagicMock()
    mock_bq.query.return_value.result.return_value = []
    with patch("services.api.main.get_bigquery_client", return_value=mock_bq), \
         patch("services.api.main.check_deep_health", new=AsyncMock(side_effect=HTTPException(status_code=503))), \
         patch.dict("services.api.main._STATUS_CACHE", {"data": None, "cached_at": 0.0}):
        data = TestClient(app).get("/api/status").json()
    assert data["api"] == "ok"
    assert data["gemini"] == "unavailable"
