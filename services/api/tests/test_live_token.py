"""Unit tests for POST /api/live-token."""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi.testclient import TestClient
from services.api.main import app

client = TestClient(app)


def test_live_token_configuration_and_headers():
    mock_token = MagicMock()
    mock_token.name = "auth_tokens/mock_secret_token_123"

    mock_genai_client = MagicMock()
    mock_genai_client.auth_tokens.create.return_value = mock_token

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        with patch("services.api.main.check_rate_limit"):
            with patch("services.api.gemini.get_genai_client", return_value=mock_genai_client):
                t_before = datetime.now(timezone.utc)
                response = client.post(
                    "/api/live-token",
                    json={"purpose": "coach"},
                    headers={"Authorization": "Bearer dummy_token"},
                )

                assert response.status_code == 200
                data = response.json()
                assert data["token"] == "auth_tokens/mock_secret_token_123"
                assert data["model"] == "gemini-3.8-live"
                assert data["max_minutes"] == 10

                # Header check
                assert response.headers["Cache-Control"] == "no-store"

                # Verify auth_tokens.create config arguments
                mock_genai_client.auth_tokens.create.assert_called_once()
                call_kwargs = mock_genai_client.auth_tokens.create.call_args.kwargs
                config = call_kwargs["config"]

                assert config.uses == 1
                assert config.live_connect_constraints.model == "gemini-3.8-live"
                assert config.live_connect_constraints.config.response_modalities == ["AUDIO"]
                assert config.lock_additional_fields == []
                assert getattr(config.http_options, "api_version", None) == "v1beta" or config.http_options == {"api_version": "v1beta"}

                # Check expiry times
                expire_diff = (config.expire_time - t_before).total_seconds()
                new_session_diff = (config.new_session_expire_time - t_before).total_seconds()
                assert 660 <= expire_diff <= 780  # ~12 minutes
                assert 50 <= new_session_diff <= 70  # ~1 minute


def test_copilot_token_is_supervisor_only():
    mock_token = MagicMock()
    mock_token.name = "auth_tokens/mock"
    mock_genai_client = MagicMock()
    mock_genai_client.auth_tokens.create.return_value = mock_token
    with patch("services.api.main.check_rate_limit"), patch("services.api.gemini.get_genai_client", return_value=mock_genai_client):
        for role, expected in (("trainee", 403), ("master", 403), ("supervisor", 200)):
            with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "u1", "role": role}):
                r = client.post("/api/live-token", json={"purpose": "copilot"}, headers={"Authorization": "Bearer t"})
                assert r.status_code == expected, role
