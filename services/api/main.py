"""TAKUMI API service implemented with FastAPI on Python 3.12."""

import base64
from datetime import datetime, timezone
import json
import logging
import secrets
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.base import BaseHTTPMiddleware

from services.api.auth import (
    AuthUser,
    check_rate_limit,
    get_firestore_client,
    verify_auth_token,
)
from services.api.bigquery_client import stream_session_event
from services.api.config import (
    LOCAL_DEV,
    MAX_REQUEST_SIZE_BYTES,
)
from services.api.gemini import (
    call_point,
    call_verify,
    call_watch,
    create_live_token,
)
from services.api.images import decode_and_validate_image, resize_to_jpeg_bytes
from services.api.telemetry import init_telemetry, setup_logging

logger = setup_logging()
init_telemetry()

app = FastAPI(title="TAKUMI API", version="0.1.0")


# --- Middlewares ---


class RequestSizeLimitMiddleware(BaseHTTPMiddleware):
    """Rejects incoming request payloads larger than MAX_REQUEST_SIZE_BYTES (2 MB) with 413."""

    async def dispatch(self, request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > MAX_REQUEST_SIZE_BYTES:
            return JSONResponse(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                content={"detail": "Payload too large: maximum request body size is 2MB"},
            )
        return await call_next(request)


app.add_middleware(RequestSizeLimitMiddleware)

# Enable CORS only during local development (LOCAL_DEV=1)
if LOCAL_DEV:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


# --- Request & Response Schemas ---


class LiveTokenRequest(BaseModel):
    purpose: Literal["interview", "coach"]


class CommonMistakeItem(BaseModel):
    description: str
    visual_cue: str


class WatchRequest(BaseModel):
    step: int
    instruction: str
    success_criteria: str
    common_mistakes: list[CommonMistakeItem] = Field(default_factory=list)
    safety_rules: list[str] = Field(default_factory=list)
    image_b64: str


class VerifyRequest(BaseModel):
    step: int
    instruction: str
    success_criteria: str
    safety_rules: list[str] = Field(default_factory=list)
    image_b64: str


class PointRequest(BaseModel):
    target: str
    image_b64: str


class SessionCreateRequest(BaseModel):
    skill_id: str
    language: str


class SessionPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["completed", "abandoned"]


class SessionEventCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    step: int
    type: str
    source: str
    reason: str | None = None
    latency_ms: int | None = None
    frame_uri: str | None = None


# --- Role-checking dependencies ---


def require_trainee_or_supervisor(user: AuthUser = Depends(verify_auth_token)) -> AuthUser:
    if user.role not in ("trainee", "supervisor"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Forbidden: role '{user.role}' is not allowed",
        )
    return user


def require_any_authenticated_user(user: AuthUser = Depends(verify_auth_token)) -> AuthUser:
    if user.role not in ("trainee", "supervisor", "master"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Forbidden: role '{user.role}' is not allowed",
        )
    return user


# --- Routes ---


@app.get("/healthz")
@app.get("/api/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/live-token")
async def issue_live_token(
    req: LiveTokenRequest,
    response: Response,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    # Role permissions: interview -> master only, coach -> trainee or supervisor
    if req.purpose == "interview":
        if user.role != "master":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Forbidden: purpose 'interview' requires role 'master'",
            )
    elif req.purpose == "coach":
        if user.role not in ("trainee", "supervisor"):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Forbidden: purpose 'coach' requires role 'trainee' or 'supervisor'",
            )
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid purpose")

    check_rate_limit(user.uid, "live_tokens")

    token_data = await create_live_token(req.purpose)

    response.headers["Cache-Control"] = "no-store"
    return token_data


@app.post("/api/watch")
async def watch_step(
    req: WatchRequest,
    user: AuthUser = Depends(require_trainee_or_supervisor),
) -> dict[str, Any]:
    check_rate_limit(user.uid, "checks")

    # Validate image and resize to at most 640 px
    img = decode_and_validate_image(req.image_b64)
    jpeg_bytes = resize_to_jpeg_bytes(img, max_long_side=640)

    mistakes_dicts = [m.model_dump() for m in req.common_mistakes]
    return await call_watch(
        step=req.step,
        instruction=req.instruction,
        success_criteria=req.success_criteria,
        common_mistakes=mistakes_dicts,
        safety_rules=req.safety_rules,
        jpeg_bytes=jpeg_bytes,
    )


@app.post("/api/verify")
async def verify_step(
    req: VerifyRequest,
    user: AuthUser = Depends(require_trainee_or_supervisor),
) -> dict[str, Any]:
    check_rate_limit(user.uid, "checks")

    # Validate image and resize to at most 1280 px
    img = decode_and_validate_image(req.image_b64)
    jpeg_bytes = resize_to_jpeg_bytes(img, max_long_side=1280)

    return await call_verify(
        step=req.step,
        instruction=req.instruction,
        success_criteria=req.success_criteria,
        safety_rules=req.safety_rules,
        jpeg_bytes=jpeg_bytes,
    )


@app.post("/api/point")
async def point_target(
    req: PointRequest,
    user: AuthUser = Depends(require_any_authenticated_user),
) -> dict[str, Any]:
    check_rate_limit(user.uid, "checks")

    img = decode_and_validate_image(req.image_b64)
    jpeg_bytes = resize_to_jpeg_bytes(img, max_long_side=1280)

    return await call_point(
        target=req.target,
        jpeg_bytes=jpeg_bytes,
    )


@app.post("/api/sessions", status_code=status.HTTP_201_CREATED)
async def create_session(
    req: SessionCreateRequest,
    user: AuthUser = Depends(require_trainee_or_supervisor),
) -> dict[str, Any]:
    db = get_firestore_client()

    # Verify skill exists and is published
    skill_doc = db.collection("skills").document(req.skill_id).get()
    if not skill_doc.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill not found")

    skill_data = skill_doc.to_dict() or {}
    if skill_data.get("status") != "published":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Skill is not published",
        )

    session_id = f"ses_{secrets.token_hex(8)}"
    started_at = datetime.now(timezone.utc)

    # Initialize steps from published skill
    skill_steps = skill_data.get("steps", [])
    steps = [
        {
            "n": s.get("n", idx + 1),
            "state": "pending",
            "attempts": 0,
            "mistakes": 0,
            "secs": 0.0,
        }
        for idx, s in enumerate(skill_steps)
    ]

    session_data = {
        "id": session_id,
        "skill_id": req.skill_id,
        "trainee_uid": user.uid,
        "language": req.language,
        "status": "live",
        "started_at": started_at.isoformat(),
        "ended_at": None,
        "steps": steps,
        "result": None,
    }

    db.collection("sessions").document(session_id).set(session_data)
    return session_data


@app.post("/api/sessions/{session_id}/events", status_code=status.HTTP_201_CREATED)
async def create_session_event(
    session_id: str,
    req: SessionEventCreateRequest,
    user: AuthUser = Depends(require_trainee_or_supervisor),
) -> dict[str, Any]:
    db = get_firestore_client()
    session_ref = db.collection("sessions").document(session_id)
    session_doc = session_ref.get()

    if not session_doc.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    session_data = session_doc.to_dict() or {}

    # Must be the session's trainee
    if session_data.get("trainee_uid") != user.uid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: trainee does not own this session",
        )

    # Reject if session status is not "live" (409 Conflict)
    if session_data.get("status") != "live":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot post events to session with status '{session_data.get('status')}'",
        )

    event_time = datetime.now(timezone.utc)
    event_dict = {
        "t": event_time.isoformat(),
        "step": req.step,
        "type": req.type,
        "source": req.source,
        "reason": req.reason,
        "latency_ms": req.latency_ms,
        "frame_uri": req.frame_uri,
    }

    # Write to Firestore subcollection sessions/{id}/events
    session_ref.collection("events").add(event_dict)

    # Stream to BigQuery takumi.session_events
    bq_row = {
        "session_id": session_id,
        "skill_id": session_data.get("skill_id"),
        "trainee_uid": session_data.get("trainee_uid"),
        "language": session_data.get("language"),
        "step": req.step,
        "type": req.type,
        "source": req.source,
        "reason": req.reason,
        "latency_ms": req.latency_ms,
        "ts": event_time.isoformat(),
    }
    stream_session_event(bq_row)

    return event_dict


@app.patch("/api/sessions/{session_id}")
async def patch_session(
    session_id: str,
    req: SessionPatchRequest,
    user: AuthUser = Depends(require_trainee_or_supervisor),
) -> dict[str, Any]:
    db = get_firestore_client()
    session_ref = db.collection("sessions").document(session_id)
    session_doc = session_ref.get()

    if not session_doc.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    session_data = session_doc.to_dict() or {}

    # Must be the session's trainee
    if session_data.get("trainee_uid") != user.uid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: trainee does not own this session",
        )

    # Fetch all events to recompute steps[] and result
    events_docs = list(session_ref.collection("events").stream())
    events = [d.to_dict() or {} for d in events_docs]

    # Recompute steps
    original_steps = session_data.get("steps", [])
    recomputed_steps = []

    for step in original_steps:
        step_n = step.get("n", 1)
        step_events = [e for e in events if e.get("step") == step_n]

        is_done = any(e.get("type") == "step_done" for e in step_events)
        step_mistakes = sum(1 for e in step_events if e.get("type") == "mistake")
        verify_count = sum(1 for e in step_events if e.get("type") == "verify")
        step_done_count = sum(1 for e in step_events if e.get("type") == "step_done")
        attempts = verify_count + step_done_count

        total_step_secs = sum(
            float(e.get("latency_ms", 0)) / 1000.0
            for e in step_events
            if e.get("latency_ms") is not None
        )

        step_state = "done" if is_done else ("active" if (attempts > 0 or step_mistakes > 0) else "pending")

        recomputed_steps.append({
            "n": step_n,
            "state": step_state,
            "attempts": attempts,
            "mistakes": step_mistakes,
            "secs": round(total_step_secs, 2),
        })

    # Recompute overall result
    now = datetime.now(timezone.utc)
    started_at_raw = session_data.get("started_at")
    if isinstance(started_at_raw, str):
        try:
            started_at = datetime.fromisoformat(started_at_raw)
        except Exception:
            started_at = now
    elif isinstance(started_at_raw, datetime):
        started_at = started_at_raw
    else:
        started_at = now

    duration_s = max(0.0, round((now - started_at).total_seconds(), 2))
    steps_done_count = sum(1 for s in recomputed_steps if s["state"] == "done")
    total_mistakes = sum(1 for e in events if e.get("type") == "mistake")
    safety_stops = sum(1 for e in events if e.get("type") == "safety_stop")

    result = {
        "steps_done": steps_done_count,
        "mistakes": total_mistakes,
        "safety_stops": safety_stops,
        "duration_s": duration_s,
    }

    updated_fields = {
        "status": req.status,
        "ended_at": now.isoformat(),
        "steps": recomputed_steps,
        "result": result,
    }

    session_ref.update(updated_fields)

    session_data.update(updated_fields)
    return session_data
