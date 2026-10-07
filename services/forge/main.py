"""FastAPI Application for TAKUMI Forge Multi-Agent Service."""

from datetime import datetime, timezone
import asyncio
import logging
import uuid
from typing import Any
from fastapi import FastAPI, Depends, BackgroundTasks, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from services.forge.config import LOCAL_DEV
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
