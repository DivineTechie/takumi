"""FastAPI Application for TAKUMI Forge Multi-Agent Service."""

from datetime import datetime, timedelta, timezone
import asyncio
import logging
import uuid
from typing import Any
from fastapi import FastAPI, Depends, BackgroundTasks, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from services.forge.config import LOCAL_DEV, MOCK_MODELS, TRACEBACK_TIMEOUT_S
from services.forge.auth import AuthUser, verify_auth_token
from services.forge.models.state import ForgeState
from services.forge.graph.workflow import ForgePipeline
from services.forge.events import get_firestore_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("forge.main")

app = FastAPI(title="TAKUMI Forge Service", version="0.1.0")

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
    capture_id: str


class ForgeJobResponse(BaseModel):
    job_id: str
    skill_id: str


class StepRegenerateRequest(BaseModel):
    skill_id: str
    n: int
    part: str


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
            try:
                db.collection("forge_jobs").document(state.job_id).update({
                    "status": "failed",
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                pass


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
    """Dispatches a Forge agentic pipeline for a completed capture.

    Creates forge_jobs/{jobId} and placeholder skills/{skillId}, then returns immediately.
    """
    job_id = f"job_{datetime.now().strftime('%Y%m%d')}_{uuid.uuid4().hex[:8]}"
    skill_id = f"skill_{datetime.now().strftime('%Y%m%d')}_{uuid.uuid4().hex[:8]}"
    now_iso = datetime.now(timezone.utc).isoformat()

    db = get_firestore_client()
    if db is not None:
        try:
            # 1. Create forge_jobs document
            db.collection("forge_jobs").document(job_id).set({
                "capture_id": req.capture_id,
                "skill_id": skill_id,
                "status": "queued",
                "started_at": now_iso,
                "finished_at": None,
            })

            # 2. Create placeholder skills document
            db.collection("skills").document(skill_id).set({
                "id": skill_id,
                "title": "Analyzing Master Task...",
                "capture_id": req.capture_id,
                "source_language": "ja",
                "languages": ["en", "ja", "vi", "hi", "id", "fil"],
                "status": "in_review",
                "master": {"display_name": "Master Craftsman", "role": "Senior Technician"},
                "safety_rules": [],
                "steps": [],
                "created_at": now_iso,
                "published_at": None,
            })
        except Exception as e:
            logger.warning("Could not create initial Firestore records: %s", e)

    state = ForgeState(
        job_id=job_id,
        capture_id=req.capture_id,
        skill_id=skill_id,
    )

    # Launch background graph processing
    background_tasks.add_task(execute_forge_job_task, state)

    return ForgeJobResponse(job_id=job_id, skill_id=skill_id)


@app.get("/forge/jobs/{job_id}")
async def get_forge_job(
    job_id: str,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    """Retrieves the current status of a Forge job."""
    db = get_firestore_client()
    if db is not None:
        try:
            doc_snap = db.collection("forge_jobs").document(job_id).get()
            if doc_snap.exists:
                return doc_snap.to_dict() or {}
        except Exception as e:
            logger.warning("Failed to read job from Firestore: %s", e)

    return {
        "job_id": job_id,
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
    }


@app.post("/forge/steps/regenerate")
async def regenerate_step_part(
    req: StepRegenerateRequest,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    """Regenerates a specific step attribute (instruction, why, translation, or card)."""
    logger.info("Regenerating step %s part '%s' for skill %s", req.n, req.part, req.skill_id)
    return {
        "success": True,
        "skill_id": req.skill_id,
        "n": req.n,
        "part": req.part,
        "message": f"Successfully regenerated step {req.n} {req.part}",
    }


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

    try:
        return await asyncio.wait_for(run_demand(db, user.uid), timeout=TRACEBACK_TIMEOUT_S)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="Demand agent timed out")
    except Exception as e:
        logger.error("Demand agent failed: %s", e)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Demand agent failed")
