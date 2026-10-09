"""TAKUMI API service implemented with FastAPI on Python 3.12."""

import base64
from datetime import datetime, timedelta, timezone
import io
import json
import logging
import re
import secrets
import statistics
import time
import uuid
from pathlib import Path
from typing import Any, Literal

from PIL import Image
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request, Response, status
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
    require_role,
    verify_auth_token,
)
from services.api.bigquery_client import (
    get_bigquery_client,
    stream_api_call,
    stream_inspection_event,
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
from services.api.storage_client import (
    download_blob_bytes,
    get_signed_url_for_gs_uri,
    upload_frame_jpeg,
    upload_inspection_jpeg,
)
from services.api.gemini import (
    call_ask,
    call_point,
    call_verify,
    call_watch,
    check_deep_health,
    create_live_token,
)
from services.api.images import decode_and_validate_image, resize_to_jpeg_bytes
from services.api.inspection import get_or_load_references, resize_inspection_image, run_inspection_pipeline
from services.api.telemetry import elapsed_ms, init_telemetry, setup_logging

logger = setup_logging()
init_telemetry()

app = FastAPI(title="TAKUMI API", version="0.1.0")


# --- Middlewares ---


class RequestSizeLimitMiddleware(BaseHTTPMiddleware):
    """Rejects incoming request payloads larger than MAX_REQUEST_SIZE_BYTES (2 MB) with 413,
    except for inspection routes which accept up to 12 MB for 8 MB decoded images.
    """

    async def dispatch(self, request: Request, call_next):
        content_length = request.headers.get("content-length")
        limit = 12 * 1024 * 1024 if request.url.path.startswith("/api/inspect") else MAX_REQUEST_SIZE_BYTES
        if content_length and int(content_length) > limit:
            return JSONResponse(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                content={"detail": "Payload too large"},
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


class AskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skill_id: str
    question: str
    language: str = "en"


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


_user_master_cache: dict[str, tuple[float, bool]] = {}


def clear_insights_cache() -> None:
    _insights_cache.clear()
    _user_master_cache.clear()


def is_master_user(uid: str | None) -> bool:
    """Checks whether user UID has role 'master' in Firebase Auth."""
    if not uid:
        return False
    now = time.time()
    if uid in _user_master_cache:
        ts, is_m = _user_master_cache[uid]
        if now - ts < 300:  # 5 min TTL
            return is_m
    init_firebase_admin()
    is_master = False
    try:
        user_record = fb_auth.get_user(uid)
        claims = getattr(user_record, "custom_claims", None)
        if isinstance(claims, dict) and claims.get("role") == "master":
            is_master = True
    except Exception:
        pass
    _user_master_cache[uid] = (now, is_master)
    return is_master


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


def record_call_timing(
    endpoint: str,
    status_code: int,
    t_handler_start: float,
    t_model_start: float | None = None,
) -> dict[str, Any]:
    """Records API timing metrics using elapsed_ms for both model and handler durations."""
    t_now = time.perf_counter()
    model_ms = elapsed_ms(t_model_start, t_now) if t_model_start is not None else None
    total_ms = elapsed_ms(t_handler_start, t_now)
    if model_ms is not None and total_ms < model_ms:
        total_ms = model_ms
    row = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "endpoint": endpoint,
        "status": status_code,
        "model_ms": model_ms,
        "total_ms": total_ms,
    }
    stream_api_call(row)
    return row


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
        if user.role not in ("trainee", "supervisor", "master"):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Forbidden: purpose 'coach' requires role 'trainee', 'supervisor', or 'master'",
            )
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid purpose")

    check_rate_limit(user.uid, "live_tokens")

    t_model_start = time.perf_counter()
    try:
        token_data = await create_live_token(req.purpose)
        record_call_timing("live-token", 200, t_handler_start, t_model_start)
        response.headers["Cache-Control"] = "no-store"
        return token_data
    except HTTPException as e:
        record_call_timing("live-token", e.status_code, t_handler_start, t_model_start)
        raise
    except Exception:
        record_call_timing("live-token", 500, t_handler_start, t_model_start)
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
    try:
        res = await call_watch(
            step=req.step,
            instruction=req.instruction,
            success_criteria=req.success_criteria,
            common_mistakes=mistakes_dicts,
            safety_rules=req.safety_rules,
            jpeg_bytes=jpeg_bytes,
        )
        record_call_timing("watch", 200, t_handler_start, t_model_start)
        return res
    except HTTPException as e:
        record_call_timing("watch", e.status_code, t_handler_start, t_model_start)
        raise
    except Exception:
        record_call_timing("watch", 500, t_handler_start, t_model_start)
        raise


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
        record_call_timing("verify", 200, t_handler_start, t_model_start)
        return res
    except HTTPException as e:
        record_call_timing("verify", e.status_code, t_handler_start, t_model_start)
        raise
    except Exception:
        record_call_timing("verify", 500, t_handler_start, t_model_start)
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
        record_call_timing("point", 200, t_handler_start, None)
        return {"points": [], "secs": 0.0, "blocked": True}

    img = decode_and_validate_image(req.image_b64)
    jpeg_bytes = resize_to_jpeg_bytes(img, max_long_side=1280)

    t_model_start = time.perf_counter()
    try:
        res = await call_point(
            target=req.target,
            jpeg_bytes=jpeg_bytes,
        )
        record_call_timing("point", 200, t_handler_start, t_model_start)
        return res
    except HTTPException as e:
        record_call_timing("point", e.status_code, t_handler_start, t_model_start)
        raise
    except Exception:
        record_call_timing("point", 500, t_handler_start, t_model_start)
        raise


@app.get("/api/skills/{skill_id}/media")
async def get_skill_media(
    skill_id: str,
    step: int = Query(..., ge=1),
    kind: Literal["master_clip", "mistake_clip"] = Query(...),
    lang: str = Query(default="en"),
    user: AuthUser = Depends(require_any_authenticated_user),
) -> dict[str, Any]:
    """Provides short-lived signed URLs for master demonstration clips and AI mistake clips.

    Role requirement: trainee, supervisor, master. Skill must be published.
    15-minute V4 IAM signed URL. Never logs signed URLs.
    """
    db = get_firestore_client()
    skill_doc = db.collection("skills").document(skill_id).get()
    if not skill_doc.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill not found")

    skill_data = skill_doc.to_dict() or {}
    if skill_data.get("status") != "published":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill is not published")

    target_step = None
    for s in skill_data.get("steps", []):
        if s.get("n") == step:
            target_step = s
            break

    if not target_step:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not available")

    if kind == "master_clip":
        video_uri = skill_data.get("video_uri")
        clip = target_step.get("clip")
        if not video_uri or not clip or "start_s" not in clip or "end_s" not in clip:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not available")

        signed_url = get_signed_url_for_gs_uri(video_uri, expires_minutes=15)
        translations = target_step.get("translations", {})
        if lang in translations and translations[lang].get("why"):
            why = translations[lang]["why"]
            why_lang = lang
            translated = True
        else:
            why = target_step.get("why", "")
            why_lang = skill_data.get("source_language", "en")
            translated = (lang == why_lang)

        return {
            "url": signed_url,
            "start_s": float(clip["start_s"]),
            "end_s": float(clip["end_s"]),
            "why": why,
            "why_lang": why_lang,
            "translated": translated,
        }

    elif kind == "mistake_clip":
        mistake_clip_uri = target_step.get("mistake_clip_uri")
        if not mistake_clip_uri:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not available")

        signed_url = get_signed_url_for_gs_uri(mistake_clip_uri, expires_minutes=15)
        return {
            "url": signed_url,
            "label": "AI-generated example of the wrong way",
        }


@app.post("/api/ask")
async def ask_master(
    req: AskRequest,
    user: AuthUser = Depends(require_any_authenticated_user),
) -> dict[str, Any]:
    """Answers a craftsmanship question grounded strictly in master transcript and skill manual.

    Fails-closed on Model Armor screening (422).
    Rate-limited under 'checks'.
    Uses gemini-3.8-flash without temperature.
    Timeout 12 s with fallback: "Let's come back to that."
    """
    t_handler_start = time.perf_counter()
    check_rate_limit(user.uid, "checks")

    screening = screen_text(req.question, purpose="question")
    if not screening.get("allowed", True):
        record_call_timing("ask", 422, t_handler_start, None)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="I can't help with that question.",
        )

    db = get_firestore_client()
    skill_doc = db.collection("skills").document(req.skill_id).get()
    if not skill_doc.exists:
        record_call_timing("ask", 404, t_handler_start, None)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill not found")

    skill_data = skill_doc.to_dict() or {}
    if skill_data.get("status") != "published":
        record_call_timing("ask", 404, t_handler_start, None)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill is not published")

    capture_data = {}
    capture_id = skill_data.get("capture_id")
    if capture_id:
        cap_doc = db.collection("captures").document(capture_id).get()
        if cap_doc.exists:
            capture_data = cap_doc.to_dict() or {}

    t_model_start = time.perf_counter()
    try:
        res = await call_ask(
            skill_data=skill_data,
            capture_data=capture_data,
            question=req.question,
            language=req.language,
        )
        record_call_timing("ask", 200, t_handler_start, t_model_start)
        return res
    except HTTPException as e:
        record_call_timing("ask", e.status_code, t_handler_start, t_model_start)
        raise
    except Exception:
        record_call_timing("ask", 500, t_handler_start, t_model_start)
        raise


@app.post("/api/sessions", status_code=status.HTTP_201_CREATED)
async def create_session(
    req: SessionCreateRequest,
    user: AuthUser = Depends(require_any_authenticated_user),
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
        "preview": True if user.role == "master" else False,
    }

    db.collection("sessions").document(session_id).set(session_data)
    return session_data


@app.post("/api/sessions/{session_id}/events", status_code=status.HTTP_201_CREATED)
async def create_session_event(
    session_id: str,
    req: SessionEventCreateRequest,
    user: AuthUser = Depends(require_any_authenticated_user),
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
        "preview": session_data.get("preview", False),
    }
    stream_session_event(bq_row)

    return event_dict


@app.patch("/api/sessions/{session_id}")
async def patch_session(
    session_id: str,
    req: SessionPatchRequest,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(require_any_authenticated_user),
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
    include_masters: bool = Query(default=False),
    user: AuthUser = Depends(require_supervisor),
) -> dict[str, Any]:
    cache_key = f"insights:matrix:include_masters={include_masters}"
    cached = get_from_cache(cache_key)
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
        if not include_masters and sd.get("preview") is True:
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
    set_in_cache(cache_key, result)
    return result


@app.get("/api/insights/skill/{skill_id}")
async def get_insights_skill(
    skill_id: str,
    include_masters: bool = Query(default=False),
    user: AuthUser = Depends(require_supervisor),
) -> dict[str, Any]:
    cache_key = f"insights:skill:{skill_id}:include_masters={include_masters}"
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
    preview_filter = "" if include_masters else "AND COALESCE(preview, FALSE) = FALSE"

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
          {preview_filter}
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
            {preview_filter}
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
            {preview_filter}
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
            {preview_filter}
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


# --- End-of-Line Quality Inspection (P15) ---

UNIT_ID_REGEX = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class InspectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product_id: str
    image_b64: str
    unit_id: str | None = None
    mode: Literal["few_false_alarms", "catch_everything"] | None = None
    source: Literal["manual_upload", "batch_eval", "station_camera"] | None = "manual_upload"


class InspectionDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["confirmed_defect", "overridden_ok", "confirmed_ok"]
    notes: str | None = None


class CreateProductRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    name: str
    description: str
    defect_types: list[str]
    reference_image_paths: list[str] = Field(..., min_length=3, max_length=3)
    default_mode: Literal["few_false_alarms", "catch_everything"] = "few_false_alarms"
    source: Literal["LIVE", "PUBLIC DATA: VisA (CC BY 4.0)"] = "PUBLIC DATA: VisA (CC BY 4.0)"


@app.post("/api/inspect")
async def post_inspect(
    req: InspectRequest,
    user: AuthUser = Depends(require_role("trainee", "supervisor", "master")),
) -> dict[str, Any]:
    """Runs dual-stage visual inspection on a candidate product unit."""
    t_api_start = time.perf_counter()

    # 1. Validate unit_id format if provided
    if req.unit_id is not None:
        if not UNIT_ID_REGEX.match(req.unit_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid unit_id: must match regex ^[A-Za-z0-9._-]{1,64}$",
            )

    # 2. Decode and validate image
    try:
        cand_bytes = base64.b64decode(req.image_b64)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid base64 image data",
        ) from e

    if len(cand_bytes) > 8 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Image payload exceeds maximum allowed size of 8 MB decoded",
        )

    try:
        with Image.open(io.BytesIO(cand_bytes)) as img:
            img_format = (img.format or "").upper()
            if img_format not in ("JPEG", "PNG", "MPO", "WEBP"):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Image format '{img_format}' is not supported. Must be JPEG, PNG, or WebP.",
                )
            img.load()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded file cannot be opened as a valid image",
        ) from e

    # 3. Retrieve product from Firestore
    db = get_firestore_client()
    prod_snap = db.collection("products").document(req.product_id).get()
    if not prod_snap.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Product '{req.product_id}' not found",
        )
    prod_data = prod_snap.to_dict() or {}

    ref_paths = prod_data.get("reference_image_paths") or []
    if len(ref_paths) < 3:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Product '{req.product_id}' does not have 3 reference images configured",
        )

    # 4. Check rate limit ONLY after all inputs and product validation pass (400/404 never use quota)
    check_rate_limit(user.uid, "checks", cost=2)

    try:
        ref_bytes_list = get_or_load_references(req.product_id, ref_paths[:3])
    except Exception as e:
        logger.error("Failed to load reference images for product %s: %s", req.product_id, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load product reference images from storage",
        ) from e

    mode = req.mode or prod_data.get("default_mode", "few_false_alarms")

    # 5. Run inspection pipeline
    inspect_res = await run_inspection_pipeline(
        product_description=prod_data.get("description", ""),
        defect_types=prod_data.get("defect_types", []),
        candidate_bytes=cand_bytes,
        reference_bytes_list=ref_bytes_list,
        mode=mode,
    )

    # 6. Persist inspection image and document
    inspection_id = f"insp_{secrets.token_hex(12)}"
    now_iso = datetime.now(timezone.utc).isoformat()
    image_path = f"inspections/{inspection_id}.jpg"

    try:
        cand_jpeg = resize_inspection_image(cand_bytes)
        upload_inspection_jpeg(inspection_id, cand_jpeg)
    except Exception as e:
        logger.warning("Failed to upload inspection image: %s", e)

    inspection_doc = {
        "id": inspection_id,
        "unit_id": req.unit_id,
        "product_id": req.product_id,
        "image_path": image_path,
        "mode": mode,
        "screen": inspect_res["screen"],
        "confirm": inspect_res.get("confirm"),
        "ai_verdict": inspect_res["ai_verdict"],
        "human_decision": None,
        "decided_by_uid": None,
        "decided_at": None,
        "source": prod_data.get("source", "PUBLIC DATA: VisA (CC BY 4.0)"),
        "inspector_uid": user.uid,
        "created_at": now_iso,
        "total_ms": inspect_res["total_ms"],
    }
    db.collection("inspections").document(inspection_id).set(inspection_doc)

    # 7. Update unit lifecycle if unit_id is provided
    if req.unit_id:
        unit_ref = db.collection("units").document(req.unit_id)
        unit_snap = unit_ref.get()

        # Status transition: "passed" if ok, else "needs_review" (never failed directly by AI)
        unit_status = "passed" if inspect_res["ai_verdict"] == "ok" else "needs_review"

        if unit_snap.exists:
            existing = unit_snap.to_dict() or {}
            existing_inspections = existing.get("inspections", [])
            if inspection_id not in existing_inspections:
                existing_inspections.append(inspection_id)
            update_data = {
                "status": unit_status,
                "inspections": existing_inspections,
            }
            if not existing.get("created_by"):
                update_data["created_by"] = user.uid
            unit_ref.update(update_data)
        else:
            unit_ref.set({
                "id": req.unit_id,
                "product_id": req.product_id,
                "created_at": now_iso,
                "status": unit_status,
                "station_records": [],
                "inspections": [inspection_id],
                "created_by": user.uid,
            })

    # 7. BigQuery events & telemetry
    screen_ms = inspect_res["screen"]["ms"] if inspect_res.get("screen") else None
    confirm_ms = inspect_res["confirm"]["ms"] if inspect_res.get("confirm") else None
    model_ms = (screen_ms or 0) + (confirm_ms or 0)

    stream_inspection_event({
        "ts": now_iso,
        "inspection_id": inspection_id,
        "product_id": req.product_id,
        "unit_id": req.unit_id,
        "mode": mode,
        "ai_verdict": inspect_res["ai_verdict"],
        "defect": inspect_res.get("defect"),
        "screen_ms": screen_ms,
        "confirm_ms": confirm_ms,
        "total_ms": inspect_res["total_ms"],
        "human_decision": None,
        "source": req.source or "manual_upload",
    })

    stream_api_call({
        "ts": now_iso,
        "endpoint": "inspect",
        "status": 200,
        "model_ms": model_ms,
        "total_ms": elapsed_ms(t_api_start),
    })

    return {
        "inspection_id": inspection_id,
        "ai_verdict": inspect_res["ai_verdict"],
        "defect": inspect_res.get("defect"),
        "where": inspect_res.get("where"),
        "confidence": inspect_res.get("confidence", 0.0),
        "mode": mode,
        "screen": inspect_res["screen"],
        "confirm": inspect_res.get("confirm"),
        "total_ms": inspect_res["total_ms"],
        "image_path": image_path,
        "unit_id": req.unit_id,
    }


@app.post("/api/inspections/{inspection_id}/decision")
async def post_inspection_decision(
    inspection_id: str,
    req: InspectionDecisionRequest,
    user: AuthUser = Depends(require_role("supervisor")),
) -> dict[str, Any]:
    """Records a supervisor human verification or override on an inspection."""
    db = get_firestore_client()
    insp_ref = db.collection("inspections").document(inspection_id)
    insp_snap = insp_ref.get()
    if not insp_snap.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Inspection '{inspection_id}' not found",
        )

    insp_data = insp_snap.to_dict() or {}
    now_iso = datetime.now(timezone.utc).isoformat()

    update_fields: dict[str, Any] = {
        "human_decision": req.decision,
        "decided_by_uid": user.uid,
        "decided_at": now_iso,
    }
    if req.notes is not None:
        update_fields["decision_notes"] = req.notes
    insp_ref.update(update_fields)

    # Update unit lifecycle
    unit_id = insp_data.get("unit_id")
    if unit_id:
        unit_ref = db.collection("units").document(unit_id)
        unit_snap = unit_ref.get()
        if unit_snap.exists:
            # confirmed_defect sets failed; overridden_ok / confirmed_ok sets passed
            new_status = "failed" if req.decision == "confirmed_defect" else "passed"
            unit_ref.update({"status": new_status})

    # Stream event to BigQuery
    screen_data = insp_data.get("screen") or {}
    confirm_data = insp_data.get("confirm") or {}
    stream_inspection_event({
        "ts": now_iso,
        "inspection_id": inspection_id,
        "product_id": insp_data.get("product_id", ""),
        "unit_id": unit_id,
        "mode": insp_data.get("mode", "few_false_alarms"),
        "ai_verdict": insp_data.get("ai_verdict", "needs_review"),
        "defect": confirm_data.get("defect") or screen_data.get("defect"),
        "screen_ms": screen_data.get("ms"),
        "confirm_ms": confirm_data.get("ms"),
        "total_ms": insp_data.get("total_ms", 0),
        "human_decision": req.decision,
        "source": insp_data.get("source", "LIVE"),
    })

    return {
        "inspection_id": inspection_id,
        "human_decision": req.decision,
        "decided_at": now_iso,
        "decided_by_uid": user.uid,
    }


@app.get("/api/products")
async def list_products(
    user: AuthUser = Depends(verify_auth_token),
) -> list[dict[str, Any]]:
    """Lists all products registered in TAKUMI."""
    db = get_firestore_client()
    docs = db.collection("products").stream()
    products = [d.to_dict() for d in docs]
    products.sort(key=lambda p: p.get("id", ""))
    return products


@app.get("/api/products/{product_id}")
async def get_product(
    product_id: str,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    """Retrieves a single product document by ID."""
    db = get_firestore_client()
    doc = db.collection("products").document(product_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Product '{product_id}' not found",
        )
    return doc.to_dict() or {}


@app.post("/api/products")
async def create_product(
    req: CreateProductRequest,
    user: AuthUser = Depends(require_role("supervisor")),
) -> dict[str, Any]:
    """Registers or updates a product definition (supervisor only)."""
    db = get_firestore_client()
    doc_ref = db.collection("products").document(req.id)
    now_iso = datetime.now(timezone.utc).isoformat()
    data = {
        "id": req.id,
        "name": req.name,
        "description": req.description,
        "defect_types": req.defect_types,
        "reference_image_paths": req.reference_image_paths,
        "default_mode": req.default_mode,
        "source": req.source,
        "created_at": now_iso,
    }
    doc_ref.set(data)
    return data


@app.get("/api/units/{unit_id}")
async def get_unit(
    unit_id: str,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    """Retrieves a unit tracking document and lifecycle state (supervisor or owner only)."""
    if not UNIT_ID_REGEX.match(unit_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid unit_id: must match regex ^[A-Za-z0-9._-]{1,64}$",
        )
    db = get_firestore_client()
    doc = db.collection("units").document(unit_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unit '{unit_id}' not found",
        )
    data = doc.to_dict() or {}
    if user.role != "supervisor" and data.get("created_by") != user.uid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: access denied to this unit",
        )
    return data


@app.get("/api/inspections/{inspection_id}")
async def get_inspection(
    inspection_id: str,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    """Retrieves an inspection result by ID with signed media URL (supervisor or owner only)."""
    db = get_firestore_client()
    doc = db.collection("inspections").document(inspection_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Inspection '{inspection_id}' not found",
        )
    data = doc.to_dict() or {}
    if user.role != "supervisor" and data.get("inspector_uid") != user.uid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: access denied to this inspection",
        )
    if "image_path" in data and data["image_path"]:
        data["image_url"] = get_signed_url_for_gs_uri(f"gs://{STORAGE_BUCKET}/{data['image_path']}")
    return data


class InspectGalleryRequest(BaseModel):
    gallery_id: str = Field(..., min_length=1, max_length=128)
    mode: Literal["few_false_alarms", "catch_everything"] = "few_false_alarms"


@app.get("/api/inspect/gallery")
async def get_inspect_gallery(
    category: str | None = None,
    user: AuthUser = Depends(require_role("trainee", "supervisor", "master")),
) -> list[dict[str, Any]]:
    """Lists VisA benchmark gallery items with signed image URLs.
    Labels are omitted to prevent cheating before inspection.
    """
    db = get_firestore_client()
    query = db.collection("gallery")
    if category:
        query = query.where("product_id", "==", category)
    docs = query.stream()
    items = []
    for d in docs:
        data = d.to_dict() or {}
        img_path = data.get("image_path", "")
        img_url = get_signed_url_for_gs_uri(f"gs://{STORAGE_BUCKET}/{img_path}") if img_path else ""
        items.append({
            "id": d.id,
            "product_id": data.get("product_id"),
            "category": data.get("product_id"),
            "image_url": img_url,
            "filename": Path(img_path).name if img_path else d.id,
        })
    items.sort(key=lambda x: (x.get("product_id", ""), x.get("id", "")))
    return items


@app.post("/api/inspect/gallery")
async def post_inspect_gallery(
    req: InspectGalleryRequest,
    user: AuthUser = Depends(require_role("trainee", "supervisor", "master")),
) -> dict[str, Any]:
    """Inspects a public VisA gallery image on demand.
    Server loads image from Cloud Storage, runs dual-stage inspection,
    stores record with source 'PUBLIC DATA: VisA (CC BY 4.0)', and reveals dataset label.
    """
    t_api_start = time.perf_counter()

    db = get_firestore_client()
    gal_doc = db.collection("gallery").document(req.gallery_id).get()
    if not gal_doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Gallery item '{req.gallery_id}' not found",
        )
    gal_data = gal_doc.to_dict() or {}

    product_id = gal_data.get("product_id")
    prod_snap = db.collection("products").document(product_id).get()
    if not prod_snap.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Product '{product_id}' not found",
        )
    prod_data = prod_snap.to_dict() or {}

    # Quota check (2 checks per inspection call)
    check_rate_limit(user.uid, "checks", cost=2)

    ref_paths = prod_data.get("reference_image_paths") or []
    if len(ref_paths) < 3:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Product '{product_id}' does not have 3 reference images configured",
        )

    # 1. Download candidate image bytes from Cloud Storage
    try:
        cand_bytes = download_blob_bytes(gal_data["image_path"])
    except Exception as e:
        logger.error(f"Failed to download gallery image {gal_data.get('image_path')}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve gallery candidate image from storage",
        ) from e

    # 2. Get cached references
    try:
        ref_bytes_list = get_or_load_references(product_id, ref_paths[:3])
    except Exception as e:
        logger.error(f"Failed to load references for product {product_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to download reference images for product '{product_id}'",
        ) from e

    # 3. Run dual-stage pipeline
    pipeline_result = await run_inspection_pipeline(
        cand_bytes=cand_bytes,
        ref_bytes_list=ref_bytes_list,
        product_desc=prod_data.get("description", product_id),
        defect_types=prod_data.get("defect_types", []),
        mode=req.mode,
    )

    t_api_end = time.perf_counter()
    total_ms = elapsed_ms(t_api_start, t_api_end)

    inspection_id = f"insp_{uuid.uuid4().hex[:12]}"
    screen_dict = pipeline_result.get("screen")
    confirm_dict = pipeline_result.get("confirm")
    ai_verdict = pipeline_result.get("ai_verdict", "ok")
    defect = pipeline_result.get("defect")
    where = pipeline_result.get("where")
    confidence = pipeline_result.get("confidence", 0.0)
    created_at_iso = datetime.now(timezone.utc).isoformat()
    dataset_label = gal_data.get("label", "unknown")

    insp_data = {
        "id": inspection_id,
        "product_id": product_id,
        "image_path": gal_data["image_path"],
        "unit_id": None,
        "mode": req.mode,
        "source": "PUBLIC DATA: VisA (CC BY 4.0)",
        "dataset_label": dataset_label,
        "screen": screen_dict,
        "confirm": confirm_dict,
        "ai_verdict": ai_verdict,
        "defect": defect,
        "where": where,
        "confidence": confidence,
        "human_decision": None,
        "decided_by_uid": None,
        "decided_at": None,
        "inspector_uid": user.uid,
        "created_at": created_at_iso,
        "total_ms": total_ms,
    }

    db.collection("inspections").document(inspection_id).set(insp_data)

    stream_inspection_event({
        "ts": created_at_iso,
        "inspection_id": inspection_id,
        "product_id": product_id,
        "unit_id": None,
        "mode": req.mode,
        "ai_verdict": ai_verdict,
        "defect": (confirm_dict or {}).get("defect") or (screen_dict or {}).get("defect"),
        "screen_ms": (screen_dict or {}).get("ms"),
        "confirm_ms": (confirm_dict or {}).get("ms"),
        "total_ms": total_ms,
        "human_decision": None,
        "source": "PUBLIC DATA: VisA (CC BY 4.0)",
    })

    model_ms = ((screen_dict or {}).get("ms", 0)) + ((confirm_dict or {}).get("ms", 0))
    stream_api_call({
        "ts": created_at_iso,
        "endpoint": "inspect_gallery",
        "status": 200,
        "model_ms": model_ms,
        "total_ms": total_ms,
    })

    stages = [s for s in (screen_dict, confirm_dict) if s is not None]

    return {
        "inspection_id": inspection_id,
        "product_id": product_id,
        "ai_verdict": ai_verdict,
        "defect": defect,
        "where": where,
        "confidence": confidence,
        "mode": req.mode,
        "stages": stages,
        "total_ms": total_ms,
        "dataset_label": dataset_label,
        "source": "PUBLIC DATA: VisA (CC BY 4.0)",
    }


@app.get("/api/insights/inspections")
async def get_insights_inspections(
    user: AuthUser = Depends(require_role("supervisor")),
) -> dict[str, Any]:
    """Retrieves supervisor inspection analytics.
    LIVE inspections and PUBLIC DATA VisA gallery trials are strictly separated.
    """
    db = get_firestore_client()
    today_utc_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    insp_docs = (
        db.collection("inspections")
        .order_by("created_at", direction=firestore.Query.DESCENDING)
        .limit(200)
        .stream()
    )

    live_inspections = []
    gallery_inspections = []

    for d in insp_docs:
        data = d.to_dict() or {}
        data["id"] = d.id
        source = data.get("source", "LIVE")
        if source.startswith("PUBLIC DATA"):
            gallery_inspections.append(data)
        else:
            live_inspections.append(data)

    today_live = [
        item for item in live_inspections
        if (item.get("created_at") or "").startswith(today_utc_date)
    ]
    today_count = len(today_live)
    today_ok_count = sum(1 for item in today_live if item.get("ai_verdict") == "ok")
    first_pass_rate = round((today_ok_count / today_count) * 100, 1) if today_count > 0 else None

    defect_counts: dict[str, int] = {}
    for item in live_inspections:
        def_name = item.get("defect")
        if def_name and item.get("ai_verdict") == "defective":
            defect_counts[def_name] = defect_counts.get(def_name, 0) + 1
    top_defect_types = sorted(
        [{"defect": k, "count": v} for k, v in defect_counts.items()],
        key=lambda x: x["count"],
        reverse=True,
    )[:5]

    flagged_awaiting_count = sum(
        1 for item in live_inspections
        if item.get("ai_verdict") == "defective" and not item.get("human_decision")
    )

    recent_live = []
    for item in live_inspections[:10]:
        img_path = item.get("image_path")
        img_url = get_signed_url_for_gs_uri(f"gs://{STORAGE_BUCKET}/{img_path}") if img_path else None
        recent_live.append({
            "id": item.get("id"),
            "unit_id": item.get("unit_id"),
            "product_id": item.get("product_id"),
            "ai_verdict": item.get("ai_verdict"),
            "defect": item.get("defect"),
            "where": item.get("where"),
            "confidence": item.get("confidence"),
            "human_decision": item.get("human_decision"),
            "created_at": item.get("created_at"),
            "image_url": img_url,
        })

    gallery_count = len(gallery_inspections)
    gallery_hits = 0
    for item in gallery_inspections:
        ds_label = (item.get("dataset_label") or "").lower()
        verdict = item.get("ai_verdict")
        is_normal = ds_label == "normal"
        if (is_normal and verdict == "ok") or (not is_normal and verdict == "defective"):
            gallery_hits += 1

    gallery_hit_rate = round((gallery_hits / gallery_count) * 100, 1) if gallery_count > 0 else None

    return {
        "live": {
            "today_count": today_count,
            "first_pass_rate": first_pass_rate,
            "top_defect_types": top_defect_types,
            "flagged_awaiting_count": flagged_awaiting_count,
            "recent": recent_live,
        },
        "gallery": {
            "trials_count": gallery_count,
            "hits_count": gallery_hits,
            "hit_rate": gallery_hit_rate,
            "dataset": "VisA (Amazon), CC BY 4.0",
        },
    }


