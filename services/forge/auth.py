"""Firebase Authentication middleware for Forge service."""

from typing import NamedTuple
from fastapi import Header, HTTPException
try:
    import firebase_admin
    from firebase_admin import auth
except ImportError:
    firebase_admin = None
    auth = None
from services.forge.config import LOCAL_DEV


class AuthUser(NamedTuple):
    uid: str
    role: str | None
    email: str | None


def init_firebase_admin() -> None:
    """Initialize Firebase Admin SDK if not already initialized."""
    if firebase_admin is not None and not getattr(firebase_admin, "_apps", None):
        firebase_admin.initialize_app()


def verify_auth_token(
    authorization: str | None = Header(None),
) -> AuthUser:
    """Verifies the Firebase ID token from the Authorization header.

    The developer shortcut (no token, or a "dev_" token, becomes a local master user) exists ONLY when
    LOCAL_DEV=1. In every other environment a real Firebase ID token is required.

    Raises:
        HTTPException(401): If the token is missing, invalid, or expired.
        HTTPException(503): If Firebase Admin is not available outside local development.
    """
    if LOCAL_DEV:
        return AuthUser(uid="master_dev_user", role="master", email="master@takumi.dev")

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid or missing authentication token")

    token = authorization.split("Bearer ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Invalid or missing authentication token")

    if firebase_admin is None:
        raise HTTPException(status_code=503, detail="Authentication is unavailable")

    init_firebase_admin()
    try:
        decoded_token = auth.verify_id_token(token)
    except Exception as e:
        raise HTTPException(status_code=401, detail="Invalid or missing authentication token") from e

    uid = decoded_token.get("uid")
    role = decoded_token.get("role")
    email = decoded_token.get("email")

    if not uid:
        raise HTTPException(status_code=401, detail="Invalid token: missing uid")

    return AuthUser(uid=uid, role=role, email=email)
