"""Regenerates one part of one step (instruction, success criteria or why) with Gemini.

Uses the stored lesson and the master's transcript around the step, then translates the new text into
the lesson's languages. Nothing is saved here: the master sees the result in review and publishes it.
"""

import json
from typing import Literal

from pydantic import BaseModel, Field

from services.forge import gemini
from services.forge.config import MODEL_FLASH, STUDIO_REGENERATE_TIMEOUT_S
from services.forge.graph.nodes.localizer import LANGUAGE_NAMES
from services.forge.graph.nodes.segmenter import transcript_text

Part = Literal["instruction", "success_criteria", "why"]

RULES = {
    "instruction": "one imperative sentence a trainee can follow, at most 20 words",
    "success_criteria": "what a camera sees when the step is finished, visible facts only, never subjective words "
    "such as properly, correctly, carefully, well, safely or thoroughly",
    "why": "why the step matters in one or two sentences, in the master's own words when the transcript has them",
}


class Translated(BaseModel):
    language: str
    text: str


class Regenerated(BaseModel):
    text: str = Field(description="The new English text.")
    translations: list[Translated] = Field(default_factory=list)


def regenerate_prompt(skill: dict, step: dict, part: Part, transcript: list[dict], languages: list[str]) -> str:
    clip = step.get("clip") or {}
    nearby = [
        t for t in transcript
        if not clip or clip.get("start_s", 0) - 5 <= float(t.get("t") or 0) <= clip.get("end_s", 0) + 5
    ]
    outline = [{"n": s.get("n"), "instruction": s.get("instruction")} for s in skill.get("steps") or []]
    current = {k: step.get(k) for k in ("n", "title", "instruction", "success_criteria", "why", "tools", "hazards", "clip")}
    names = ", ".join(f"{code} ({LANGUAGE_NAMES[code]})" for code in languages)
    return f"""You edit one step of a standard work instruction that was written from a master's video.
Task: "{skill.get('title', '')}"
All steps: {json.dumps(outline, ensure_ascii=False)}
The step to edit: {json.dumps(current, ensure_ascii=False)}
Master's narration around this step (seconds from the start of the video):
{transcript_text(nearby) or "(none recorded)"}

Rewrite the step's {part.replace('_', ' ')} in English: {RULES[part]}.
Use only facts given above; do not add numbers, tools, standards or claims that are not there.
Then translate the new text into {names or "no other languages"}; keep numbers, units and part codes as written."""


async def regenerate_part(skill: dict, step: dict, part: Part, transcript: list[dict]) -> dict:
    languages = [lang for lang in skill.get("languages") or [] if lang in LANGUAGE_NAMES]
    result = await gemini.generate_json(
        MODEL_FLASH,
        [regenerate_prompt(skill, step, part, transcript, languages)],
        Regenerated,
        timeout_s=STUDIO_REGENERATE_TIMEOUT_S,
        thinking_level="low",
    )
    text = result.text.strip()
    if not text:
        raise gemini.StudioModelError("the model returned no text")
    translations = {t.language: t.text.strip() for t in result.translations if t.language in languages and t.text.strip()}
    return {"text": text, "translations": translations}
