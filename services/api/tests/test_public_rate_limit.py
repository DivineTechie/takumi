"""Rate limits: the per-IP limit on public endpoints and the per-instance daily backstop on AI calls."""

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


def test_instance_cap_stops_all_users_once_reached():
    from datetime import datetime, timezone
    from unittest.mock import patch

    from services.api import auth

    now = datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)
    auth._instance_calls.clear()
    with patch.object(auth, "LIMIT_INSTANCE_CALLS_PER_DAY", 3):
        auth._check_instance_cap("20261020", 2, now)
        auth._check_instance_cap("20261020", 1, now)
        with pytest.raises(HTTPException) as exc_info:
            auth._check_instance_cap("20261020", 1, now)
        assert exc_info.value.status_code == 429
        assert int(exc_info.value.headers["Retry-After"]) == 15 * 3600
        auth._check_instance_cap("20261021", 1, now)  # a new day starts a new count
    auth._instance_calls.clear()
