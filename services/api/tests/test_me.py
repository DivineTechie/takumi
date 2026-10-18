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


def _token(email, verified=True, role="trainee", uid="user_demo"):
    return {"uid": uid, "role": role, "email": email, "email_verified": verified, "name": "Demo"}


def test_personal_account_can_pick_a_demo_role():
    with patch("services.api.auth.auth.verify_id_token", return_value=_token("judge@example.com")):
        assert client.get("/api/me", headers={"Authorization": "Bearer t"}).json()["can_pick_role"] is True
        with patch("services.api.main.fb_auth.set_custom_user_claims") as mock_set_claims:
            res = client.post("/api/me/role", json={"role": "supervisor"}, headers={"Authorization": "Bearer t"})
    assert res.status_code == 200
    assert res.json() == {"role": "supervisor"}
    mock_set_claims.assert_called_once_with("user_demo", {"role": "supervisor"})


def test_shared_judge_accounts_and_unverified_emails_keep_their_role():
    for token in (_token("judge-supervisor@takumi-cup-2026.web.app", role="supervisor"), _token("new@example.com", verified=False)):
        with patch("services.api.auth.auth.verify_id_token", return_value=token):
            with patch("services.api.main.fb_auth.set_custom_user_claims") as mock_set_claims:
                res = client.post("/api/me/role", json={"role": "master"}, headers={"Authorization": "Bearer t"})
        assert res.status_code == 403
        mock_set_claims.assert_not_called()
    with patch("services.api.auth.auth.verify_id_token", return_value=_token("judge-master@takumi-cup-2026.web.app", role="master")):
        assert client.get("/api/me", headers={"Authorization": "Bearer t"}).json()["can_pick_role"] is False


def test_unknown_role_is_rejected_and_switches_are_limited():
    with patch("services.api.auth.auth.verify_id_token", return_value=_token("a@example.com", uid="user_limit")):
        with patch("services.api.main.fb_auth.set_custom_user_claims"):
            assert client.post("/api/me/role", json={"role": "admin"}, headers={"Authorization": "Bearer t"}).status_code == 422
            with patch("services.api.main.DEMO_ROLE_SWITCHES_PER_DAY", 2):
                codes = [client.post("/api/me/role", json={"role": "master"}, headers={"Authorization": "Bearer t"}).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


def test_guest_starts_as_supervisor_and_can_pick_roles():
    token = {"uid": "guest_1", "role": None, "email": None, "email_verified": False, "firebase": {"sign_in_provider": "anonymous"}}
    with patch("services.api.auth.auth.verify_id_token", return_value=token):
        with patch("services.api.main.fb_auth.set_custom_user_claims") as mock_set_claims:
            data = client.get("/api/me", headers={"Authorization": "Bearer t"}).json()
    assert data["role"] == "supervisor" and data["role_assigned"] is True and data["can_pick_role"] is True
    mock_set_claims.assert_called_once_with("guest_1", {"role": "supervisor"})
    with patch("services.api.auth.auth.verify_id_token", return_value=dict(token, role="supervisor")):
        with patch("services.api.main.fb_auth.set_custom_user_claims"):
            assert client.post("/api/me/role", json={"role": "master"}, headers={"Authorization": "Bearer t"}).status_code == 200
