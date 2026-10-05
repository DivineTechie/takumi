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
    model_config = ConfigDict(extra="forbid")
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


class VerifierResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    passed: bool = Field(..., description="True if success criteria are met")
    visible: bool = Field(..., description="True if the target area is clearly visible")
    reason: str = Field(..., description="Explanation of verification verdict")
    fix: str = Field(..., description="Corrective action if not passed, else empty")


class PointItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    point: list[int] = Field(
        ...,
        description="2D coordinate [y, x] normalized between 0 and 1000, y first",
    )
    label: str = Field(..., description="Label of what is pointed at")


class PointerResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
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
- "hazard": a safety rule is clearly and visibly violated in this frame.
- "not_visible": relevant work area or parts are occluded, blurred, or outside frame.

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
- Check that no safety rules are visibly violated.
- visible: Set to true if the relevant parts and terminal area are clearly in view, false if occluded, blurry, or missing.
- passed: Set to true ONLY if visible is true, success criteria are completely fulfilled, and safety rules are respected.
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
