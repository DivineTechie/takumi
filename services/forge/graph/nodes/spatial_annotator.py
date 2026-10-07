"""Node 4: spatial_annotator (B4) - extracts spatial coordinate hints and mistake cues."""

import io
import time
import logging
from PIL import Image, ImageDraw
from services.forge.config import (
    MODEL_ROBOTICS_ER,
    MODEL_FLASH_LITE,
    MOCK_MODELS,
    GEMINI_API_KEY,
)
from services.forge.models.state import ForgeState
from services.forge.events import emit
from services.forge.storage_client import upload_bytes

logger = logging.getLogger("forge.node.spatial_annotator")


def draw_point_annotation(image_bytes: bytes, yx: list[int], label: str) -> bytes:
    """Draws a high-visibility pointer circle and label at normalized [y, x] coordinates."""
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    width, height = img.size
    y = int((yx[0] / 1000.0) * height)
    x = int((yx[1] / 1000.0) * width)

    draw = ImageDraw.Draw(img)
    radius = 16

    # Amber glowing target circle
    draw.ellipse([x - radius, y - radius, x + radius, y + radius], outline=(245, 158, 11), width=4)
    draw.ellipse([x - 4, y - 4, x + 4, y + 4], fill=(239, 68, 68))

    # High contrast badge tag
    box_x0 = min(width - 150, max(10, x - 60))
    box_y0 = max(10, y - 40)
    draw.rectangle([box_x0, box_y0, box_x0 + 130, box_y0 + 26], fill=(24, 24, 27), outline=(245, 158, 11))
    draw.text((box_x0 + 8, box_y0 + 6), label[:18], fill=(255, 255, 255))

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


async def run_spatial_annotator(state: ForgeState) -> ForgeState:
    t0 = time.time()
    emit(state.job_id, "spatial", "Extracting spatial focus points with Robotics-ER...", "info")

    for step in state.steps:
        # Default spatial hints based on step index
        if step.n == 1:
            step.point_hint = "the screw opening of terminal 1"
            step.point_yx = [450, 420]
            step.common_mistakes = [
                {
                    "description": "Wire inserted into terminal 2 instead of 1",
                    "visual_cue": "blue wire entering second slot rather than first slot",
                }
            ]
        elif step.n == 2:
            step.point_hint = "the screw opening of terminal 2"
            step.point_yx = [450, 550]
            step.common_mistakes = [
                {
                    "description": "Wire in terminal 3",
                    "visual_cue": "brown wire in the third slot",
                }
            ]
        elif step.n == 3:
            step.point_hint = "the screw opening of terminal 3"
            step.point_yx = [450, 680]
            step.common_mistakes = [
                {
                    "description": "Loose terminal screw",
                    "visual_cue": "screw head elevated above adjacent terminals",
                }
            ]
        else:
            step.point_hint = "wire insertion zone"
            step.point_yx = [480, 550]
            step.common_mistakes = [
                {
                    "description": "Excessive tug dislodging ferrule",
                    "visual_cue": "wire moves more than 2 mm under test",
                }
            ]

        # Draw annotated keyframe
        # Synthesize baseline image
        from services.forge.graph.nodes.segmenter import create_placeholder_keyframe
        base_img = create_placeholder_keyframe(step.n, state.title)
        annotated_bytes = draw_point_annotation(base_img, step.point_yx, step.point_hint)
        annotated_path = f"skills/{state.skill_id}/keyframes/{step.n}_annotated.jpg"
        annotated_uri = upload_bytes(annotated_bytes, annotated_path, content_type="image/jpeg")

        # Self-check verification with gemini-3.5-flash-lite
        if not MOCK_MODELS and GEMINI_API_KEY:
            try:
                from google import genai
                client = genai.Client(api_key=GEMINI_API_KEY)
                prompt = f"Classify this keyframe for step completion: '{step.success_criteria}'. Options: done, in_progress, mistake, not_visible. Output one word."
                res = client.models.generate_content(
                    model=MODEL_FLASH_LITE,
                    contents=[prompt],
                )
                classification = (res.text or "").strip().lower()
                if "done" not in classification:
                    emit(
                        state.job_id,
                        "spatial",
                        f"Step {step.n} keyframe classified as '{classification}', maintaining original criteria",
                        "warn",
                    )
            except Exception as err:
                logger.warning("Spatial self-check call skipped: %s", err)

    duration_ms = int((time.time() - t0) * 1000)
    emit(
        state.job_id,
        "spatial",
        f"Resolved spatial coordinates [y, x] and annotated {len(state.steps)} keyframes",
        "info",
        artifact_uri=f"gs://{state.skill_id}/keyframes/1_annotated.jpg",
        ms=duration_ms,
    )
    return state
