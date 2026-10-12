"""Public endpoint rate limit keyed on the first X-Forwarded-For address."""

from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from services.api.public_rate_limit import _public_rate_limits, check_public_rate_limit


def _request(xff: str) -> MagicMock:
    req = MagicMock()
    req.headers = {"x-forwarded-for": xff}
    req.client.host = "10.0.0.1"
    return req


def test_public_rate_limit_first_address_in_xff():
    _public_rate_limits.clear()
    req1 = _request("203.0.113.195, 70.41.3.18, 150.172.238.178")
    for _ in range(60):
        check_public_rate_limit(req1, limit=60, window_s=60)
    with pytest.raises(HTTPException) as exc_info:
        check_public_rate_limit(req1, limit=60, window_s=60)
    assert exc_info.value.status_code == 429
    assert "60 requests per 60 s" in exc_info.value.detail

    # A different first address has its own budget
    check_public_rate_limit(_request("198.51.100.42, 70.41.3.18"), limit=60, window_s=60)
