from fastapi.testclient import TestClient

from services.api.main import app

client = TestClient(app)


def test_healthz():
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}

    response_api = client.get("/api/healthz")
    assert response_api.status_code == 200
    assert response_api.json() == {"status": "ok"}
