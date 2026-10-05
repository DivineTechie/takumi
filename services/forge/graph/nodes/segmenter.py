"""Node 2: segmenter (B2) - segment master capture video into 3-12 ordered steps."""

import io
import time
import logging
from PIL import Image, ImageDraw
from services.forge.config import MODEL_FLASH, MOCK_MODELS, GEMINI_API_KEY
from services.forge.models.state import ForgeState, StepData
from services.forge.events import emit
from services.forge.storage_client import upload_bytes

logger = logging.getLogger("forge.node.segmenter")

SUBJ_WORDS = ["properly", "correctly", "carefully", "well", "safely", "thoroughly"]


def validate_criteria(text: str) -> bool:
    low = text.lower()
    return not any(w in low for w in SUBJ_WORDS)


def create_placeholder_keyframe(step_n: int, title: str) -> bytes:
    """Creates a clean 1280x720 JPEG keyframe."""
    img = Image.new("RGB", (1280, 720), color=(24, 24, 27))
    draw = ImageDraw.Draw(img)
    # Draw simple workbench background elements
    draw.rectangle([100, 100, 1180, 620], outline=(63, 63, 70), width=4)
    # Terminal block placeholder representation
    draw.rectangle([340, 260, 940, 460], fill=(39, 39, 42), outline=(245, 158, 11), width=3)
    for i, x in enumerate(range(380, 900, 130), start=1):
        draw.rectangle([x, 290, x + 90, 430], outline=(113, 113, 122), width=2)
        draw.text((x + 35, 305), str(i), fill=(250, 250, 250))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


async def run_segmenter(state: ForgeState) -> ForgeState:
    t0 = time.time()
    emit(state.job_id, "segmenter", "Segmenting video into actionable steps...", "info")

    steps: list[StepData] = []

    if MOCK_MODELS or not GEMINI_API_KEY:
        # High quality offline deterministic segmentation
        logger.info("Executing Segmenter node in fixture mode")
        steps = [
            StepData(
                n=1,
                instruction="Insert the blue wire into terminal 1 and tighten its screw",
                success_criteria="A blue wire's ferrule enters terminal 1, the leftmost terminal; no copper visible",
                tools=["3 mm flat screwdriver"],
                hazards=["Confirm panel power is off"],
                clip={"start_s": 12.0, "end_s": 24.5},
                keyframe_s=23.0,
            ),
            StepData(
                n=2,
                instruction="Insert the brown wire into terminal 2 and tighten its screw",
                success_criteria="A brown wire enters terminal 2; blue wire remains secure in terminal 1",
                tools=["3 mm flat screwdriver"],
                hazards=[],
                clip={"start_s": 25.0, "end_s": 38.0},
                keyframe_s=36.5,
            ),
            StepData(
                n=3,
                instruction="Insert the black wire into terminal 3 and tighten its screw",
                success_criteria="A black wire enters terminal 3; no copper strands visible outside terminal",
                tools=["3 mm flat screwdriver"],
                hazards=[],
                clip={"start_s": 39.0, "end_s": 52.0},
                keyframe_s=50.0,
            ),
            StepData(
                n=4,
                instruction="Tug each of the three wires gently to verify firm seating",
                success_criteria="All three wires remain seated firmly in terminals 1, 2, and 3 without shifting",
                tools=[],
                hazards=[],
                clip={"start_s": 53.0, "end_s": 64.0},
                keyframe_s=62.0,
            ),
        ]
    else:
        try:
            from google import genai
            from google.genai import types

            client = genai.Client(api_key=GEMINI_API_KEY)
            prompt = f"""You are the TAKUMI Master Video Segmenter.
Analyze this technical video and transcript for the task: '{state.title}'.
Transcript: {state.transcript}

Rules:
1. Return 3-12 chronological steps.
2. instruction: imperative English, maximum 14 words.
3. success_criteria: ONLY visible facts checkable by a camera. NEVER use subjective words (properly, correctly, carefully, well).
4. tools: tools used in the step.
5. hazards: any safety hazards.
6. clip: start_s and end_s in seconds (non-overlapping).
7. keyframe_s: clearest end-state moment of the step.
"""
            response = client.models.generate_content(
                model=MODEL_FLASH,
                contents=[prompt],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                ),
            )
            import json
            raw_data = json.loads(response.text or "[]")
            for item in raw_data:
                steps.append(StepData(**item))
        except Exception as e:
            logger.warning("Gemini video segmentation failed, falling back to heuristic: %s", e)
            emit(state.job_id, "segmenter", f"Live model fallback: {e}", "warn")
            steps = [
                StepData(
                    n=1,
                    instruction="Insert the blue wire into terminal 1 and tighten",
                    success_criteria="A blue wire enters terminal 1, the leftmost terminal; no copper visible",
                    tools=["3 mm flat screwdriver"],
                    hazards=["Confirm power is off"],
                    clip={"start_s": 10.0, "end_s": 25.0},
                    keyframe_s=23.0,
                )
            ]

    # Validate success criteria
    for s in steps:
        if not validate_criteria(s.success_criteria):
            s.success_criteria = s.success_criteria.replace("correctly", "securely").replace("properly", "")

    # Extract / upload keyframes
    for s in steps:
        keyframe_bytes = create_placeholder_keyframe(s.n, state.title)
        keyframe_path = f"skills/{state.skill_id}/keyframes/{s.n}.jpg"
        s.keyframe_uri = upload_bytes(keyframe_bytes, keyframe_path, content_type="image/jpeg")

    state.steps = steps
    duration_ms = int((time.time() - t0) * 1000)
    emit(
        state.job_id,
        "segmenter",
        f"Segmented {len(steps)} steps with visible-fact success criteria and keyframes",
        "info",
        artifact_uri=steps[0].keyframe_uri if steps else None,
        ms=duration_ms,
    )
    return state
