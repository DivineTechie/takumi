"""Unit tests for GET /api/me endpoint."""

from unittest.mock import patch
from fastapi.testclient import TestClient
from services.api.main import app

client = TestClient(app)


def test_me_with_existing_role():
    """Existing role is returned directly without re-assigning claims."""
    with patch(
        "services.api.auth.auth.verify_id_token",
        return_value={
            "uid": "user_supervisor",
            "role": "supervisor",
            "email": "supervisor@example.com",
            "email_verified": True,
            "name": "Jane Supervisor",
        },
    ):
        with patch("services.api.main.fb_auth.set_custom_user_claims") as mock_set_claims:
            response = client.get("/api/me", headers={"Authorization": "Bearer valid_token"})
            assert response.status_code == 200
            data = response.json()
            assert data["uid"] == "user_supervisor"
            assert data["role"] == "supervisor"
            assert data["display_name"] == "Jane Supervisor"
            assert data["role_assigned"] is False
            mock_set_claims.assert_not_called()


def test_me_new_verified_user_assigned_trainee():
    """Verified user with no existing role gets default 'trainee' role."""
    with patch(
        "services.api.auth.auth.verify_id_token",
        return_value={
            "uid": "user_new",
            "role": None,
            "email": "trainee@example.com",
            "email_verified": True,
            "name": "Alex Trainee",
        },
    ):
        with patch("services.api.main.fb_auth.set_custom_user_claims") as mock_set_claims:
            response = client.get("/api/me", headers={"Authorization": "Bearer valid_token"})
            assert response.status_code == 200
            data = response.json()
            assert data["uid"] == "user_new"
            assert data["role"] == "trainee"
            assert data["display_name"] == "Alex Trainee"
            assert data["role_assigned"] is True
            mock_set_claims.assert_called_once_with("user_new", {"role": "trainee"})


def test_me_unverified_email_returns_403():
    """User with no role and unverified email receives 403 Forbidden."""
    with patch(
        "services.api.auth.auth.verify_id_token",
        return_value={
            "uid": "user_unverified",
            "role": None,
            "email": "unverified@example.com",
            "email_verified": False,
            "name": "Unverified User",
        },
    ):
        with patch("services.api.main.fb_auth.set_custom_user_claims") as mock_set_claims:
            response = client.get("/api/me", headers={"Authorization": "Bearer valid_token"})
            assert response.status_code == 403
            assert response.json()["detail"] == "Email not verified"
            mock_set_claims.assert_not_called()
