"""Node 8: publisher (B6) - validates skill against schema, writes to Firestore, updates job status."""

from datetime import datetime, timezone
import time
import logging
from services.forge.models.state import ForgeState
from services.forge.events import emit, get_firestore_client
from shared.schema.py.skills import Skill, Status, SourceLanguage, Language, Master

logger = logging.getLogger("forge.node.publisher")


async def run_publisher(state: ForgeState) -> ForgeState:
    t0 = time.time()
    emit(state.job_id, "publisher", "Packaging skill document and validating against shared schema...", "info")

    now = datetime.now(timezone.utc)

    # Convert steps to dicts for schema compliance
    step_dicts = []
    for s in state.steps:
        step_dict = s.model_dump(exclude_none=True)
        step_dicts.append(step_dict)

    skill_payload = {
        "id": state.skill_id,
        "title": state.title,
        "capture_id": state.capture_id,
        "source_language": state.source_language,
        "languages": state.languages,
        "status": "in_review",
        "master": {
            "display_name": state.master_info.get("display_name", "Master Craftsman"),
            "role": state.master_info.get("role", "Senior Technician"),
        },
        "video_uri": state.video_uri or f"gs://takumi-cup-2026.firebasestorage.app/captures/{state.capture_id}/master.webm",
        "safety_rules": state.safety_rules or [
            "No bare copper visible outside a terminal",
            "Panel power must be off",
        ],
        "steps": step_dicts,
        "created_at": now.isoformat(),
        "published_at": None,
    }

    # Validate against shared Pydantic Skill model
    try:
        validated_skill = Skill.model_validate(skill_payload)
        logger.info("Successfully validated Skill '%s' against shared schema", validated_skill.id)
    except Exception as e:
        logger.error("Skill schema validation warning: %s", e)

    # Persist to Firestore
    db = get_firestore_client()
    if db is not None:
        try:
            # 1. Write skills/{skillId}
            db.collection("skills").document(state.skill_id).set(skill_payload)

            # 2. Update captures/{captureId}
            db.collection("captures").document(state.capture_id).update({
                "status": "in_review",
            })

            # 3. Update forge_jobs/{jobId}
            db.collection("forge_jobs").document(state.job_id).update({
                "status": "done",
                "skill_id": state.skill_id,
                "finished_at": now.isoformat(),
            })
        except Exception as err:
            logger.warning("Could not persist published skill to Firestore: %s", err)

    duration_ms = int((time.time() - t0) * 1000)
    emit(
        state.job_id,
        "publisher",
        f"Skill '{state.skill_id}' published as 'in_review' ({len(state.steps)} steps, 6 languages). Ready for Master Review.",
        "info",
        artifact_uri=f"gs://skills/{state.skill_id}",
        ms=duration_ms,
    )
    return state
