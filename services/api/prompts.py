"""Prompt templates and schemas for TAKUMI AI models.

Contains word-for-word watcher rules, verifier instructions, and pointing prompts.
"""

from enum import Enum
from pydantic import BaseModel, ConfigDict, Field


class WatchState(str, Enum):
    done = "done"
    in_progress = "in_progress"
    mistake = "mistake"
    not_visible = "not_visible"
    hazard = "hazard"


class WatcherResponse(BaseModel):
    state: WatchState = Field(
        ...,
        description="Current state: done, in_progress, mistake, not_visible, or hazard",
    )
    reason: str = Field(
        ...,
        description="Short reason explaining state (maximum 12 words)",
    )
    fix: str = Field(
        ...,
        description="Short corrective action (maximum 10 words, or empty if done)",
    )
    rule: str | None = Field(
        default=None,
        description="When state is hazard, the violated safety_rule copied verbatim from safety_rules; otherwise null",
    )


class VerifierResponse(BaseModel):
    passed: bool = Field(..., description="True if success criteria are met")
    visible: bool = Field(..., description="True if the target area is clearly visible")
    reason: str = Field(..., description="Explanation of verification verdict")
    fix: str = Field(..., description="Corrective action if not passed, else empty")


class PointItem(BaseModel):
    point: list[int] = Field(
        ...,
        description="2D coordinate [y, x] normalized between 0 and 1000, y first",
    )
    label: str = Field(..., description="Label of what is pointed at")


class PointerResponse(BaseModel):
    points: list[PointItem] = Field(
        default_factory=list,
        description="List of at most 3 points [y, x] in range 0-1000",
    )


# WATCHER RULES — kept word for word from specifications:
# 1. judge success_criteria word for word, from what is visible in this frame only;
# 2. "mistake" only when a listed common_mistake's visual_cue is visible;
# 3. "hazard" only when a safety_rule is clearly and visibly violated in this frame; never infer invisible states (for example, power being on);
# 4. "not_visible" when hands, blur or framing hide the relevant area.

WATCHER_PROMPT_TEMPLATE = """You are TAKUMI's live step watcher observing a worker's hands-on manufacturing task frame by frame.

TASK CONTEXT:
Step Number: {step}
Instruction: {instruction}
Success Criteria: {success_criteria}

COMMON MISTAKES:
{common_mistakes_text}

SAFETY RULES:
{safety_rules_text}

EVALUATION RULES:
1. judge success_criteria word for word, from what is visible in this frame only;
2. "mistake" only when a listed common_mistake's visual_cue is visible;
3. "hazard" only when a safety_rule is clearly and visibly violated in this frame; never infer invisible states (for example, power being on);
4. "not_visible" when hands, blur or framing hide the relevant area.

STATE DETERMINATION:
- "done": success_criteria is completely met in this frame.
- "in_progress": worker is actively working towards the step, no mistake or hazard.
- "mistake": a common mistake visual cue is clearly seen.
- "hazard": a safety rule is clearly and visibly violated in this frame. When state is hazard, copy the violated rule exactly into rule.
- "not_visible": relevant work area or parts are occluded, blurred, or outside frame.
If more than one state applies, choose the first in this order: hazard, mistake, done, in_progress, not_visible.

Conciseness: reason must be at most 12 words. fix must be at most 10 words.
Return JSON matching the schema.
"""


VERIFIER_PROMPT_TEMPLATE = """You are TAKUMI's strict verification inspector evaluating whether a manufacturing step was completed accurately.

STEP CONTEXT:
Step Number: {step}
Instruction: {instruction}
Success Criteria: {success_criteria}

SAFETY RULES:
{safety_rules_text}

INSPECTION INSTRUCTIONS:
- Carefully inspect the image to verify whether the success criteria are completely and strictly satisfied.
- Check every attribute named in the success criteria (wire colour, terminal number, position). If any one does not match what you see, passed must be false.
- If a success criterion names a part (for example a ferrule), confirm you can actually see that part. If you cannot see it, passed must be false. Visible bare copper strands mean there is no ferrule.
- Check that no safety rule is visibly violated in this image. Judge only what is visible; a rule whose state cannot be seen (for example, whether power is off) never makes the check fail.
- visible: Set to true if the relevant parts and terminal area are clearly in view, false if occluded, blurry, or missing.
- passed: true ONLY if visible is true, the success criteria are completely met, and no safety rule is visibly violated.
- reason: Clear explanation of your verdict.
- fix: If not passed, concise instruction on what the trainee must correct; empty if passed.

Return JSON matching the schema.
"""


POINTER_PROMPT_TEMPLATE = """You are TAKUMI's spatial pointing system.
Target to identify: "{target}"

Locate the target in the image.
Provide at most 3 key coordinate points marking the target location.
Each point MUST be formatted as [y, x] coordinates normalized to the range 0-1000 (y first, from top 0 to bottom 1000; x from left 0 to right 1000).

Return JSON matching the schema with up to 3 points.
"""


class CitationInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: str = Field(..., description="'transcript' or 'step'")
    t_start: float | None = Field(default=None, description="Start timestamp in seconds if from transcript")
    t_end: float | None = Field(default=None, description="End timestamp in seconds if from transcript")
    step: int | None = Field(default=None, description="Step number if from skill step")
    quote: str | None = Field(default=None, description="Direct quote from the source supporting the answer")


class AskResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answer: str = Field(..., description="1-2 short sentences answering the question in the requested language, naming the master as source.")
    citation: CitationInfo | None = Field(default=None, description="Citation from transcript or step, or null if not covered.")


ASK_MASTER_PROMPT_TEMPLATE = """You are TAKUMI's craftsmanship assistant answering a trainee worker's question on behalf of the master craftsman.

SKILL: {skill_title}
MASTER CRAFTSMAN: {master_name}
TARGET LANGUAGE: {language}

MASTER'S DEMONSTRATION TRANSCRIPT:
{transcript_text}

SKILL STEPS & SAFETY RULES:
{steps_text}

TRAINEE QUESTION:
"{question}"

INSTRUCTIONS:
1. Answer strictly based on the master's transcript, steps, and safety rules above.
2. If the question is NOT covered by or directly supported in the sources above, your answer MUST be:
"The master didn't cover this; please ask your supervisor" (translated naturally into the TARGET LANGUAGE). In this case, set citation to null.
3. Keep the answer concise: 1 to 2 short sentences.
4. Name the master as the source (e.g. "According to the master, ...").
5. If the answer is found in the sources, provide the citation:
   - If from transcript: set type="transcript", with t_start, t_end, and quote.
   - If from a step: set type="step", with step number and quote.
6. Return valid JSON matching the schema.
"""


class InspectionStageResponse(BaseModel):
    defective: bool = Field(..., description="True if a defect is present, false otherwise.")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Confidence score between 0.0 and 1.0.")
    defect: str | None = Field(default=None, description="Short name of the defect or 'none'.")
    where: str | None = Field(default=None, description="Short location of the defect or 'none'.")


def build_inspection_prompt(description: str, defect_types: list[str], stage: str) -> str:
    """Builds the exact factory inspector prompt for screen or confirm stages."""
    defect_types_str = "; ".join(defect_types) if defect_types else "none"
    stage_line = (
        "The first 3 images are known-good reference units. The LAST image is the unit to inspect. Compare it against the references."
        if stage == "screen"
        else "Inspect the unit in the image."
    )
    lines = [
        "You are a strict end-of-line quality inspector in a factory.",
        f"The product is {description}.",
        f"Known defect types for this product: {defect_types_str}.",
        "Any other visible damage, contamination or missing material also counts as a defect.",
        "Normal small variation in position, rotation, lighting and natural texture is NOT a defect.",
        stage_line,
        'Answer in JSON: defective (true/false), confidence (0-1), defect (short name or "none"), where (short location or "none").',
    ]
    return "\n".join(lines)


