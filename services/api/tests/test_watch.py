"""Unit tests for POST /api/watch."""

import base64
import io
import json
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from PIL import Image
from services.api.main import app

client = TestClient(app)


def _create_sample_jpeg_b64(width=100, height=100) -> str:
    img = Image.new("RGB", (width, height), color=(0, 128, 255))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


def test_watch_success_and_word_truncation():
    sample_b64 = _create_sample_jpeg_b64(1000, 800)

    # Long text for reason and fix to test truncation
    long_reason = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen"
    long_fix = "a b c d e f g h i j k l m n o"

    mock_resp = MagicMock()
    mock_resp.text = json.dumps({
        "state": "in_progress",
        "reason": long_reason,
        "fix": long_fix,
    })

    mock_genai_client = MagicMock()
    mock_genai_client.models.generate_content.return_value = mock_resp

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        with patch("services.api.main.check_rate_limit"):
            with patch("services.api.gemini.get_genai_client", return_value=mock_genai_client):
                response = client.post(
                    "/api/watch",
                    json={
                        "step": 1,
                        "instruction": "Insert blue wire",
                        "success_criteria": "Blue ferrule in terminal 1",
                        "common_mistakes": [{"description": "Wrong slot", "visual_cue": "wire in slot 2"}],
                        "safety_rules": ["Power off"],
                        "image_b64": sample_b64,
                    },
                    headers={"Authorization": "Bearer token"},
                )

                assert response.status_code == 200
                data = response.json()
                assert data["state"] == "in_progress"
                # Check server-side word count truncation (reason <= 12, fix <= 10)
                assert len(data["reason"].split()) <= 12
                assert len(data["fix"].split()) <= 10
                assert isinstance(data["secs"], (int, float))

                # Verify image was resized to long side <= 640
                call_args = mock_genai_client.models.generate_content.call_args
                contents = call_args.kwargs["contents"]
                part = contents[1]
                passed_bytes = part.inline_data.data
                decoded_img = Image.open(io.BytesIO(passed_bytes))
                assert max(decoded_img.size) <= 640


def test_watch_fast_error_fallback():
    sample_b64 = _create_sample_jpeg_b64()

    mock_genai_client = MagicMock()
    mock_genai_client.models.generate_content.side_effect = TimeoutError("Model timed out")

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        with patch("services.api.main.check_rate_limit"):
            with patch("services.api.gemini.get_genai_client", return_value=mock_genai_client):
                response = client.post(
                    "/api/watch",
                    json={
                        "step": 1,
                        "instruction": "Insert blue wire",
                        "success_criteria": "Blue ferrule in terminal 1",
                        "image_b64": sample_b64,
                    },
                    headers={"Authorization": "Bearer token"},
                )

                assert response.status_code == 200
                data = response.json()
                assert data["state"] == "error"
                # Error class name only, never text that could be spoken to the trainee
                assert data["reason"] == "TimeoutError"
                assert data["fix"] == ""
                assert isinstance(data["secs"], (int, float))
