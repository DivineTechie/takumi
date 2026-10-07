"""Tests for Forge Service FastAPI endpoints."""

from fastapi.testclient import TestClient
from services.forge.main import app

client = TestClient(app)


def test_healthz():
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_create_forge_job():
    res = client.post(
        "/forge/jobs",
        json={"capture_id": "cap_test_abc123"},
        headers={"Authorization": "Bearer dev_mock_token"},
    )
    assert res.status_code == 202
    data = res.json()
    assert "job_id" in data
    assert "skill_id" in data
    assert data["job_id"].startswith("job_")
    assert data["skill_id"].startswith("skill_")


def test_get_forge_job():
    res = client.get(
        "/forge/jobs/job_12345",
        headers={"Authorization": "Bearer dev_mock_token"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["job_id"] == "job_12345"


def test_regenerate_step_part():
    res = client.post(
        "/forge/steps/regenerate",
        json={"skill_id": "skill_123", "n": 1, "part": "why"},
        headers={"Authorization": "Bearer dev_mock_token"},
    )
    assert res.status_code == 200
    assert res.json()["success"] is True
