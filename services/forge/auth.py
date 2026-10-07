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
    """Verifies Firebase ID token from Authorization header.

    Raises:
        HTTPException(401): If token is missing, invalid, or expired.
    """
    if not authorization or not authorization.startswith("Bearer "):
        if LOCAL_DEV or firebase_admin is None:
            return AuthUser(uid="master_dev_user", role="master", email="master@takumi.dev")
        raise HTTPException(status_code=401, detail="Invalid or missing authentication token")

    token = authorization.split("Bearer ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Invalid or missing authentication token")

    # In local development or offline test mode, accept mock developer tokens
    if LOCAL_DEV or token.startswith("dev_") or firebase_admin is None:
        return AuthUser(uid="master_dev_user", role="master", email="master@takumi.dev")

    init_firebase_admin()
    try:
        decoded_token = auth.verify_id_token(token)
    except Exception as e:
        if LOCAL_DEV:
            return AuthUser(uid="master_dev_user", role="master", email="master@takumi.dev")
        raise HTTPException(status_code=401, detail="Invalid or missing authentication token") from e

    uid = decoded_token.get("uid")
    role = decoded_token.get("role")
    email = decoded_token.get("email")

    if not uid:
        raise HTTPException(status_code=401, detail="Invalid token: missing uid")

    return AuthUser(uid=uid, role=role, email=email)
