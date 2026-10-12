"""Unit tests for authentication, role enforcement, and request validation."""

import base64
from unittest.mock import patch
from fastapi.testclient import TestClient
from services.api.main import app

client = TestClient(app)


def test_missing_auth_header_returns_401():
    response = client.post("/api/live-token", json={"purpose": "coach"})
    assert response.status_code == 401
    assert "Invalid or missing" in response.json()["detail"]


def test_invalid_bearer_token_returns_401():
    with patch("services.api.auth.auth.verify_id_token", side_effect=Exception("Invalid token")):
        response = client.post(
            "/api/live-token",
            json={"purpose": "coach"},
            headers={"Authorization": "Bearer bad_token"},
        )
        assert response.status_code == 401


def test_forbidden_role_returns_403():
    # Trainee cannot request purpose 'interview' (requires 'master')
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "user1", "role": "trainee"}):
        response = client.post(
            "/api/live-token",
            json={"purpose": "interview"},
            headers={"Authorization": "Bearer valid_token"},
        )
        assert response.status_code == 403

    # A signed-in account without a role cannot call watch
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "user2"}):
        response = client.post(
            "/api/watch",
            json={
                "step": 1,
                "instruction": "Test",
                "success_criteria": "Test",
                "image_b64": "invalid",
            },
            headers={"Authorization": "Bearer valid_token"},
        )
        assert response.status_code == 403


def test_request_size_over_2mb_returns_413():
    large_payload = "A" * (2 * 1024 * 1024 + 10)
    response = client.post(
        "/api/watch",
        content=large_payload,
        headers={"Content-Length": str(len(large_payload)), "Content-Type": "application/json"},
    )
    assert response.status_code == 413
    assert "Payload too large" in response.json()["detail"]


def test_invalid_image_encoding_returns_400():
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "user1", "role": "trainee"}):
        with patch("services.api.main.check_rate_limit"):
            response = client.post(
                "/api/watch",
                json={
                    "step": 1,
                    "instruction": "Test",
                    "success_criteria": "Test",
                    "image_b64": base64.b64encode(b"not-an-image").decode(),
                },
                headers={"Authorization": "Bearer valid_token"},
            )
            assert response.status_code == 400
            assert "does not decode as a valid image" in response.json()["detail"]
