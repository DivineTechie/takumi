"""Node 5: localizer - translates every step into the product languages with Gemini.

One structured call per language (run concurrently): title, instruction, success criteria, why and
hazards. Numbers, units and {placeholders} must stay as written. A language whose call fails or
comes back incomplete is left out of the lesson rather than filled with anything else.
"""

import asyncio
import json
import logging
import re
import time

from pydantic import BaseModel, Field

from services.forge import gemini
from services.forge.config import MODEL_FLASH, STUDIO_TRANSLATE_TIMEOUT_S, SUPPORTED_LANGUAGES
from services.forge.events import emit
from services.forge.models.state import ForgeState, StepData

logger = logging.getLogger("forge.node.localizer")

LANGUAGE_NAMES = {"ja": "Japanese", "vi": "Vietnamese", "hi": "Hindi", "id": "Indonesian (Bahasa Indonesia)", "fil": "Filipino"}
TARGET_LANGUAGES = [lang for lang in SUPPORTED_LANGUAGES if lang != "en"]
NUMBER = re.compile(r"\d+(?:[.,]\d+)?")


class StepText(BaseModel):
    n: int
    title: str = ""
    instruction: str
    success_criteria: str
    why: str = ""
    hazards: list[str] = Field(default_factory=list)


class StepTexts(BaseModel):
    steps: list[StepText]


def source_texts(steps: list[StepData]) -> list[dict]:
    return [
        {"n": s.n, "title": s.title, "instruction": s.instruction, "success_criteria": s.success_criteria,
         "why": s.why, "hazards": s.hazards}
        for s in steps
    ]


def translate_prompt(language: str, steps: list[StepData]) -> str:
    return f"""Translate these work-instruction steps from English into {LANGUAGE_NAMES[language]} for factory trainees.
Keep the meaning exact and the wording short and plain. Keep numbers (with Western digits), units (mm, Nm, °C, V, bar),
part codes, brand or model names and anything inside {{curly braces}} exactly as written. Translate every field of every
step, keep each step's n, and keep the same number of hazards. Empty fields stay empty.
Steps (JSON):
{json.dumps(source_texts(steps), ensure_ascii=False)}"""


def numbers_kept(src: str, dst: str) -> bool:
    """True when every number in the English text also appears in the translation."""
    found = set(NUMBER.findall(dst))
    return all(num in found for num in NUMBER.findall(src))


def check_translation(steps: list[StepData], result: StepTexts) -> dict[int, StepText]:
    """Maps n -> translated text; raises when a step is missing or a required field is empty."""
    by_n = {t.n: t for t in result.steps}
    missing = [s.n for s in steps if s.n not in by_n]
    if missing:
        raise gemini.StudioModelError(f"steps {missing} were missing from the translation")
    for s in steps:
        t = by_n[s.n]
        if not t.instruction.strip() or not t.success_criteria.strip() or (s.why and not t.why.strip()):
            raise gemini.StudioModelError(f"step {s.n} came back with empty fields")
    return by_n


async def translate(state: ForgeState, language: str) -> tuple[str, dict[int, StepText] | None, str, float]:
    t0 = time.perf_counter()
    try:
        result = await gemini.generate_json(
            MODEL_FLASH, [translate_prompt(language, state.steps)], StepTexts,
            timeout_s=STUDIO_TRANSLATE_TIMEOUT_S, thinking_level="low",
        )
        return language, check_translation(state.steps, result), "", time.perf_counter() - t0
    except gemini.StudioModelError as e:
        return language, None, str(e), time.perf_counter() - t0


async def run_localizer(state: ForgeState) -> ForgeState:
    t0 = time.perf_counter()
    names = ", ".join(TARGET_LANGUAGES)
    emit(state.job_id, "localizer", f"Translating {len(state.steps)} steps into {names} with {MODEL_FLASH}", "info")

    results = await asyncio.gather(*(translate(state, lang) for lang in TARGET_LANGUAGES))
    done: list[str] = []
    for language, by_n, error, secs in results:
        if by_n is None:
            emit(state.job_id, "localizer", f"[{language}] not translated: {error}", "warn")
            continue
        changed = []
        for s in state.steps:
            t = by_n[s.n]
            s.translations[language] = {
                "title": t.title.strip(),
                "instruction": t.instruction.strip(),
                "success_criteria": t.success_criteria.strip(),
                "why": t.why.strip(),
                "hazards": [h.strip() for h in t.hazards if h.strip()],
            }
            src = " ".join([s.title, s.instruction, s.success_criteria, s.why, *s.hazards])
            dst = " ".join([t.title, t.instruction, t.success_criteria, t.why, *t.hazards])
            if not numbers_kept(src, dst):
                changed.append(s.n)
        done.append(language)
        emit(state.job_id, "localizer", f"[{language}] translated {len(state.steps)} steps in {secs:.1f} s", "info")
        if changed:
            emit(state.job_id, "localizer", f"[{language}] numbers differ from English in steps {changed}; please check", "warn")

    state.languages = ["en"] + [lang for lang in TARGET_LANGUAGES if lang in done]
    emit(
        state.job_id,
        "localizer",
        f"Lesson available in {len(state.languages)} languages ({', '.join(state.languages)})",
        "info",
        ms=int((time.perf_counter() - t0) * 1000),
    )
    return state
