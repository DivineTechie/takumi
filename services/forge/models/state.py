"""Shared state object passed through the Forge agent graph."""

from typing import Any
from pydantic import BaseModel, Field


class StepData(BaseModel):
    n: int
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
    clip: dict[str, float] = Field(default_factory=lambda: {"start_s": 0.0, "end_s": 10.0})
    keyframe_s: float = 0.0
    keyframe_uri: str | None = None
    card_image_uri: str | None = None
    mistake_clip_uri: str | None = None
    verifier: dict[str, Any] | None = None
    translations: dict[str, dict[str, str]] = Field(default_factory=dict)


class ForgeState(BaseModel):
    job_id: str
    capture_id: str
    skill_id: str
    title: str = ""
    source_language: str = "ja"
    languages: list[str] = Field(default_factory=lambda: ["en", "ja", "vi", "hi", "id", "fil"])
    master_info: dict[str, str] = Field(
        default_factory=lambda: {"display_name": "Master Craftsman", "role": "Senior Technician"}
    )
    video_uri: str = ""
    duration_s: float = 0.0
    transcript: list[dict[str, Any]] = Field(default_factory=list)
    manual_uris: list[str] = Field(default_factory=list)
    file_search_store: str | None = None
    safety_rules: list[str] = Field(default_factory=list)
    steps: list[StepData] = Field(default_factory=list)
    glossary: dict[str, dict[str, str]] = Field(default_factory=dict)
    errors: list[str] = Field(default_factory=list)
