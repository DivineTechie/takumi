"""Forge multi-agent pipeline (asyncio orchestration of Gemini agents).

Topology:
load_capture
    -> segmenter
    -> why_extractor
    -> spatial_annotator
    -> verifier
    -> localizer
    -> (illustrator || mistake_simulator)
    -> publisher
"""

import asyncio
import time
import logging
from services.forge.models.state import ForgeState
from services.forge.graph.nodes import (
    run_load_capture,
    run_segmenter,
    run_why_extractor,
    run_spatial_annotator,
    run_verifier,
    run_localizer,
    run_illustrator,
    run_mistake_simulator,
    run_publisher,
)
from services.forge.events import emit

logger = logging.getLogger("forge.workflow")


class ForgePipeline:
    """Executes the multi-agent pipeline for transforming a capture into a published skill."""

    async def execute(self, state: ForgeState) -> ForgeState:
        t_start = time.time()
        logger.info("Starting Forge graph pipeline for Job: %s, Capture: %s", state.job_id, state.capture_id)

        try:
            # 1. Load capture
            state = await run_load_capture(state)

            # 2. Segmenter (B2)
            state = await run_segmenter(state)

            # 3. Why Extractor (B3)
            state = await run_why_extractor(state)

            # 4. Spatial Annotator (B4)
            state = await run_spatial_annotator(state)

            # 5. Verifier (B10 - skippable)
            state = await run_verifier(state)

            # 6. Localizer (B5)
            state = await run_localizer(state)

            # 7. Parallel Media Synthesis (B8 Illustrator & B9 Mistake Simulator)
            illustrator_task = asyncio.create_task(run_illustrator(state))
            mistake_task = asyncio.create_task(run_mistake_simulator(state))
            await asyncio.gather(illustrator_task, mistake_task)

            # 8. Publisher (B6)
            state = await run_publisher(state)

            total_ms = int((time.time() - t_start) * 1000)
            logger.info("Forge pipeline completed successfully in %s ms", total_ms)
            return state

        except Exception as e:
            total_ms = int((time.time() - t_start) * 1000)
            logger.exception("Forge pipeline encountered critical failure: %s", e)
            emit(
                state.job_id,
                "publisher",
                f"Pipeline execution failed: {str(e)}",
                level="error",
                ms=total_ms,
            )
            state.errors.append(str(e))
            raise
