"""Unit tests for /api/healthz/deep."""

import time
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient

from services.api.main import app

client = TestClient(app)


def test_healthz_deep_success_and_caching():
    mock_genai_client = MagicMock()
    mock_resp = MagicMock()
    mock_resp.text = "pong"
    mock_genai_client.models.generate_content.return_value = mock_resp

    with patch("services.api.gemini.get_genai_client", return_value=mock_genai_client):
        # Reset cache timestamp for test
        import services.api.gemini as gemini_mod
        gemini_mod._deep_health_cache_ts = 0.0

        # First call: performs gemini check
        res1 = client.get("/api/healthz/deep")
        assert res1.status_code == 200
        assert res1.json() == {"status": "ok"}
        assert mock_genai_client.models.generate_content.call_count == 1

        # Second call: within 10 min, must use cache without calling gemini again
        res2 = client.get("/api/healthz/deep")
        assert res2.status_code == 200
        assert res2.json() == {"status": "ok"}
        assert mock_genai_client.models.generate_content.call_count == 1


def test_healthz_deep_failure_503():
    mock_genai_client = MagicMock()
    mock_genai_client.models.generate_content.side_effect = Exception("RESOURCE_EXHAUSTED: credits depleted")

    with patch("services.api.gemini.get_genai_client", return_value=mock_genai_client):
        import services.api.gemini as gemini_mod
        gemini_mod._deep_health_cache_ts = 0.0

        res = client.get("/api/healthz/deep")
        assert res.status_code == 503
        assert "Coaching is temporarily unavailable." in res.json()["detail"]
