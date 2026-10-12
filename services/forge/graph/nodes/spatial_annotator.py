"""Node 3: spatial_annotator - Gemini Robotics-ER points at the part each step acts on.

One key frame per step is cut from the video in memory (never stored) and sent with the step's point
target. The first point becomes the step's point_yx ([y, x], 0-1000). When there is no frame or the
call fails, the step simply has no pointer.
"""

import asyncio
import json
import logging
import time
from typing import Any

from google.genai import types
from pydantic import BaseModel, Field

from services.forge import gemini
from services.forge.config import MODEL_ROBOTICS_ER, STUDIO_POINT_TIMEOUT_S
from services.forge.events import emit
from services.forge.media import extract_frame_jpeg
from services.forge.models.state import ForgeState, StepData

logger = logging.getLogger("forge.node.spatial_annotator")

MAX_PARALLEL = 4


class PointItem(BaseModel):
    point: list[int] = Field(description="[y, x] normalized to 0-1000, y first")
    label: str = Field(description="What is pointed at")


class PointerResponse(BaseModel):
    points: list[PointItem] = Field(default_factory=list, description="At most 3 points")


def parse_points(text: str | None) -> list[dict[str, Any]]:
    """Reads Robotics-ER points from {"points": [...]} or a bare list; clamps to 0-1000, keeps at most 3."""
    try:
        data = json.loads(gemini.strip_fence(text))
    except (json.JSONDecodeError, TypeError):
        return []
    items = data.get("points", []) if isinstance(data, dict) else data if isinstance(data, list) else []
    points = []
    for item in items:
        if not isinstance(item, dict):
            continue
        coords = item.get("point")
        if not isinstance(coords, (list, tuple)) or len(coords) < 2:
            continue
        try:
            y, x = (max(0, min(1000, int(round(float(c))))) for c in coords[:2])
        except (TypeError, ValueError):
            continue
        points.append({"point": [y, x], "label": str(item.get("label") or "")})
        if len(points) == 3:
            break
    return points


def pointer_prompt(step: StepData) -> str:
    return (
        f'Point to {step.point_hint} in this image. The worker is doing: "{step.instruction}".\n'
        'Answer as JSON {"points": [{"point": [y, x], "label": "<short label>"}]} with at most 3 points, '
        "y first, both normalized to 0-1000. Return an empty list if it is not visible."
    )


async def point_step(step: StepData, video_path: str) -> tuple[list[int] | None, str]:
    """Returns ([y, x], '') or (None, reason)."""
    if step.keyframe_s is None or not step.point_hint:
        return None, "no key frame time or point target"
    frame = await asyncio.to_thread(extract_frame_jpeg, video_path, step.keyframe_s)
    if not frame:
        return None, "no frame could be read at the key frame time"
    text = await gemini.generate_text(
        MODEL_ROBOTICS_ER,
        [types.Part.from_bytes(data=frame, mime_type="image/jpeg"), pointer_prompt(step)],
        gemini.json_config(PointerResponse),
        timeout_s=STUDIO_POINT_TIMEOUT_S,
    )
    points = parse_points(text)
    if not points:
        return None, "Robotics-ER did not find the target in the frame"
    return points[0]["point"], ""


async def run_spatial_annotator(state: ForgeState) -> ForgeState:
    t0 = time.perf_counter()
    emit(state.job_id, "spatial", f"Pointing at each step's part with {MODEL_ROBOTICS_ER}", "info")

    if not state.local_video_path:
        emit(state.job_id, "spatial", "No local video for key frames; steps have no pointer", "warn")
        emit(state.job_id, "spatial", f"Pointed at 0 of {len(state.steps)} steps", "info", ms=int((time.perf_counter() - t0) * 1000))
        return state

    gate = asyncio.Semaphore(MAX_PARALLEL)

    async def one(step: StepData) -> None:
        async with gate:
            try:
                yx, reason = await point_step(step, state.local_video_path)
            except Exception as e:
                yx, reason = None, str(e)
        step.point_yx = yx
        if yx is None:
            emit(state.job_id, "spatial", f"Step {step.n}: no pointer ({reason[:200]})", "warn")

    await asyncio.gather(*(one(s) for s in state.steps))

    pointed = sum(1 for s in state.steps if s.point_yx)
    emit(
        state.job_id,
        "spatial",
        f"{MODEL_ROBOTICS_ER} pointed at the part in {pointed} of {len(state.steps)} steps (key frames kept in memory only)",
        "info",
        ms=int((time.perf_counter() - t0) * 1000),
    )
    return state
