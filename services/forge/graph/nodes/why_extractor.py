"""Node 3: why_extractor (B3) - extracts master craftsman rationale from interview transcript."""

import time
import logging
from services.forge.config import MODEL_FLASH, MOCK_MODELS, GEMINI_API_KEY
from services.forge.models.state import ForgeState
from services.forge.events import emit

logger = logging.getLogger("forge.node.why_extractor")


async def run_why_extractor(state: ForgeState) -> ForgeState:
    t0 = time.time()
    emit(state.job_id, "why", "Correlating apprentice interview transcript with steps...", "info")

    if MOCK_MODELS or not GEMINI_API_KEY:
        logger.info("Executing Why Extractor node in fixture mode")
        for step in state.steps:
            if step.n == 1:
                step.why = "Terminal 1 is neutral under IEC colour code. Swapping it fails inspection; ferrules stop strands splaying."
                step.why_source = {"t_start": 40.1, "t_end": 47.9}
                step.why_inferred = False
            elif step.n == 2:
                step.why = "Terminal 2 is line conductor 1. Placing it in the wrong terminal fails inspection; ferrules stop strands splaying."
                step.why_source = {"t_start": 48.0, "t_end": 55.0}
                step.why_inferred = False
            elif step.n == 3:
                step.why = "Terminal 3 is line conductor 2. Consistent wire order prevents phase mismatch in downstream controls."
                step.why_inferred = True  # Inferred rationale
            else:
                step.why = "Gentle tug verification ensures the terminal cage has clamped the ferrule rather than the insulation."
                step.why_inferred = True
    else:
        try:
            from google import genai
            from google.genai import types
            import json

            client = genai.Client(api_key=GEMINI_API_KEY)
            steps_summary = [
                {"n": s.n, "instruction": s.instruction, "clip": s.clip} for s in state.steps
            ]
            prompt = f"""You are the TAKUMI Why-Extractor Agent.
Task: {state.title}
Steps: {json.dumps(steps_summary)}
Transcript: {json.dumps(state.transcript)}

For each step:
1. Match any question/answer from the apprentice interview.
2. Produce 'why': max 30 words, master's own perspective translated to English.
3. If an answer exists, include why_source with t_start and t_end.
4. If no answer exists in the transcript, infer a why from craft knowledge and set why_inferred: true.
Return JSON array with objects: {{ "n": int, "why": str, "why_source": {{"t_start": float, "t_end": float}} | null, "why_inferred": bool }}
"""
            response = client.models.generate_content(
                model=MODEL_FLASH,
                contents=[prompt],
                config=types.GenerateContentConfig(response_mime_type="application/json"),
            )
            data = json.loads(response.text or "[]")
            lookup = {item["n"]: item for item in data if "n" in item}
            for s in state.steps:
                if s.n in lookup:
                    s.why = lookup[s.n].get("why", s.why)
                    s.why_source = lookup[s.n].get("why_source")
                    s.why_inferred = lookup[s.n].get("why_inferred", False)
        except Exception as e:
            logger.warning("Why extraction API call failed: %s", e)
            for s in state.steps:
                if not s.why:
                    s.why = "Required sequence for safety and compliance with assembly guidelines."
                    s.why_inferred = True

    inferred_count = sum(1 for s in state.steps if s.why_inferred)
    duration_ms = int((time.time() - t0) * 1000)
    emit(
        state.job_id,
        "why",
        f"Extracted expert WHY rationale for {len(state.steps)} steps ({inferred_count} flagged as inferred)",
        "info",
        ms=duration_ms,
    )
    return state
