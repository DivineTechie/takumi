"""Firebase Authentication and Firestore per-user rate limiting."""

from datetime import datetime, timedelta, timezone
from typing import NamedTuple
from fastapi import Depends, Header, HTTPException
import firebase_admin
from firebase_admin import auth
from google.cloud import firestore

from services.api.config import (
    LIMIT_CHECKS_PER_DAY,
    LIMIT_GUEST_CHECKS_PER_DAY,
    LIMIT_GUEST_LIVE_TOKENS_PER_DAY,
    LIMIT_GUEST_POOL_CHECKS_PER_DAY,
    LIMIT_GUEST_POOL_LIVE_TOKENS_PER_DAY,
    LIMIT_INSTANCE_CALLS_PER_DAY,
    LIMIT_LIVE_TOKENS_PER_DAY,
)


class AuthUser(NamedTuple):
    uid: str
    role: str | None
    email: str | None
    email_verified: bool = False
    display_name: str | None = None
    guest: bool = False  # anonymous "Continue as guest" session: no email, no personal data


_firestore_client: firestore.Client | None = None


def get_firestore_client() -> firestore.Client:
    global _firestore_client
    if _firestore_client is None:
        _firestore_client = firestore.Client()
    return _firestore_client


def init_firebase_admin() -> None:
    """Initialize Firebase Admin SDK if not already initialized."""
    if not firebase_admin._apps:
        firebase_admin.initialize_app()


def verify_auth_token(
    authorization: str | None = Header(None),
) -> AuthUser:
    """Verifies Firebase ID token and role claim.

    Raises:
        HTTPException(401): If token is missing, invalid, or expired.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid or missing authentication token")

    token = authorization.split("Bearer ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Invalid or missing authentication token")

    init_firebase_admin()
    try:
        decoded_token = auth.verify_id_token(token)
    except Exception as e:
        raise HTTPException(status_code=401, detail="Invalid or missing authentication token") from e

    uid = decoded_token.get("uid")
    role = decoded_token.get("role")
    email = decoded_token.get("email")
    email_verified = bool(decoded_token.get("email_verified", False))
    display_name = decoded_token.get("name")
    guest = (decoded_token.get("firebase") or {}).get("sign_in_provider") == "anonymous"

    if not uid:
        raise HTTPException(status_code=401, detail="Invalid token: missing uid")

    return AuthUser(
        uid=uid,
        role=role,
        email=email,
        email_verified=email_verified,
        display_name=display_name,
        guest=guest,
    )


def require_role(*roles: str):
    def _role_checker(user: AuthUser = Depends(verify_auth_token)) -> AuthUser:
        if user.role not in roles:
            raise HTTPException(
                status_code=403,
                detail=f"Forbidden: role '{user.role}' is not permitted for this endpoint",
            )
        return user

    return _role_checker


# Model calls counted by this instance today, across all users: a backstop if many accounts are used at once.
_instance_calls: dict[str, int] = {}


def _check_instance_cap(day: str, cost: int, now: datetime) -> None:
    used = _instance_calls.get(day, 0)
    if used + cost > LIMIT_INSTANCE_CALLS_PER_DAY:
        midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        raise HTTPException(
            status_code=429,
            detail="TAKUMI has reached its daily limit of AI calls. Please try again tomorrow.",
            headers={"Retry-After": str(max(1, int((midnight - now).total_seconds())))},
        )
    _instance_calls.clear()
    _instance_calls[day] = used + cost


def check_rate_limit(uid: str, limit_type: str, cost: int = 1, guest: bool = False) -> None:
    """Enforces daily per-user rate limits in Firestore collection rate_limits/{uid}_{YYYYMMDD}.

    limit_type: "live_tokens" (max LIMIT_LIVE_TOKENS_PER_DAY) or "checks" (max LIMIT_CHECKS_PER_DAY).
    Guests have smaller limits and also draw on a pool shared by all guests (rate_limits/guests_{YYYYMMDD}).
    Returns fast (under 100 ms).
    Raises HTTPException(429) with Retry-After header if exceeded.
    """
    limit = LIMIT_LIVE_TOKENS_PER_DAY if limit_type == "live_tokens" else LIMIT_CHECKS_PER_DAY
    if guest:
        limit = min(limit, LIMIT_GUEST_LIVE_TOKENS_PER_DAY if limit_type == "live_tokens" else LIMIT_GUEST_CHECKS_PER_DAY)
    pool_limit = LIMIT_GUEST_POOL_LIVE_TOKENS_PER_DAY if limit_type == "live_tokens" else LIMIT_GUEST_POOL_CHECKS_PER_DAY
    now = datetime.now(timezone.utc)
    day_str = now.strftime("%Y%m%d")
    doc_id = f"{uid}_{day_str}"

    _check_instance_cap(day_str, cost, now)
    db = get_firestore_client()
    doc_ref = db.collection("rate_limits").document(doc_id)
    pool_ref = db.collection("rate_limits").document(f"guests_{day_str}") if guest else None

    # Use atomic Firestore transaction to check and increment limit
    transaction = db.transaction()

    @firestore.transactional
    def txn_rate_limit(txn: firestore.Transaction) -> tuple[bool, int, bool]:
        snapshot = doc_ref.get(transaction=txn)
        current = 0
        if snapshot.exists:
            data = snapshot.to_dict() or {}
            current = data.get(limit_type, 0)
        pool_used = 0
        if pool_ref is not None:
            pool_snap = pool_ref.get(transaction=txn)
            pool_used = (pool_snap.to_dict() or {}).get(limit_type, 0) if pool_snap.exists else 0
            if pool_used + cost > pool_limit:
                return False, current, True

        if current + cost > limit:
            return False, current, False

        txn.set(doc_ref, {limit_type: current + cost}, merge=True)
        if pool_ref is not None:
            txn.set(pool_ref, {limit_type: pool_used + cost}, merge=True)
        return True, current + cost, False

    allowed, current_val, pool_full = txn_rate_limit(transaction)

    if not allowed:
        # Calculate seconds until midnight UTC
        midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        retry_after = max(1, int((midnight - now).total_seconds()))
        detail = (
            "Guest access has reached today's shared limit. Please try again tomorrow."
            if pool_full
            else f"Daily rate limit for {limit_type} exceeded ({current_val}/{limit})"
        )
        raise HTTPException(status_code=429, detail=detail, headers={"Retry-After": str(retry_after)})

