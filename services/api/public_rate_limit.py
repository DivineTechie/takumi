"""Per-IP rate limit for public (signed-out) endpoints such as the status page."""

import time

from fastapi import HTTPException, Request, status

_public_rate_limits: dict[str, list[float]] = {}


def check_public_rate_limit(request: Request, limit: int = 60, window_s: int = 60) -> None:
    """Allows `limit` requests per `window_s` seconds per client, keyed on the FIRST address in
    X-Forwarded-For (falling back to the client host)."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        client_ip = xff.split(",")[0].strip()
    elif request.client and request.client.host:
        client_ip = request.client.host
    else:
        client_ip = "127.0.0.1"

    now = time.time()
    active = [t for t in _public_rate_limits.get(client_ip, []) if t > now - window_s]
    if len(active) >= limit:
        _public_rate_limits[client_ip] = active
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Rate limit exceeded. Maximum {limit} requests per {window_s} s.",
            headers={"Retry-After": str(window_s)},
        )
    active.append(now)
    _public_rate_limits[client_ip] = active
