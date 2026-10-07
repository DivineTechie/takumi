"""TAKUMI API service implemented with FastAPI on Python 3.12."""

import base64
from datetime import datetime, timedelta, timezone
import json
import logging
import secrets
import statistics
import time
from typing import Any, Literal

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google.cloud import bigquery, firestore
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.base import BaseHTTPMiddleware
from firebase_admin import auth as fb_auth

from services.api.badges import get_badge_signed_url_if_exists
from services.api.passports import (
    check_public_rate_limit,
    issue_passport_if_eligible,
    validate_trainee_name,
)

from services.api.auth import (
    AuthUser,
    check_rate_limit,
    get_firestore_client,
    init_firebase_admin,
    verify_auth_token,
)
from services.api.bigquery_client import (
    get_bigquery_client,
    stream_api_call,
    stream_session_event,
)
from services.api.config import (
    EXCLUDED_UIDS,
    GCP_PROJECT,
    LOCAL_DEV,
    MAX_REQUEST_SIZE_BYTES,
    SESSIONS_ENABLED,
    STORAGE_BUCKET,
    VERIFY_MAX_PX,
)
from services.api.model_armor import screen_text
from services.api.storage_client import get_signed_url_for_gs_uri, upload_frame_jpeg
from services.api.gemini import (
    call_point,
    call_verify,
    call_watch,
    check_deep_health,
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


class MeResponse(BaseModel):
    uid: str
    role: str
    display_name: str | None = None
    role_assigned: bool = False


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
    image_b64: str | None = None


# --- Role-checking dependencies & Helpers ---


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


def require_supervisor(user: AuthUser = Depends(verify_auth_token)) -> AuthUser:
    if user.role != "supervisor":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Forbidden: role '{user.role}' is not allowed for supervisor insights",
        )
    return user


# In-memory cache for supervisor insight endpoints (TTL: 60s)
_insights_cache: dict[str, tuple[float, Any]] = {}


def get_from_cache(key: str) -> Any | None:
    if key in _insights_cache:
        cached_ts, val = _insights_cache[key]
        if time.time() - cached_ts < 60.0:
            return val
    return None


def set_in_cache(key: str, val: Any) -> None:
    _insights_cache[key] = (time.time(), val)


def clear_insights_cache() -> None:
    _insights_cache.clear()


def get_trainee_first_name(uid: str | None) -> str:
    """Returns a trainee's first name only. Never exposes or logs email addresses."""
    if not uid:
        return "Trainee"
    init_firebase_admin()
    try:
        user_record = fb_auth.get_user(uid)
        dname = user_record.display_name
        if dname and dname.strip():
            candidate = dname.strip().split()[0]
            if validate_trainee_name(candidate):
                return candidate
    except Exception:
        pass
    last4 = uid[-4:] if len(uid) >= 4 else uid
    return f"Trainee {last4}"


# --- Routes ---


@app.get("/healthz")
@app.get("/api/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/healthz/deep")
@app.get("/api/healthz/deep")
async def healthz_deep(request: Request) -> dict[str, str]:
    check_public_rate_limit(request, limit=60, window_s=60)
    await check_deep_health()
    return {"status": "ok"}


@app.get("/api/me", response_model=MeResponse)
def get_me(user: AuthUser = Depends(verify_auth_token)) -> MeResponse:
    if user.role is not None:
        return MeResponse(
            uid=user.uid,
            role=user.role,
            display_name=user.display_name,
            role_assigned=False,
        )

    # User has no role claim yet: check if email is verified
    if not user.email_verified:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Email not verified",
        )

    # Assign default "trainee" role
    fb_auth.set_custom_user_claims(user.uid, {"role": "trainee"})
    return MeResponse(
        uid=user.uid,
        role="trainee",
        display_name=user.display_name,
        role_assigned=True,
    )


@app.post("/api/live-token")
async def issue_live_token(
    req: LiveTokenRequest,
    response: Response,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    t_handler_start = time.perf_counter()
    # Role permissions: interview -> master only, coach -> trainee or supervisor
    if req.purpose == "interview":
        if user.role != "master":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Forbidden: purpose 'interview' requires role 'master'",
            )
    elif req.purpose == "coach":
        if not SESSIONS_ENABLED:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Coaching is paused for maintenance.",
            )
        if user.role not in ("trainee", "supervisor"):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Forbidden: purpose 'coach' requires role 'trainee' or 'supervisor'",
            )
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid purpose")

    check_rate_limit(user.uid, "live_tokens")

    t_model_start = time.perf_counter()
    try:
        token_data = await create_live_token(req.purpose)
        model_ms = int(round((time.perf_counter() - t_model_start) * 1000))
        total_ms = int(round((time.perf_counter() - t_handler_start) * 1000))

        stream_api_call({
            "ts": datetime.now(timezone.utc).isoformat(),
            "endpoint": "live-token",
            "status": 200,
            "model_ms": model_ms,
            "total_ms": total_ms,
        })

        response.headers["Cache-Control"] = "no-store"
        return token_data
    except HTTPException as e:
        model_ms = int(round((time.perf_counter() - t_model_start) * 1000))
        total_ms = int(round((time.perf_counter() - t_handler_start) * 1000))
        stream_api_call({
            "ts": datetime.now(timezone.utc).isoformat(),
            "endpoint": "live-token",
            "status": e.status_code,
            "model_ms": model_ms,
            "total_ms": total_ms,
        })
        raise
    except Exception:
        model_ms = int(round((time.perf_counter() - t_model_start) * 1000))
        total_ms = int(round((time.perf_counter() - t_handler_start) * 1000))
        stream_api_call({
            "ts": datetime.now(timezone.utc).isoformat(),
            "endpoint": "live-token",
            "status": 500,
            "model_ms": model_ms,
            "total_ms": total_ms,
        })
        raise


@app.post("/api/watch")
async def watch_step(
    req: WatchRequest,
    user: AuthUser = Depends(require_trainee_or_supervisor),
) -> dict[str, Any]:
    t_handler_start = time.perf_counter()
    check_rate_limit(user.uid, "checks")

    # Validate image and resize to at most 640 px
    img = decode_and_validate_image(req.image_b64)
    jpeg_bytes = resize_to_jpeg_bytes(img, max_long_side=640)

    mistakes_dicts = [m.model_dump() for m in req.common_mistakes]
    t_model_start = time.perf_counter()
    res = await call_watch(
        step=req.step,
        instruction=req.instruction,
        success_criteria=req.success_criteria,
        common_mistakes=mistakes_dicts,
        safety_rules=req.safety_rules,
        jpeg_bytes=jpeg_bytes,
    )
    model_ms = int(round((time.perf_counter() - t_model_start) * 1000))
    total_ms = int(round((time.perf_counter() - t_handler_start) * 1000))

    stream_api_call({
        "ts": datetime.now(timezone.utc).isoformat(),
        "endpoint": "watch",
        "status": 200,
        "model_ms": model_ms,
        "total_ms": total_ms,
    })
    return res


@app.post("/api/verify")
async def verify_step(
    req: VerifyRequest,
    user: AuthUser = Depends(require_trainee_or_supervisor),
) -> dict[str, Any]:
    t_handler_start = time.perf_counter()
    check_rate_limit(user.uid, "checks")

    # Validate image and resize to at most VERIFY_MAX_PX (default 1280)
    img = decode_and_validate_image(req.image_b64)
    jpeg_bytes = resize_to_jpeg_bytes(img, max_long_side=VERIFY_MAX_PX)

    t_model_start = time.perf_counter()
    try:
        res = await call_verify(
            step=req.step,
            instruction=req.instruction,
            success_criteria=req.success_criteria,
            safety_rules=req.safety_rules,
            jpeg_bytes=jpeg_bytes,
        )
        model_ms = int(round((time.perf_counter() - t_model_start) * 1000))
        total_ms = int(round((time.perf_counter() - t_handler_start) * 1000))

        stream_api_call({
            "ts": datetime.now(timezone.utc).isoformat(),
            "endpoint": "verify",
            "status": 200,
            "model_ms": model_ms,
            "total_ms": total_ms,
        })
        return res
    except HTTPException as e:
        model_ms = int(round((time.perf_counter() - t_model_start) * 1000))
        total_ms = int(round((time.perf_counter() - t_handler_start) * 1000))
        stream_api_call({
            "ts": datetime.now(timezone.utc).isoformat(),
            "endpoint": "verify",
            "status": e.status_code,
            "model_ms": model_ms,
            "total_ms": total_ms,
        })
        raise
    except Exception:
        model_ms = int(round((time.perf_counter() - t_model_start) * 1000))
        total_ms = int(round((time.perf_counter() - t_handler_start) * 1000))
        stream_api_call({
            "ts": datetime.now(timezone.utc).isoformat(),
            "endpoint": "verify",
            "status": 500,
            "model_ms": model_ms,
            "total_ms": total_ms,
        })
        raise


@app.post("/api/point")
async def point_target(
    req: PointRequest,
    user: AuthUser = Depends(require_any_authenticated_user),
) -> dict[str, Any]:
    t_handler_start = time.perf_counter()
    check_rate_limit(user.uid, "checks")

    # Screen target text with Model Armor (fail-open)
    screening = screen_text(req.target, purpose="point_target")
    if not screening.get("allowed", True):
        total_ms = int(round((time.perf_counter() - t_handler_start) * 1000))
        stream_api_call({
            "ts": datetime.now(timezone.utc).isoformat(),
            "endpoint": "point",
            "status": 200,
            "model_ms": None,
            "total_ms": total_ms,
        })
        return {"points": [], "secs": 0.0, "blocked": True}

    img = decode_and_validate_image(req.image_b64)
    jpeg_bytes = resize_to_jpeg_bytes(img, max_long_side=1280)

    t_model_start = time.perf_counter()
    try:
        res = await call_point(
            target=req.target,
            jpeg_bytes=jpeg_bytes,
        )
        model_ms = int(round((time.perf_counter() - t_model_start) * 1000))
        total_ms = int(round((time.perf_counter() - t_handler_start) * 1000))

        stream_api_call({
            "ts": datetime.now(timezone.utc).isoformat(),
            "endpoint": "point",
            "status": 200,
            "model_ms": model_ms,
            "total_ms": total_ms,
        })
        return res
    except HTTPException as e:
        model_ms = int(round((time.perf_counter() - t_model_start) * 1000))
        total_ms = int(round((time.perf_counter() - t_handler_start) * 1000))
        stream_api_call({
            "ts": datetime.now(timezone.utc).isoformat(),
            "endpoint": "point",
            "status": e.status_code,
            "model_ms": model_ms,
            "total_ms": total_ms,
        })
        raise
    except Exception:
        model_ms = int(round((time.perf_counter() - t_model_start) * 1000))
        total_ms = int(round((time.perf_counter() - t_handler_start) * 1000))
        stream_api_call({
            "ts": datetime.now(timezone.utc).isoformat(),
            "endpoint": "point",
            "status": 500,
            "model_ms": model_ms,
            "total_ms": total_ms,
        })
        raise


@app.post("/api/sessions", status_code=status.HTTP_201_CREATED)
async def create_session(
    req: SessionCreateRequest,
    user: AuthUser = Depends(require_trainee_or_supervisor),
) -> dict[str, Any]:
    if not SESSIONS_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Coaching is paused for maintenance.",
        )

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
        "current_step": 1,
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

    # Enforce 12-minute live limit
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

    if (now - started_at).total_seconds() >= 12 * 60:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Session has exceeded maximum live duration and is abandoned",
        )

    # Truncate reason: 300 chars for coach_line/trainee_line, 1000 for others
    if req.reason:
        if req.type in ("coach_line", "trainee_line"):
            clean_reason = req.reason[:300]
        else:
            clean_reason = req.reason[:1000]
    else:
        clean_reason = None

    # Frame upload for mistake and safety_stop
    event_id = secrets.token_hex(8)
    frame_uri = req.frame_uri
    if req.image_b64:
        if req.type not in ("mistake", "safety_stop"):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="image_b64 is only allowed for mistake and safety_stop events",
            )
        raw_b64 = req.image_b64.split(",", 1)[1] if "," in req.image_b64 else req.image_b64
        if len(raw_b64) * 3 / 4 > 300 * 1024:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="Image frame exceeds 300KB limit",
            )
        img = decode_and_validate_image(req.image_b64)
        jpeg_bytes = resize_to_jpeg_bytes(img, max_long_side=640)
        frame_uri = upload_frame_jpeg(session_id, event_id, jpeg_bytes)

    event_dict = {
        "t": now.isoformat(),
        "step": req.step,
        "type": req.type,
        "source": req.source,
        "reason": clean_reason,
        "latency_ms": req.latency_ms,
        "frame_uri": frame_uri,
    }

    if req.type == "step_done":
        @firestore.transactional
        def txn_step_done(transaction):
            s_snap = session_ref.get(transaction=transaction)
            if not s_snap.exists:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
            s_dict = s_snap.to_dict() or {}
            if s_dict.get("trainee_uid") != user.uid:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
            if s_dict.get("status") != "live":
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Session is not live")

            curr_step = s_dict.get("current_step", 1)
            steps = s_dict.get("steps", [])
            total_steps = len(steps)

            update_data = {}
            if req.step == curr_step:
                next_step = min(req.step + 1, total_steps) if total_steps > 0 else req.step + 1
                update_data["current_step"] = next_step
                for s in steps:
                    if s.get("n") == req.step:
                        s["state"] = "done"
                    elif s.get("n") == next_step and s.get("state") == "pending":
                        s["state"] = "active"
                update_data["steps"] = steps

            event_doc = session_ref.collection("events").document(event_id)
            transaction.set(event_doc, event_dict)
            if update_data:
                transaction.update(session_ref, update_data)

        txn = db.transaction()
        txn_step_done(txn)
    else:
        # Plain write for non-step_done events
        session_ref.collection("events").document(event_id).set(event_dict)

    # Stream to BigQuery takumi.session_events
    bq_row = {
        "session_id": session_id,
        "skill_id": session_data.get("skill_id"),
        "trainee_uid": session_data.get("trainee_uid"),
        "language": session_data.get("language"),
        "step": req.step,
        "type": req.type,
        "source": req.source,
        "reason": clean_reason,
        "latency_ms": req.latency_ms,
        "ts": now.isoformat(),
    }
    stream_session_event(bq_row)

    return event_dict


@app.patch("/api/sessions/{session_id}")
async def patch_session(
    session_id: str,
    req: SessionPatchRequest,
    background_tasks: BackgroundTasks,
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

    # Evaluate passport issuance on clean completion
    passport_id = None
    clean_runs = 0
    if req.status == "completed":
        skill_id = session_data.get("skill_id", "")
        passport_id, clean_runs = issue_passport_if_eligible(
            db=db,
            trainee_uid=user.uid,
            skill_id=skill_id,
            current_session=session_data,
            user_display_name=user.display_name,
            background_tasks=background_tasks,
        )

    session_data["passport_id"] = passport_id
    session_data["clean_runs"] = clean_runs
    return session_data


# --- Supervisor Insight Endpoints (Role: supervisor only) ---


@app.get("/api/insights/matrix")
async def get_insights_matrix(
    user: AuthUser = Depends(require_supervisor),
) -> dict[str, Any]:
    cached = get_from_cache("insights:matrix")
    if cached is not None:
        return cached

    db = get_firestore_client()

    # 1. Published skills
    skills_query = db.collection("skills").where("status", "==", "published").stream()
    published_skills = []
    for doc in skills_query:
        d = doc.to_dict() or {}
        published_skills.append({"id": doc.id, "title": d.get("title", doc.id)})
    published_skills.sort(key=lambda x: x["title"])

    # 2. Passports (certified)
    passports_query = db.collection("passports").stream()
    certified_pairs = set()
    for doc in passports_query:
        pd = doc.to_dict() or {}
        t_uid = pd.get("trainee_uid")
        s_id = pd.get("skill_id")
        if t_uid and s_id and t_uid not in EXCLUDED_UIDS:
            certified_pairs.add((t_uid, s_id))

    # 3. Sessions
    now = datetime.now(timezone.utc)
    cutoff_12m = (now - timedelta(minutes=12)).isoformat()
    sessions_query = db.collection("sessions").stream()

    trainee_sessions: dict[str, dict[str, list[dict[str, Any]]]] = {}
    all_trainee_uids: set[str] = set()

    for doc in sessions_query:
        sd = doc.to_dict() or {}
        t_uid = sd.get("trainee_uid")
        s_id = sd.get("skill_id")

        if not t_uid or t_uid in EXCLUDED_UIDS:
            continue

        all_trainee_uids.add(t_uid)
        if t_uid not in trainee_sessions:
            trainee_sessions[t_uid] = {}
        if s_id not in trainee_sessions[t_uid]:
            trainee_sessions[t_uid][s_id] = []
        trainee_sessions[t_uid][s_id].append(sd)

    for t_uid, _ in certified_pairs:
        all_trainee_uids.add(t_uid)

    # 4. Resolve trainee first names
    trainees_list = []
    for t_uid in sorted(all_trainee_uids):
        first_name = get_trainee_first_name(t_uid)
        trainees_list.append({"uid": t_uid, "first_name": first_name})

    # 5. Build matrix cells
    cells = []
    for t_uid in sorted(all_trainee_uids):
        for sk in published_skills:
            sk_id = sk["id"]
            user_skill_sessions = trainee_sessions.get(t_uid, {}).get(sk_id, [])

            is_certified = (t_uid, sk_id) in certified_pairs
            has_sessions = len(user_skill_sessions) > 0

            if is_certified:
                cell_status = "certified"
            elif has_sessions:
                cell_status = "learning"
            else:
                cell_status = "not_started"

            last_session_at = None
            mistakes_trend = []
            if has_sessions:
                sorted_sessions = sorted(
                    user_skill_sessions,
                    key=lambda x: str(x.get("started_at") or ""),
                )
                last_session_at = sorted_sessions[-1].get("started_at")
                recent_5 = sorted_sessions[-5:]
                mistakes_trend = [
                    int(s.get("result", {}).get("mistakes", 0))
                    if isinstance(s.get("result"), dict)
                    else 0
                    for s in recent_5
                ]

            cells.append({
                "uid": t_uid,
                "skill_id": sk_id,
                "status": cell_status,
                "sessions": len(user_skill_sessions),
                "last_session_at": last_session_at,
                "mistakes_trend": mistakes_trend,
            })

    result = {
        "trainees": trainees_list,
        "skills": published_skills,
        "cells": cells,
    }
    set_in_cache("insights:matrix", result)
    return result


@app.get("/api/insights/skill/{skill_id}")
async def get_insights_skill(
    skill_id: str,
    user: AuthUser = Depends(require_supervisor),
) -> dict[str, Any]:
    cache_key = f"insights:skill:{skill_id}"
    cached = get_from_cache(cache_key)
    if cached is not None:
        return cached

    db = get_firestore_client()
    skill_doc = db.collection("skills").document(skill_id).get()
    if not skill_doc.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill not found")

    skill_data = skill_doc.to_dict() or {}
    steps_def = skill_data.get("steps", [])
    total_steps = len(steps_def)

    bq = get_bigquery_client()
    excluded_list = list(EXCLUDED_UIDS)

    # Query 1: Step counts (sessions reached, mistakes, safety stops)
    q1 = f"""
        SELECT
          step,
          COUNT(DISTINCT session_id) AS sessions_reached,
          COUNT(DISTINCT CASE WHEN type = 'mistake' THEN session_id END) AS sessions_with_mistake,
          COUNTIF(type = 'safety_stop') AS safety_stops
        FROM `{GCP_PROJECT}.takumi.session_events`
        WHERE skill_id = @skill_id
          AND trainee_uid NOT IN UNNEST(@excluded_uids)
          AND step IS NOT NULL
        GROUP BY step
        ORDER BY step ASC
    """

    # Query 2: Step timing (LAG only over step_done events)
    q2 = f"""
        WITH session_starts AS (
          SELECT
            session_id,
            MIN(ts) AS session_start_ts
          FROM `{GCP_PROJECT}.takumi.session_events`
          WHERE skill_id = @skill_id
            AND trainee_uid NOT IN UNNEST(@excluded_uids)
          GROUP BY session_id
        ),
        step_dones AS (
          SELECT
            session_id,
            step,
            MIN(ts) AS ts
          FROM `{GCP_PROJECT}.takumi.session_events`
          WHERE skill_id = @skill_id
            AND type = 'step_done'
            AND trainee_uid NOT IN UNNEST(@excluded_uids)
          GROUP BY session_id, step
        ),
        step_times AS (
          SELECT
            session_id,
            step,
            ts,
            LAG(ts) OVER (PARTITION BY session_id ORDER BY step ASC) AS prev_step_done_ts
          FROM step_dones
        )
        SELECT
          st.session_id,
          st.step,
          CASE
            WHEN st.prev_step_done_ts IS NOT NULL THEN
              TIMESTAMP_DIFF(st.ts, st.prev_step_done_ts, SECOND)
            ELSE
              TIMESTAMP_DIFF(st.ts, ss.session_start_ts, SECOND)
          END AS step_secs
        FROM step_times st
        JOIN session_starts ss ON st.session_id = ss.session_id
    """

    # Query 3: Session totals (sessions, completed, duration)
    q3 = f"""
        WITH session_summary AS (
          SELECT
            session_id,
            MIN(ts) AS first_ts,
            MAX(ts) AS last_ts,
            MAX(CASE WHEN type = 'step_done' THEN step ELSE 0 END) AS max_step_done
          FROM `{GCP_PROJECT}.takumi.session_events`
          WHERE skill_id = @skill_id
            AND trainee_uid NOT IN UNNEST(@excluded_uids)
          GROUP BY session_id
        )
        SELECT
          session_id,
          TIMESTAMP_DIFF(last_ts, first_ts, SECOND) AS duration_s,
          max_step_done
        FROM session_summary
    """

    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("skill_id", "STRING", skill_id),
            bigquery.ArrayQueryParameter("excluded_uids", "STRING", excluded_list),
        ]
    )

    try:
        r1_rows = list(bq.query(q1, job_config=job_config).result())
        r2_rows = list(bq.query(q2, job_config=job_config).result())
        r3_rows = list(bq.query(q3, job_config=job_config).result())
    except Exception as e:
        logger.error(f"BigQuery insights query failed: {e}")
        r1_rows, r2_rows, r3_rows = [], [], []

    # Map step counts
    counts_by_step = {
        r.step: {
            "sessions_reached": r.sessions_reached,
            "sessions_with_mistake": r.sessions_with_mistake,
            "safety_stops": r.safety_stops,
        }
        for r in r1_rows
    }

    # Map step durations
    durations_by_step: dict[int, list[float]] = {}
    for r in r2_rows:
        if r.step not in durations_by_step:
            durations_by_step[r.step] = []
        if r.step_secs is not None:
            durations_by_step[r.step].append(float(r.step_secs))

    # Assemble per-step statistics
    steps_result = []
    for sdef in steps_def:
        sn = sdef.get("n", 1)
        s_counts = counts_by_step.get(sn, {})
        s_reached = s_counts.get("sessions_reached", 0)
        s_with_mistake = s_counts.get("sessions_with_mistake", 0)
        s_safety_stops = s_counts.get("safety_stops", 0)

        if s_reached > 0:
            mistake_rate = round(float(s_with_mistake) / float(s_reached), 2)
            s_durations = durations_by_step.get(sn, [])
            median_secs = (
                round(float(statistics.median(s_durations)), 1)
                if s_durations
                else None
            )
            safety_stops = s_safety_stops
        else:
            mistake_rate = None
            median_secs = None
            safety_stops = None

        steps_result.append({
            "n": sn,
            "instruction": sdef.get("instruction", f"Step {sn}"),
            "sessions_reached": s_reached,
            "mistake_rate": mistake_rate,
            "median_secs": median_secs,
            "safety_stops": safety_stops,
        })

    # Assemble totals
    total_sessions = len(r3_rows)
    completed_sessions = sum(1 for r in r3_rows if (r.max_step_done or 0) >= total_steps)
    completed_durations = [
        float(r.duration_s)
        for r in r3_rows
        if (r.max_step_done or 0) >= total_steps and r.duration_s is not None
    ]
    if completed_durations:
        median_duration_s = round(float(statistics.median(completed_durations)), 1)
    else:
        median_duration_s = None

    totals = {
        "sessions": total_sessions,
        "completed": completed_sessions,
        "median_duration_s": median_duration_s,
    }

    response_payload = {
        "steps": steps_result,
        "totals": totals,
    }
    set_in_cache(cache_key, response_payload)
    return response_payload


@app.get("/api/sessions/{session_id}/replay")
async def get_session_replay(
    session_id: str,
    user: AuthUser = Depends(require_supervisor),
) -> dict[str, Any]:
    cache_key = f"insights:replay:{session_id}"
    cached = get_from_cache(cache_key)
    if cached is not None:
        return cached

    db = get_firestore_client()
    session_ref = db.collection("sessions").document(session_id)
    session_doc = session_ref.get()
    if not session_doc.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    session_data = session_doc.to_dict() or {}
    trainee_uid = session_data.pop("trainee_uid", None)
    first_name = get_trainee_first_name(trainee_uid)
    session_data["first_name"] = first_name

    # If session is live and started > 12 minutes ago, label as abandoned
    now = datetime.now(timezone.utc)
    started_at_raw = session_data.get("started_at")
    if started_at_raw and session_data.get("status") == "live":
        try:
            if isinstance(started_at_raw, str):
                s_time = datetime.fromisoformat(started_at_raw)
            elif isinstance(started_at_raw, datetime):
                s_time = started_at_raw
            else:
                s_time = None
            if s_time and (now - s_time).total_seconds() > 12 * 60:
                session_data["status"] = "abandoned"
        except Exception:
            pass

    # Fetch events in chronological order
    events_docs = session_ref.collection("events").order_by("t").stream()
    events = []
    for edoc in events_docs:
        edata = edoc.to_dict() or {}
        frame_uri = edata.get("frame_uri")
        if frame_uri and frame_uri.startswith("gs://"):
            edata["frame_uri"] = get_signed_url_for_gs_uri(frame_uri, expires_minutes=15)
        events.append(edata)

    replay_payload = {
        "session": session_data,
        "events": events,
    }
    set_in_cache(cache_key, replay_payload)
    return replay_payload


# --- Skill Passport Endpoints ---


@app.get("/api/passports/{passport_id}")
async def get_public_passport(
    passport_id: str,
    request: Request,
) -> dict[str, Any]:
    """Public certificate verification endpoint. Rate-limited per IP (60/min).

    Returns allowlisted fields only. Explicitly omits uid, session_ids, and email.
    """
    check_public_rate_limit(request, limit=60, window_s=60)
    db = get_firestore_client()
    pdoc = db.collection("passports").document(passport_id).get()

    if not pdoc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This certificate could not be found.",
        )

    pd = pdoc.to_dict() or {}
    skill_id = pd.get("skill_id", "")
    badge_url = get_badge_signed_url_if_exists(skill_id, expires_hours=1)

    return {
        "id": pd.get("id", passport_id),
        "display_first_name": pd.get("display_first_name", "Trainee"),
        "skill_title": pd.get("skill_title", ""),
        "master_display_name": pd.get("master_display_name", "Master Craftsperson"),
        "language": pd.get("language", "en"),
        "issued_at": pd.get("issued_at", ""),
        "sessions_count": len(pd.get("session_ids", [])),
        "verified": True,
        "badge_url": badge_url,
    }


@app.get("/api/me/passports")
async def get_my_passports(
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    """Returns caller's earned certificates for trainee profile / home screen."""
    db = get_firestore_client()
    passports_stream = (
        db.collection("passports")
        .where("trainee_uid", "==", user.uid)
        .stream()
    )

    results = []
    for pdoc in passports_stream:
        pd = pdoc.to_dict() or {}
        skill_id = pd.get("skill_id", "")
        badge_url = get_badge_signed_url_if_exists(skill_id, expires_hours=1)
        results.append({
            "id": pd.get("id", pdoc.id),
            "skill_id": skill_id,
            "skill_title": pd.get("skill_title", ""),
            "display_first_name": pd.get("display_first_name", "Trainee"),
            "master_display_name": pd.get("master_display_name", "Master Craftsperson"),
            "language": pd.get("language", "en"),
            "issued_at": pd.get("issued_at", ""),
            "sessions_count": len(pd.get("session_ids", [])),
            "badge_url": badge_url,
            "verify_url": pd.get("verify_url", f"https://takumi-cup-2026.web.app/passport/{pd.get('id', pdoc.id)}"),
        })

    # Sort descending by issued_at
    results.sort(key=lambda x: x.get("issued_at", ""), reverse=True)
    return {"passports": results}


# --- Public Status & Telemetry ---

_STATUS_CACHE: dict[str, Any] = {"data": None, "cached_at": 0.0}


@app.get("/api/status")
async def get_system_status(request: Request) -> dict[str, Any]:
    """Public system health and 24-hour latency metrics computed from BigQuery.

    Cached for 60 seconds. Rate limited per IP (60/min).
    Returns pure numeric metrics with no user identifiers, personal names, or emails.
    """
    check_public_rate_limit(request, limit=60, window_s=60)

    now_epoch = time.time()
    if _STATUS_CACHE["data"] is not None and (now_epoch - _STATUS_CACHE["cached_at"]) < 60:
        return _STATUS_CACHE["data"]

    bq = get_bigquery_client()
    excluded_list = list(EXCLUDED_UIDS)

    # 1. Total sessions in last 24h from takumi.session_events
    q_sessions = f"""
    SELECT COUNT(DISTINCT session_id) as session_count
    FROM `{GCP_PROJECT}.takumi.session_events`
    WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
      AND (trainee_uid IS NULL OR (trainee_uid NOT IN UNNEST(@excluded_uids) AND trainee_uid != 'smoke-trainee'))
    """
    job_cfg_sessions = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ArrayQueryParameter("excluded_uids", "STRING", excluded_list),
        ]
    )
    sessions_count = 0
    try:
        rows = list(bq.query(q_sessions, job_config=job_cfg_sessions).result())
        if rows:
            sessions_count = int(rows[0]["session_count"] or 0)
    except Exception as exc:
        logger.warning(f"Failed to query 24h sessions for /api/status: {exc}")

    # 2. decision_to_audio latencies in last 24h from takumi.session_events
    q_d2a = f"""
    SELECT
      APPROX_QUANTILES(latency_ms, 100)[OFFSET(50)] as p50,
      APPROX_QUANTILES(latency_ms, 100)[OFFSET(90)] as p90
    FROM `{GCP_PROJECT}.takumi.session_events`
    WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
      AND source = 'watcher'
      AND type IN ('step_done', 'mistake')
      AND latency_ms IS NOT NULL
      AND (trainee_uid IS NULL OR (trainee_uid NOT IN UNNEST(@excluded_uids) AND trainee_uid != 'smoke-trainee'))
    """
    p50_d2a, p90_d2a = None, None
    try:
        rows = list(bq.query(q_d2a, job_config=job_cfg_sessions).result())
        if rows and rows[0]["p50"] is not None:
            p50_d2a = int(rows[0]["p50"])
            p90_d2a = int(rows[0]["p90"])
    except Exception as exc:
        logger.warning(f"Failed to query decision_to_audio latencies: {exc}")

    # 3. watch/verify/point latencies in last 24h from takumi.api_calls
    q_apis = f"""
    SELECT
      endpoint,
      APPROX_QUANTILES(total_ms, 100)[OFFSET(50)] as p50,
      APPROX_QUANTILES(total_ms, 100)[OFFSET(90)] as p90
    FROM `{GCP_PROJECT}.takumi.api_calls`
    WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
      AND status = 200
      AND endpoint IN ('watch', 'verify', 'point')
    GROUP BY endpoint
    """
    p50_map: dict[str, int | None] = {"watch": None, "verify": None, "point": None, "decision_to_audio": p50_d2a}
    p90_map: dict[str, int | None] = {"watch": None, "verify": None, "point": None, "decision_to_audio": p90_d2a}

    try:
        rows = list(bq.query(q_apis).result())
        for row in rows:
            ep = str(row["endpoint"])
            if ep in p50_map and row["p50"] is not None:
                p50_map[ep] = int(row["p50"])
                p90_map[ep] = int(row["p90"])
    except Exception as exc:
        logger.warning(f"Failed to query api_calls latencies: {exc}")

    result = {
        "api": "ok",
        "sessions_enabled": SESSIONS_ENABLED,
        "last_24h": {
            "sessions": sessions_count,
            "p50_ms": p50_map,
            "p90_ms": p90_map,
        },
    }

    _STATUS_CACHE["data"] = result
    _STATUS_CACHE["cached_at"] = now_epoch
    return result


# --- CSP Violation Reporting ---

@app.post("/api/csp-report", status_code=status.HTTP_204_NO_CONTENT)
async def post_csp_report(request: Request) -> Response:
    """Endpoint for Content-Security-Policy-Report-Only violations.

    Rate-limited per IP. Logs violation details as structured warnings.
    """
    check_public_rate_limit(request, limit=120, window_s=60)
    try:
        body = await request.body()
        if body:
            data = json.loads(body.decode("utf-8"))
            report_payload = data.get("csp-report", data)
            logger.warning(
                "CSP violation reported",
                extra={
                    "event": "csp_violation",
                    "document_uri": report_payload.get("document-uri"),
                    "violated_directive": report_payload.get("violated-directive"),
                    "effective_directive": report_payload.get("effective-directive"),
                    "blocked_uri": report_payload.get("blocked-uri"),
                    "status_code": report_payload.get("status-code"),
                },
            )
    except Exception as exc:
        logger.warning(f"Failed to parse CSP report: {exc}")

    return Response(status_code=status.HTTP_204_NO_CONTENT)

