"""Unit tests for POST /api/point."""

import base64
import io
import json
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from PIL import Image
from services.api.main import app

client = TestClient(app)


def _create_sample_jpeg_b64() -> str:
    img = Image.new("RGB", (100, 100), color=(50, 200, 50))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


def test_point_clamping_and_limit():
    sample_b64 = _create_sample_jpeg_b64()

    # Raw points with out-of-range values and more than 3 points
    raw_points = [
        {"point": [-100, 1500], "label": "Point 1"},
        {"point": [500, 500], "label": "Point 2"},
        {"point": [1050, -20], "label": "Point 3"},
        {"point": [300, 400], "label": "Point 4 (should be excluded)"},
    ]

    mock_resp = MagicMock()
    mock_resp.text = json.dumps({"points": raw_points})

    mock_genai_client = MagicMock()
    mock_genai_client.models.generate_content.return_value = mock_resp

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "master_1", "role": "master"}):
        with patch("services.api.main.check_rate_limit"):
            with patch("services.api.gemini.get_genai_client", return_value=mock_genai_client):
                response = client.post(
                    "/api/point",
                    json={
                        "target": "terminal 1 screw",
                        "image_b64": sample_b64,
                    },
                    headers={"Authorization": "Bearer token"},
                )

                assert response.status_code == 200
                data = response.json()
                points = data["points"]

                # Maximum 3 points
                assert len(points) == 3

                # First point clamped [-100, 1500] -> [0, 1000]
                assert points[0]["point"] == [0, 1000]
                assert points[0]["label"] == "Point 1"

                # Second point within range
                assert points[1]["point"] == [500, 500]

                # Third point clamped [1050, -20] -> [1000, 0]
                assert points[2]["point"] == [1000, 0]

                assert isinstance(data["secs"], (int, float))
