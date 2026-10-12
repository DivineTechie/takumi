"""Studio parsing and model-call guards: response schemas, Robotics-ER points, timeouts, retries, no fake defaults."""

import asyncio
import json

import pytest

from services.forge import gemini
from services.forge.graph.nodes import segmenter
from services.forge.graph.nodes.localizer import numbers_kept
from services.forge.graph.nodes.segmenter import Segmentation, to_steps, transcript_text
from services.forge.graph.nodes.spatial_annotator import parse_points
from services.forge.tests.studio_fakes import SEGMENTATION, FakeGenai


def _seg(**overrides) -> dict:
    step = dict(SEGMENTATION["steps"][0])
    step.update(overrides)
    return step


def test_segmentation_answer_parses_from_a_fenced_json_answer():
    seg = gemini.parse_json("```json\n" + json.dumps(SEGMENTATION) + "\n```", Segmentation)
    assert len(seg.steps) == 3 and seg.steps[1].why_start_s is None and seg.safety_rules
    with pytest.raises(gemini.StudioModelError, match="empty"):
        gemini.parse_json("  ", Segmentation)
    with pytest.raises(gemini.StudioModelError, match="structure"):
        gemini.parse_json('{"steps": [{"title": "x"}]}', Segmentation)


def test_to_steps_orders_clamps_and_never_invents():
    seg = Segmentation.model_validate({"steps": [
        _seg(title="later", start_s=30, end_s=200, key_frame_s=500),
        _seg(title="first", start_s=-3, end_s=10, key_frame_s=4, why_from_master=False),
        _seg(title="bad range", start_s=12, end_s=12),
        _seg(title="no criteria", success_criteria="  "),
        _seg(title="quote out of video", start_s=11, end_s=20, why_start_s=500, why_end_s=510),
        _seg(title="no mistake cue", start_s=21, end_s=29, mistake_visual_cue="", safety_note=" "),
    ]})
    steps, notes = to_steps(seg, duration_s=60.0)
    assert [s.title for s in steps] == ["first", "quote out of video", "bad range", "no mistake cue", "later"]
    assert [s.n for s in steps] == [1, 2, 3, 4, 5]
    first, quote, bad, no_cue, later = steps
    assert first.clip == {"start_s": 0.0, "end_s": 10.0} and first.keyframe_s == 4
    assert first.why_source is None and first.why_inferred is True
    assert later.clip == {"start_s": 30, "end_s": 60.0} and later.keyframe_s == 60.0
    assert later.why_source == {"t_start": 14.0, "t_end": 18.5}
    assert bad.clip is None and bad.keyframe_s is None
    assert quote.why_source is None and quote.why_inferred is False
    assert no_cue.common_mistakes == [] and no_cue.hazards == []
    assert any("without an instruction or criteria" in n for n in notes)
    assert any("no valid time range" in n for n in notes)


def test_to_steps_caps_the_step_count_and_reports_it():
    seg = Segmentation.model_validate({"steps": [_seg(start_s=i, end_s=i + 1, key_frame_s=i) for i in range(15)]})
    steps, notes = to_steps(seg, duration_s=None)
    assert len(steps) == 12 and any("kept the first 12" in n for n in notes)


def test_transcript_merges_fragments_and_is_bounded():
    text = transcript_text([
        {"t": 1.0, "speaker": "master", "text": "Strip"},
        {"t": 2.0, "speaker": "master", "text": "eight millimetres."},
        {"t": 3.0, "speaker": "interviewer", "text": "Why?"},
        {"t": 20.0, "speaker": "interviewer", "text": " "},
    ])
    assert text == "[1.0s] master: Strip eight millimetres.\n[3.0s] apprentice: Why?"
    long = transcript_text([{"t": i * 10.0, "speaker": "master", "text": "x" * 500} for i in range(100)])
    assert long.endswith("[transcript cut here]") and len(long) < 21000


def test_parse_points_accepts_robotics_er_shapes_and_clamps():
    assert parse_points('{"points": [{"point": [120, 880], "label": "screw"}]}') == [{"point": [120, 880], "label": "screw"}]
    assert parse_points('```json\n[{"point": [-5, 1500.6], "label": "edge"}]\n```') == [{"point": [0, 1000], "label": "edge"}]
    many = json.dumps([{"point": [i, i], "label": str(i)} for i in range(5)])
    assert [p["label"] for p in parse_points(many)] == ["0", "1", "2"]
    assert parse_points('[{"point": [10]}, {"point": "a,b"}, {"label": "x"}, 7, {"point": [5, 6]}]') == [{"point": [5, 6], "label": ""}]
    assert parse_points("not json") == [] and parse_points("") == [] and parse_points('{"points": []}') == []


def test_numbers_kept_flags_changed_numbers():
    assert numbers_kept("Torque to 45 Nm, strip 8 mm", "45 Nm で締め、8 mm むく")
    assert not numbers_kept("Torque to 45 Nm", "Siết 54 Nm")


def test_no_key_means_no_client(monkeypatch):
    monkeypatch.setattr(gemini, "_client", None)
    monkeypatch.setattr(gemini, "GEMINI_API_KEY", "")
    with pytest.raises(gemini.StudioModelError, match="not configured"):
        gemini.get_client()


def test_model_calls_time_out_without_retrying(monkeypatch):
    calls = []

    async def hang(**kw):
        calls.append(kw["model"])
        await asyncio.sleep(10)

    fake = FakeGenai()
    fake.models.generate_content = hang
    monkeypatch.setattr(gemini, "get_client", lambda: fake)
    with pytest.raises(gemini.StudioTimeout, match="did not answer within 0 s"):
        asyncio.run(gemini.generate_json("m", ["p"], Segmentation, timeout_s=0.05))
    assert calls == ["m"]


def test_model_errors_and_bad_answers_are_retried_once(monkeypatch):
    answers = [RuntimeError("429 RESOURCE_EXHAUSTED"), json.dumps(SEGMENTATION)]
    fake = FakeGenai(lambda model, contents, config: answers.pop(0))
    monkeypatch.setattr(gemini, "get_client", lambda: fake)
    monkeypatch.setattr(gemini, "RETRY_DELAY_S", 0.0)
    assert len(asyncio.run(gemini.generate_json("m", ["p"], Segmentation, timeout_s=5)).steps) == 3

    fake.models.answer = lambda model, contents, config: "{}"
    with pytest.raises(gemini.StudioModelError, match="structure"):
        asyncio.run(gemini.generate_json("m", ["p"], Segmentation, timeout_s=5))
    assert len(fake.models.calls) == 4


def test_wait_until_active_polls_until_the_video_is_processed(monkeypatch):
    fake = FakeGenai(first_state="PROCESSING")
    real_sleep = asyncio.sleep
    monkeypatch.setattr(segmenter.asyncio, "sleep", lambda s: real_sleep(0))
    first = asyncio.run(fake.files.upload(file="v.mp4"))
    assert asyncio.run(segmenter.wait_until_active(fake, first)).state == "ACTIVE"
    failed = first.__class__(**{**vars(first), "state": "FAILED"})
    with pytest.raises(gemini.StudioModelError, match="could not process"):
        asyncio.run(segmenter.wait_until_active(fake, failed))
