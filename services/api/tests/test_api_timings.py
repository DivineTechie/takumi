"""Integration tests for api_calls timing metrics across success and 503 paths."""

import base64
import io
import json
import time
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from services.api.main import app

client = TestClient(app)


@pytest.fixture(autouse=True, scope="module")
def _warmup_threads():
    import asyncio
    asyncio.run(asyncio.to_thread(time.sleep, 0.05))


def _sample_image_b64() -> str:
    img = Image.new("RGB", (100, 100), color=(10, 20, 30))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


@pytest.mark.parametrize("endpoint,url,payload,expected_status,is_503", [
    (
        "live-token",
        "/api/live-token",
        {"purpose": "coach"},
        200,
        False,
    ),
    (
        "live-token",
        "/api/live-token",
        {"purpose": "coach"},
        503,
        True,
    ),
    (
        "watch",
        "/api/watch",
        {
            "step": 1,
            "instruction": "Insert blue wire",
            "success_criteria": "Blue ferrule in terminal 1",
            "common_mistakes": [],
            "safety_rules": [],
            "image_b64": _sample_image_b64(),
        },
        200,
        False,
    ),
    (
        "watch",
        "/api/watch",
        {
            "step": 1,
            "instruction": "Insert blue wire",
            "success_criteria": "Blue ferrule in terminal 1",
            "common_mistakes": [],
            "safety_rules": [],
            "image_b64": _sample_image_b64(),
        },
        503,
        True,
    ),
    (
        "verify",
        "/api/verify",
        {
            "step": 1,
            "instruction": "Insert blue wire",
            "success_criteria": "Blue ferrule in terminal 1",
            "safety_rules": [],
            "image_b64": _sample_image_b64(),
        },
        200,
        False,
    ),
    (
        "verify",
        "/api/verify",
        {
            "step": 1,
            "instruction": "Insert blue wire",
            "success_criteria": "Blue ferrule in terminal 1",
            "safety_rules": [],
            "image_b64": _sample_image_b64(),
        },
        503,
        True,
    ),
    (
        "point",
        "/api/point",
        {
            "target": "terminal 1",
            "image_b64": _sample_image_b64(),
        },
        200,
        False,
    ),
    (
        "point",
        "/api/point",
        {
            "target": "terminal 1",
            "image_b64": _sample_image_b64(),
        },
        503,
        True,
    ),
])
def test_api_timings_sleep_800ms_success_and_503(endpoint, url, payload, expected_status, is_503):
    mock_genai_client = MagicMock()

    if endpoint == "live-token":
        if is_503:
            def _live_fail(*args, **kwargs):
                time.sleep(0.8)
                raise Exception("402 PAYMENT_REQUIRED: prepayment credits are depleted")
            mock_genai_client.auth_tokens.create.side_effect = _live_fail
        else:
            def _live_ok(*args, **kwargs):
                time.sleep(0.8)
                tok = MagicMock()
                tok.name = "auth_tokens/mock_live_token"
                return tok
            mock_genai_client.auth_tokens.create.side_effect = _live_ok
    else:
        if is_503:
            def _model_fail(*args, **kwargs):
                time.sleep(0.8)
                raise Exception("402 PAYMENT_REQUIRED: prepayment credits are depleted")
            mock_genai_client.models.generate_content.side_effect = _model_fail
        else:
            def _model_ok(*args, **kwargs):
                time.sleep(0.8)
                resp = MagicMock()
                if endpoint == "watch":
                    resp.text = json.dumps({"state": "in_progress", "reason": "ok", "fix": ""})
                elif endpoint == "verify":
                    resp.text = json.dumps({"passed": True, "visible": True, "reason": "ok", "fix": ""})
                elif endpoint == "point":
                    resp.text = json.dumps({"points": [[150, 250]]})
                return resp
            mock_genai_client.models.generate_content.side_effect = _model_ok

    captured_rows = []

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "test_trainee", "role": "trainee"}):
        with patch("services.api.main.check_rate_limit"):
            with patch("services.api.gemini.get_genai_client", return_value=mock_genai_client):
                with patch("services.api.main.stream_api_call", side_effect=captured_rows.append):
                    resp = client.post(
                        url,
                        json=payload,
                        headers={"Authorization": "Bearer fake_token"},
                    )

                    assert resp.status_code == expected_status
                    if is_503:
                        assert "Coaching is temporarily unavailable." in resp.json()["detail"]

                    assert len(captured_rows) == 1
                    row = captured_rows[0]
                    assert row["endpoint"] == endpoint
                    assert row["status"] == expected_status
                    assert 750 <= row["model_ms"] <= 1000, f"model_ms {row['model_ms']} not in [750, 1000]"
                    assert row["total_ms"] >= row["model_ms"], f"total_ms {row['total_ms']} < model_ms {row['model_ms']}"
