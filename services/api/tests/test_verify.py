"""Unit tests for POST /api/verify."""

import base64
import io
import json
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from PIL import Image
from services.api.main import app

client = TestClient(app)


def _create_sample_jpeg_b64(width=1600, height=1200) -> str:
    img = Image.new("RGB", (width, height), color=(255, 100, 50))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


def test_verify_success_and_resizing():
    sample_b64 = _create_sample_jpeg_b64()

    mock_resp = MagicMock()
    mock_resp.text = json.dumps({
        "passed": True,
        "visible": True,
        "reason": "Ferrule is correctly inserted.",
        "fix": "",
    })

    mock_genai_client = MagicMock()
    mock_genai_client.models.generate_content.return_value = mock_resp

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        with patch("services.api.main.check_rate_limit"):
            with patch("services.api.gemini.get_genai_client", return_value=mock_genai_client):
                response = client.post(
                    "/api/verify",
                    json={
                        "step": 1,
                        "instruction": "Insert blue wire",
                        "success_criteria": "Blue ferrule in terminal 1",
                        "safety_rules": ["Power off"],
                        "image_b64": sample_b64,
                    },
                    headers={"Authorization": "Bearer token"},
                )

                assert response.status_code == 200
                data = response.json()
                assert data["passed"] is True
                assert data["visible"] is True
                assert data["reason"] == "Ferrule is correctly inserted."
                assert data["fix"] == ""
                assert isinstance(data["secs"], (int, float))

                # Verify image was resized to long side <= 1280
                call_args = mock_genai_client.models.generate_content.call_args
                contents = call_args.kwargs["contents"]
                part = contents[1]
                passed_bytes = part.inline_data.data
                decoded_img = Image.open(io.BytesIO(passed_bytes))
                assert max(decoded_img.size) <= 1280


def test_verify_retry_on_failure():
    sample_b64 = _create_sample_jpeg_b64(100, 100)

    mock_resp = MagicMock()
    mock_resp.text = json.dumps({
        "passed": False,
        "visible": True,
        "reason": "Wire not inserted.",
        "fix": "Push wire into slot.",
    })

    mock_genai_client = MagicMock()
    # First call raises an error, second succeeds
    mock_genai_client.models.generate_content.side_effect = [
        Exception("Temporary 503 error"),
        mock_resp,
    ]

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        with patch("services.api.main.check_rate_limit"):
            with patch("services.api.gemini.get_genai_client", return_value=mock_genai_client):
                with patch("asyncio.sleep"):
                    response = client.post(
                        "/api/verify",
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
                    assert data["passed"] is False
                    assert mock_genai_client.models.generate_content.call_count == 2


def test_verify_timeout_handling():
    sample_b64 = _create_sample_jpeg_b64(100, 100)

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        with patch("services.api.main.check_rate_limit"):
            with patch("services.api.gemini.get_genai_client"):
                with patch("services.api.gemini.asyncio.wait_for", side_effect=TimeoutError()):
                    response = client.post(
                        "/api/verify",
                        json={
                            "step": 1,
                            "instruction": "Insert black wire",
                            "success_criteria": "Black ferrule in terminal 1",
                            "image_b64": sample_b64,
                        },
                        headers={"Authorization": "Bearer token"},
                    )

                    assert response.status_code == 200
                    data = response.json()
                    assert data["passed"] is False
                    assert data["visible"] is True
                    assert "hold steady" in data["reason"].lower()
                    assert "hold steady" in data["fix"].lower()


def test_verify_gemini_unavailable_503():
    sample_b64 = _create_sample_jpeg_b64(100, 100)

    mock_genai_client = MagicMock()
    mock_genai_client.models.generate_content.side_effect = Exception("402 PAYMENT_REQUIRED: Your prepayment credits are depleted.")

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        with patch("services.api.main.check_rate_limit"):
            with patch("services.api.gemini.get_genai_client", return_value=mock_genai_client):
                response = client.post(
                    "/api/verify",
                    json={
                        "step": 1,
                        "instruction": "Insert blue wire",
                        "success_criteria": "Blue ferrule in terminal 1",
                        "image_b64": sample_b64,
                    },
                    headers={"Authorization": "Bearer token"},
                )

                assert response.status_code == 503
                data = response.json()
                assert "Coaching is temporarily unavailable." in data["detail"]

