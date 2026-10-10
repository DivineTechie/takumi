"""Tests for the Forge multi-agent pipeline (Offline Execution < 5s)."""

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


def test_studio_runs_as_adk_workflow_with_parallel_media_and_stops_on_failure():
    """The Studio is an ADK 2 Workflow graph: media steps run in parallel, and a failing step stops the run."""
    import pytest
    from google.adk.workflow import Workflow

    from services.forge.graph import workflow as wf

    box = wf.StateBox(ForgeState(job_id="job_adk", capture_id="cap_adk", skill_id="skill_adk", title="t", source_language="en"))
    graph = wf.build_studio_workflow(box)
    assert isinstance(graph, Workflow)
    names = [n.name for n in graph.graph.nodes]
    assert names[0] == "__START__" or "load_capture" in names
    for step in ("load_capture", "segmenter", "why_extractor", "spatial_annotator", "verifier", "localizer",
                 "illustrator", "mistake_simulator", "media_done", "publisher"):
        assert step in names

    ran = []

    async def ok(state):
        ran.append("ok")
        return state

    async def boom(state):
        raise ValueError("segmenter exploded")

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(wf, "run_load_capture", ok)
        mp.setattr(wf, "run_segmenter", boom)
        mp.setattr(wf, "run_publisher", ok)
        mp.setattr(wf, "emit", lambda *a, **k: None)
        state = ForgeState(job_id="job_fail", capture_id="cap_fail", skill_id="skill_fail", title="t", source_language="en")
        with pytest.raises(ValueError, match="segmenter exploded"):
            asyncio.run(wf.ForgePipeline().execute(state))
    assert ran == ["ok"]  # nothing after the failing step ran
    assert state.errors and "segmenter exploded" in state.errors[0]
