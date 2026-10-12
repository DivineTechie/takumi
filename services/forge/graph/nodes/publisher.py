"""Node 6: publisher - validates the skill against the shared schema and saves it for the master's review."""

from datetime import datetime, timezone
import logging
import time

from services.forge.events import emit, get_firestore_client
from services.forge.models.state import ForgeState
from shared.schema.py.skills import Skill

logger = logging.getLogger("forge.node.publisher")


def skill_payload(state: ForgeState, now: datetime) -> dict:
    return {
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
        "video_uri": state.video_uri,
        "safety_rules": state.safety_rules,
        "steps": [s.model_dump(exclude_none=True) for s in state.steps],
        "created_at": now.isoformat(),
        "published_at": None,
    }


async def run_publisher(state: ForgeState) -> ForgeState:
    t0 = time.perf_counter()
    emit(state.job_id, "publisher", "Validating the lesson against the shared skill schema", "info")

    now = datetime.now(timezone.utc)
    payload = skill_payload(state, now)
    try:
        Skill.model_validate(payload)
    except Exception as e:
        raise ValueError(f"The lesson does not match the skill schema: {str(e)[:300]}") from e

    db = get_firestore_client()
    if db is not None:
        db.collection("skills").document(state.skill_id).set(payload)
        db.collection("captures").document(state.capture_id).update({"status": "in_review"})
        db.collection("forge_jobs").document(state.job_id).update({
            "status": "done",
            "skill_id": state.skill_id,
            "finished_at": now.isoformat(),
        })

    emit(
        state.job_id,
        "publisher",
        f"Saved {len(state.steps)} steps in {len(state.languages)} languages for the master's review",
        "info",
        ms=int((time.perf_counter() - t0) * 1000),
    )
    return state
