"""Shared state object passed through the Forge agent graph."""

from typing import Any
from pydantic import BaseModel, Field


class StepData(BaseModel):
    n: int
    title: str = ""
    instruction: str
    success_criteria: str
    why: str = ""
    why_source: dict[str, float] | None = None
    why_inferred: bool = False
    tools: list[str] = Field(default_factory=list)
    hazards: list[str] = Field(default_factory=list)
    common_mistakes: list[dict[str, str]] = Field(default_factory=list)
    point_hint: str | None = None
    point_yx: list[int] | None = None
    clip: dict[str, float] | None = None
    keyframe_s: float | None = None
    verifier: dict[str, Any] | None = None
    translations: dict[str, dict[str, Any]] = Field(default_factory=dict)


class ForgeState(BaseModel):
    job_id: str
    capture_id: str
    skill_id: str
    title: str = ""
    source_language: str = "en"
    # Languages the lesson is available in; the localizer adds each language it really translated.
    languages: list[str] = Field(default_factory=lambda: ["en"])
    master_info: dict[str, str] = Field(
        default_factory=lambda: {"display_name": "Master Craftsman", "role": "Senior Technician"}
    )
    video_uri: str = ""
    duration_s: float = 0.0
    transcript: list[dict[str, Any]] = Field(default_factory=list)
    safety_rules: list[str] = Field(default_factory=list)
    steps: list[StepData] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    # Local copy of the video for this run only (a temp dir the pipeline deletes at the end).
    work_dir: str | None = Field(default=None, exclude=True)
    local_video_path: str | None = Field(default=None, exclude=True)
