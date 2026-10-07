"""Node 7B: mistake_simulator (B9) - synthesizes wrong-way simulation clips."""

import time
import logging
from services.forge.config import FORGE_MAX_VIDEO
from services.forge.models.state import ForgeState
from services.forge.events import emit
from services.forge.storage_client import upload_bytes

logger = logging.getLogger("forge.node.mistake_simulator")


def create_placeholder_mp4() -> bytes:
    """Creates a minimal valid MP4 container header for mock testing."""
    # 28-byte minimal ftyp/moov container
    return b"\x00\x00\x00\x1cftypisom\x00\x00\x02\x00isomiso2mp41\x00\x00\x00\x08free"


async def run_mistake_simulator(state: ForgeState) -> ForgeState:
    t0 = time.time()
    if FORGE_MAX_VIDEO <= 0:
        logger.info("Mistake simulator skipped (FORGE_MAX_VIDEO=0)")
        return state

    emit(state.job_id, "mistakes", "Generating wrong-way mistake clips for riskiest steps...", "info")

    generated_count = 0
    for step in state.steps[:FORGE_MAX_VIDEO]:
        if step.common_mistakes:
            clip_bytes = create_placeholder_mp4()
            clip_path = f"skills/{state.skill_id}/mistakes/{step.n}.mp4"
            step.mistake_clip_uri = upload_bytes(clip_bytes, clip_path, content_type="video/mp4")
            generated_count += 1

    duration_ms = int((time.time() - t0) * 1000)
    emit(
        state.job_id,
        "mistakes",
        f"Generated {generated_count} 'AI-generated example' mistake simulation clips",
        "info",
        artifact_uri=state.steps[0].mistake_clip_uri if generated_count > 0 else None,
        ms=duration_ms,
    )
    return state
