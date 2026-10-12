"""Node 4: verifier - one model check that every step's success criteria are visible facts.

The result is recorded per step for the master: passed, the model's reason and a suggested rewrite
when it is not a visible fact. It changes no text and claims no standard. If the check cannot run,
steps keep no verifier result.
"""

import json
import logging
import time

from pydantic import BaseModel, Field

from services.forge import gemini
from services.forge.config import MODEL_FLASH_LITE, STUDIO_VERIFY_TIMEOUT_S
from services.forge.events import emit
from services.forge.models.state import ForgeState

logger = logging.getLogger("forge.node.verifier")


class CriteriaCheck(BaseModel):
    n: int
    visible_fact: bool = Field(description="True if someone watching the camera could check every part of the criteria.")
    reason: str = Field(description="One short sentence explaining the verdict.")
    suggestion: str = Field(default="", description="The criteria rewritten as visible facts; empty when visible_fact is true.")


class CriteriaReport(BaseModel):
    checks: list[CriteriaCheck]


def verifier_prompt(state: ForgeState) -> str:
    steps = [{"n": s.n, "instruction": s.instruction, "success_criteria": s.success_criteria} for s in state.steps]
    return f"""Each step of this work instruction has success criteria that a camera-based coach will check.
Decide for every step whether its success criteria are visible facts: things a person watching the camera could
check without asking anyone, such as positions, colours, counts, gaps, labels or readings on a display.
Not visible facts: subjective words (properly, correctly, carefully, well, safely, thoroughly, enough), feelings,
sounds, smells, forces or anything hidden from the camera. Do not judge whether the step itself is right.
Steps (JSON):
{json.dumps(steps, ensure_ascii=False)}"""


async def run_verifier(state: ForgeState) -> ForgeState:
    t0 = time.perf_counter()
    emit(state.job_id, "verifier", f"Checking that success criteria are visible facts with {MODEL_FLASH_LITE}", "info")

    try:
        report = await gemini.generate_json(
            MODEL_FLASH_LITE, [verifier_prompt(state)], CriteriaReport,
            timeout_s=STUDIO_VERIFY_TIMEOUT_S, thinking_level="low",
        )
    except gemini.StudioModelError as e:
        emit(state.job_id, "verifier", f"Visible-fact check unavailable: {e}", "warn")
        emit(state.job_id, "verifier", f"Checked 0 of {len(state.steps)} steps", "info", ms=int((time.perf_counter() - t0) * 1000))
        return state

    by_n = {c.n: c for c in report.checks}
    for step in state.steps:
        check = by_n.get(step.n)
        if check is None:
            continue
        step.verifier = {
            "conflict": not check.visible_fact,
            "detail": check.reason.strip(),
            "suggestion": check.suggestion.strip() if not check.visible_fact else "",
        }

    checked = [s for s in state.steps if s.verifier]
    flagged = [s.n for s in checked if s.verifier["conflict"]]
    summary = f"Checked {len(checked)} of {len(state.steps)} steps: {len(checked) - len(flagged)} are visible facts"
    if flagged:
        summary += f"; steps {', '.join(map(str, flagged))} flagged for the master"
    emit(state.job_id, "verifier", summary, "info", ms=int((time.perf_counter() - t0) * 1000))
    return state
