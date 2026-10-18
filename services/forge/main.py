"""TAKUMI Studio and agents: the Standard Work Studio pipeline and the Google ADK agents."""

from datetime import datetime, timedelta, timezone
import asyncio
import logging
import uuid
from typing import Any, Literal
from fastapi import FastAPI, Depends, BackgroundTasks, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from services.forge.config import (
    AGENT_RUNS_PER_DAY,
    GUEST_AGENT_RUNS_PER_DAY,
    GUEST_POOL_AGENT_RUNS_PER_DAY,
    LOCAL_DEV,
    MOCK_MODELS,
    STUDIO_RUNS_PER_DAY,
    TRACEBACK_TIMEOUT_S,
)
from services.forge.auth import AuthUser, verify_auth_token
from services.forge.models.state import ForgeState
from services.forge.graph.workflow import ForgePipeline
from services.forge.events import get_firestore_client
from services.forge.gemini import StudioModelError

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("forge.main")

app = FastAPI(title="TAKUMI Studio and agents", version="0.2.0")

ID_PATTERN = r"^[A-Za-z0-9._-]{1,64}$"

if LOCAL_DEV:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


# --- Request & Response Models ---

class ForgeJobCreateRequest(BaseModel):
    capture_id: str = Field(..., pattern=ID_PATTERN)


class ForgeJobResponse(BaseModel):
    job_id: str
    skill_id: str


class StepRegenerateRequest(BaseModel):
    skill_id: str = Field(..., pattern=ID_PATTERN)
    n: int = Field(..., ge=1, le=100)
    part: Literal["instruction", "success_criteria", "why"]


# --- Background Pipeline Execution ---

async def execute_forge_job_task(state: ForgeState):
    db = get_firestore_client()
    if db is not None:
        try:
            db.collection("forge_jobs").document(state.job_id).update({
                "status": "running",
            })
        except Exception as e:
            logger.warning("Could not set job status to running: %s", e)

    pipeline = ForgePipeline()
    try:
        await pipeline.execute(state)
    except Exception as e:
        logger.error("Job %s execution failed: %s", state.job_id, e)
        if db is not None:
            mark_job_failed(db, state)


def mark_job_failed(db: Any, state: ForgeState) -> None:
    """Job and capture become 'failed'; the empty placeholder lesson is removed so the library shows nothing fake."""
    now_iso = datetime.now(timezone.utc).isoformat()
    for collection, doc_id, data in (
        ("forge_jobs", state.job_id, {"status": "failed", "finished_at": now_iso}),
        ("captures", state.capture_id, {"status": "failed"}),
    ):
        try:
            db.collection(collection).document(doc_id).update(data)
        except Exception as e:
            logger.warning("Could not mark %s/%s failed: %s", collection, doc_id, e)
    try:
        ref = db.collection("skills").document(state.skill_id)
        snap = ref.get()
        if snap.exists and not (snap.to_dict() or {}).get("steps"):
            ref.delete()
    except Exception as e:
        logger.warning("Could not remove placeholder skill %s: %s", state.skill_id, e)


def _reserve(txn: Any, ref: Any, day: str) -> int | None:
    snap = ref.get(transaction=txn)
    used = int((snap.to_dict() or {}).get("studio_runs", 0)) if snap.exists else 0
    if used >= STUDIO_RUNS_PER_DAY:
        return None
    txn.set(ref, {"studio_runs": used + 1, "day": day}, merge=True)
    return used + 1


def reserve_studio_run(db: Any, uid: str, now: datetime | None = None) -> int | None:
    """Counts one Studio run for the user today (rate_limits/forge_{uid}_{YYYYMMDD}).

    Returns the new count, or None when the daily cap is already reached. Atomic (Firestore transaction).
    """
    from google.cloud import firestore

    day = (now or datetime.now(timezone.utc)).strftime("%Y%m%d")
    ref = db.collection("rate_limits").document(f"forge_{uid}_{day}")
    return firestore.transactional(_reserve)(db.transaction(), ref, day)


def _reserve_agent(txn: Any, ref: Any, pool_ref: Any, limit: int, day: str) -> str | None:
    snap = ref.get(transaction=txn)
    used = int((snap.to_dict() or {}).get("agent_runs", 0)) if snap.exists else 0
    pool_used = 0
    if pool_ref is not None:
        pool_snap = pool_ref.get(transaction=txn)
        pool_used = int((pool_snap.to_dict() or {}).get("agent_runs", 0)) if pool_snap.exists else 0
        if pool_used >= GUEST_POOL_AGENT_RUNS_PER_DAY:
            return "Guest access has reached today's shared limit for agent runs. Please try again tomorrow."
    if used >= limit:
        return f"Daily limit reached ({limit} agent runs per day). Try again tomorrow."
    txn.set(ref, {"agent_runs": used + 1, "day": day}, merge=True)
    if pool_ref is not None:
        txn.set(pool_ref, {"agent_runs": pool_used + 1, "day": day}, merge=True)
    return None


def reserve_agent_run(db: Any, user: AuthUser, now: datetime | None = None) -> None:
    """Counts one agent run for the user today (rate_limits/forge_{uid}_{YYYYMMDD}); guests also count against
    rate_limits/forge_guests_{YYYYMMDD}. Raises 429 when a cap is reached. Atomic (Firestore transaction)."""
    from google.cloud import firestore

    day = (now or datetime.now(timezone.utc)).strftime("%Y%m%d")
    ref = db.collection("rate_limits").document(f"forge_{user.uid}_{day}")
    pool_ref = db.collection("rate_limits").document(f"forge_guests_{day}") if user.guest else None
    limit = min(AGENT_RUNS_PER_DAY, GUEST_AGENT_RUNS_PER_DAY) if user.guest else AGENT_RUNS_PER_DAY
    refused = firestore.transactional(_reserve_agent)(db.transaction(), ref, pool_ref, limit, day)
    if refused:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=refused)


# --- Routes ---

@app.get("/healthz")
@app.get("/forge/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/forge/jobs", response_model=ForgeJobResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_forge_job(
    req: ForgeJobCreateRequest,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(verify_auth_token),
) -> ForgeJobResponse:
    """Starts the Standard Work Studio for the caller's own uploaded capture (masters only).

    Creates forge_jobs/{jobId} and an empty skills/{skillId} for the lesson, then returns immediately.
    Each master can start STUDIO_RUNS_PER_DAY runs per day.
    """
    if user.role != "master":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Master role required")
    db = get_firestore_client()
    if db is None or MOCK_MODELS:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="The Studio is unavailable")
    snap = db.collection("captures").document(req.capture_id).get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Capture not found")
    capture = snap.to_dict() or {}
    if capture.get("master_uid") != user.uid:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This capture belongs to another master")
    if reserve_studio_run(db, user.uid) is None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Daily Studio limit reached ({STUDIO_RUNS_PER_DAY} recordings per day). Try again tomorrow.",
        )

    job_id = f"job_{datetime.now().strftime('%Y%m%d')}_{uuid.uuid4().hex[:8]}"
    skill_id = f"skill_{datetime.now().strftime('%Y%m%d')}_{uuid.uuid4().hex[:8]}"
    now_iso = datetime.now(timezone.utc).isoformat()
    state = ForgeState(job_id=job_id, capture_id=req.capture_id, skill_id=skill_id)

    db.collection("forge_jobs").document(job_id).set({
        "capture_id": req.capture_id,
        "skill_id": skill_id,
        "status": "queued",
        "started_at": now_iso,
        "finished_at": None,
    })
    db.collection("skills").document(skill_id).set({
        "id": skill_id,
        "title": capture.get("skill_title") or "",
        "capture_id": req.capture_id,
        "source_language": capture.get("source_language") or "en",
        "languages": [],
        "status": "in_review",
        "master": dict(state.master_info),
        "safety_rules": [],
        "steps": [],
        "created_at": now_iso,
        "published_at": None,
    })
    db.collection("captures").document(req.capture_id).update({"status": "forging"})

    background_tasks.add_task(execute_forge_job_task, state)
    return ForgeJobResponse(job_id=job_id, skill_id=skill_id)


@app.get("/forge/jobs/{job_id}")
async def get_forge_job(
    job_id: str,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    """Returns the stored status of a Studio job (masters and supervisors)."""
    if user.role not in ("master", "supervisor"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Master or supervisor role required")
    db = get_firestore_client()
    if db is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="The Studio is unavailable")
    snap = db.collection("forge_jobs").document(job_id).get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    return {"job_id": job_id, **(snap.to_dict() or {})}


@app.post("/forge/steps/regenerate")
async def regenerate_step_part(
    req: StepRegenerateRequest,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    """Rewrites one part of one step with Gemini from the stored lesson and the master's narration.

    Returns the new English text and its translations; the master applies it in review (nothing is saved here).
    """
    if user.role != "master":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Master role required")
    db = get_firestore_client()
    if db is None or MOCK_MODELS:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="The Studio is unavailable")
    snap = db.collection("skills").document(req.skill_id).get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lesson not found")
    skill = snap.to_dict() or {}
    step = next((s for s in skill.get("steps") or [] if s.get("n") == req.n), None)
    if step is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Step not found")
    transcript: list[dict] = []
    if skill.get("capture_id"):
        cap = db.collection("captures").document(skill["capture_id"]).get()
        capture = (cap.to_dict() or {}) if cap.exists else {}
        if capture and capture.get("master_uid") != user.uid:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This lesson belongs to another master")
        transcript = list(capture.get("transcript") or [])

    from services.forge.regenerate import regenerate_part

    reserve_agent_run(db, user)
    try:
        result = await regenerate_part(skill, step, req.part, transcript)
    except StudioModelError as e:
        logger.warning("Regenerate failed for %s step %s: %s", req.skill_id, req.n, e)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not regenerate the step")
    return {"skill_id": req.skill_id, "n": req.n, "part": req.part, **result}


# --- Agents ---

class TracebackRequest(BaseModel):
    unit_id: str = Field(..., pattern=r"^[A-Za-z0-9._-]{1,64}$")


@app.post("/forge/agents/traceback")
async def traceback_agent(
    req: TracebackRequest,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    """Runs the ADK quality trace-back agent on a failed unit (supervisors only). Proposes; changes nothing."""
    if user.role != "supervisor":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Supervisor role required")
    db = get_firestore_client()
    if db is None or MOCK_MODELS:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Trace-back agent is unavailable")
    from services.forge.agents.traceback import run_traceback

    reserve_agent_run(db, user)
    try:
        return await asyncio.wait_for(run_traceback(db, req.unit_id, user.uid), timeout=TRACEBACK_TIMEOUT_S)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="Trace-back agent timed out")
    except Exception as e:
        logger.error("Trace-back agent failed for %s: %s", req.unit_id, e)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Trace-back agent failed")


class MaintenanceRequest(BaseModel):
    machine_id: str = Field(..., pattern=r"^[A-Za-z0-9._-]{1,64}$")


# A stop already drafted within this window returns the same work order instead of a second run.
WORK_ORDER_DEDUP_MIN = 60


@app.post("/forge/agents/maintenance")
async def maintenance_agent(
    req: MaintenanceRequest,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    """Runs the ADK maintenance agent on a stopped machine and saves a draft work order (supervisors only)."""
    if user.role != "supervisor":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Supervisor role required")
    db = get_firestore_client()
    if db is None or MOCK_MODELS:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Maintenance agent is unavailable")
    snap = db.collection("machines").document(req.machine_id).get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    machine = snap.to_dict() or {}
    if machine.get("state") != "stopped":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Machine is not stopped")

    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(minutes=WORK_ORDER_DEDUP_MIN)).isoformat()
    for w in db.collection("work_orders").where("machine_id", "==", req.machine_id).stream():
        d = w.to_dict() or {}
        if d.get("status") == "draft" and d.get("alarm_text") == machine.get("last_alarm") and str(d.get("created_at") or "") >= cutoff:
            return {**d, "existing": True}

    from services.forge.agents.maintenance import run_maintenance

    reserve_agent_run(db, user)
    try:
        result = await asyncio.wait_for(run_maintenance(db, req.machine_id, user.uid), timeout=TRACEBACK_TIMEOUT_S)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="Maintenance agent timed out")
    except Exception as e:
        logger.error("Maintenance agent failed for %s: %s", req.machine_id, e)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Maintenance agent failed")

    wo_id = f"wo_{uuid.uuid4().hex[:12]}"
    doc = {
        "id": wo_id,
        "machine_id": req.machine_id,
        "machine_name": machine.get("name"),
        "alarm_text": machine.get("last_alarm"),
        "source": "HOME RIG" if str(machine.get("source", "")).lower() == "virtual" else "LIVE",
        "status": "draft",
        "draft": result["draft"],
        "agent_steps": result["agent_steps"],
        "created_at": now.isoformat(),
        "created_by": user.uid,
        "agent_ms": int((datetime.now(timezone.utc) - now).total_seconds() * 1000),
    }
    db.collection("work_orders").document(wo_id).set(doc)
    return {**doc, "existing": False}


@app.post("/forge/agents/demand")
async def demand_agent(user: AuthUser = Depends(verify_auth_token)) -> dict[str, Any]:
    """Runs the ADK demand agent over today's open orders (supervisors only). Suggests; changes nothing."""
    if user.role != "supervisor":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Supervisor role required")
    db = get_firestore_client()
    if db is None or MOCK_MODELS:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Demand agent is unavailable")
    from services.forge.agents.demand import run_demand

    reserve_agent_run(db, user)
    try:
        return await asyncio.wait_for(run_demand(db, user.uid), timeout=TRACEBACK_TIMEOUT_S)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="Demand agent timed out")
    except Exception as e:
        logger.error("Demand agent failed: %s", e)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Demand agent failed")
