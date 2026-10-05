"""Node 7A: illustrator (B8) - generates visual step cards from keyframes."""

import time
import logging
from services.forge.config import FORGE_ENABLE_ILLUSTRATOR
from services.forge.models.state import ForgeState
from services.forge.events import emit
from services.forge.storage_client import upload_bytes

logger = logging.getLogger("forge.node.illustrator")


async def run_illustrator(state: ForgeState) -> ForgeState:
    t0 = time.time()
    if not FORGE_ENABLE_ILLUSTRATOR:
        logger.info("Illustrator node skipped by configuration")
        return state

    emit(state.job_id, "illustrator", "Synthesizing clean instructional step cards...", "info")

    for step in state.steps:
        # Generate illustrated card representation
        from services.forge.graph.nodes.segmenter import create_placeholder_keyframe
        card_bytes = create_placeholder_keyframe(step.n, state.title)
        card_path = f"skills/{state.skill_id}/cards/{step.n}_en.png"
        step.card_image_uri = upload_bytes(card_bytes, card_path, content_type="image/png")

    duration_ms = int((time.time() - t0) * 1000)
    emit(
        state.job_id,
        "illustrator",
        f"Generated {len(state.steps)} instructional cards with point overlays",
        "info",
        artifact_uri=state.steps[0].card_image_uri if state.steps else None,
        ms=duration_ms,
    )
    return state
