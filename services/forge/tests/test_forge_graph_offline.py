"""Tests for Forge ADK Graph Pipeline (Offline Execution < 5s)."""

import asyncio
import time
from services.forge.models.state import ForgeState
from services.forge.graph.workflow import ForgePipeline
from shared.schema.py.skills import Skill


def test_full_graph_runs_offline_under_5_seconds():
    state = ForgeState(
        job_id="job_test_123",
        capture_id="cap_test_456",
        skill_id="skill_test_789",
        title="Wire a DIN-rail terminal block",
        source_language="ja",
    )

    pipeline = ForgePipeline()
    t0 = time.time()
    result_state = asyncio.run(pipeline.execute(state))
    elapsed = time.time() - t0

    # 1. Performance check: must execute offline in under 5 seconds
    assert elapsed < 5.0, f"Pipeline took too long: {elapsed:.2f}s (must be < 5.0s)"

    # 2. Steps check: 3 to 12 ordered steps
    assert 3 <= len(result_state.steps) <= 12
    for idx, step in enumerate(result_state.steps, start=1):
        assert step.n == idx
        # Instruction max 14 words
        assert len(step.instruction.split()) <= 14
        # Visible facts criteria - no subjective words
        for bad_word in ["properly", "correctly", "carefully", "well"]:
            assert bad_word not in step.success_criteria.lower()

        # Spatial coordinates
        assert step.point_hint is not None
        assert step.point_yx is not None
        assert len(step.point_yx) == 2
        assert 0 <= step.point_yx[0] <= 1000
        assert 0 <= step.point_yx[1] <= 1000

        # Why rationale
        assert step.why is not None
        assert len(step.why.split()) <= 30

        # Translations across 6 languages
        for lang in ["en", "ja", "vi", "hi", "id", "fil"]:
            assert lang in step.translations
            assert step.translations[lang]["instruction"]
            assert step.translations[lang]["why"]
            assert step.translations[lang]["audio_uri"].endswith(".wav")


def test_published_skill_conforms_to_shared_schema():
    state = ForgeState(
        job_id="job_schema_check",
        capture_id="cap_schema_check",
        skill_id="skill_terminal_wiring_test",
        title="Wire a DIN-rail terminal block",
        source_language="ja",
    )

    pipeline = ForgePipeline()
    result_state = asyncio.run(pipeline.execute(state))

    # Convert to dictionary and validate with Skill Pydantic model
    step_dicts = [s.model_dump(exclude_none=True) for s in result_state.steps]
    skill_dict = {
        "id": result_state.skill_id,
        "title": result_state.title,
        "capture_id": result_state.capture_id,
        "source_language": result_state.source_language,
        "languages": result_state.languages,
        "status": "in_review",
        "master": {
            "display_name": "Master Craftsman",
            "role": "Senior Technician",
        },
        "video_uri": "gs://takumi-cup-2026.firebasestorage.app/captures/cap_test/master.webm",
        "safety_rules": result_state.safety_rules,
        "steps": step_dicts,
        "created_at": "2026-10-06T10:00:00Z",
        "published_at": None,
    }

    validated_skill = Skill.model_validate(skill_dict)
    assert validated_skill.id == result_state.skill_id
    assert validated_skill.status.value == "in_review"
    assert len(validated_skill.steps) >= 3
