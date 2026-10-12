"""The Studio graph end to end, offline: Gemini, Cloud Storage and ffmpeg are faked; every result comes from the model fakes."""

import asyncio
import os
import time

import pytest

from services.forge import events, gemini
from services.forge.config import MODEL_FLASH, MODEL_FLASH_LITE, MODEL_ROBOTICS_ER
from services.forge.graph import workflow as wf
from services.forge.graph.nodes import load_capture, segmenter, spatial_annotator
from services.forge.models.state import ForgeState
from services.forge.tests.studio_fakes import EventLog, FakeGenai, capture_state, default_answer

ALL_LANGS = ["en", "ja", "vi", "hi", "id", "fil"]


@pytest.fixture
def studio(monkeypatch):
    """Fakes Gemini, the video in Cloud Storage, ffprobe/ffmpeg and the event store; returns (genai, events, seen)."""
    fake = FakeGenai()
    log = EventLog()
    seen: dict = {"downloads": [], "frames": []}

    def download(blob, path):
        seen["downloads"].append((blob, path))
        with open(path, "wb") as f:
            f.write(b"webm bytes")
        return True

    def frame(path, t_s):
        seen["frames"].append((os.path.exists(path), t_s))
        return b"jpeg bytes"

    monkeypatch.setattr(gemini, "get_client", lambda: fake)
    monkeypatch.setattr(gemini, "RETRY_DELAY_S", 0.0)
    monkeypatch.setattr(events, "get_firestore_client", lambda: log)
    monkeypatch.setattr(load_capture, "transcode_to_faststart_mp4", lambda *_: None)
    monkeypatch.setattr(segmenter, "blob_size", lambda blob: 5 * 1024 * 1024)
    monkeypatch.setattr(segmenter, "download_blob_to_file", download)
    monkeypatch.setattr(segmenter, "probe_duration_s", lambda path: 66.0)
    monkeypatch.setattr(spatial_annotator, "extract_frame_jpeg", frame)
    return fake, log, seen


def test_full_run_uses_only_model_output(studio):
    fake, log, seen = studio
    state = asyncio.run(wf.ForgePipeline().execute(capture_state()))

    # The real video went to Gemini through the Files API and was deleted afterwards.
    assert seen["downloads"][0][0] == "captures/cap_test/master.webm"
    assert fake.files.uploaded[0][0].endswith("master.webm")
    assert fake.files.uploaded[0][1].mime_type == "video/webm"
    assert fake.files.deleted == ["files/abc"]
    seg_calls = [c for c in fake.models.calls if c[0] == MODEL_FLASH and c[1][0].__class__.__name__ == "Part"]
    assert len(seg_calls) == 1
    assert seg_calls[0][1][0].file_data.file_uri == "https://generativelanguage.test/files/abc"
    assert "[15.2s] master: Left is neutral. A swap fails inspection." in seg_calls[0][1][1]

    # Steps are the model's steps, clamped to the probed duration.
    assert [s.n for s in state.steps] == [1, 2, 3]
    s1, s2, s3 = state.steps
    assert s1.title == "Seat the blue wire" and s1.tools == ["3 mm flat screwdriver"]
    assert s1.hazards == ["Panel power is off before touching terminals."]
    assert s1.common_mistakes == [{"description": "Wire in the middle terminal", "visual_cue": "blue wire entering the second terminal"}]
    assert s1.why_source == {"t_start": 14.0, "t_end": 18.5} and s1.why_inferred is False
    assert s2.why_source is None and s2.why_inferred is True and s2.common_mistakes == []
    assert s3.clip == {"start_s": 41.0, "end_s": 66.0}
    assert state.duration_s == 66.0
    assert state.safety_rules == ["Panel power switch is in the OFF position"]

    # Robotics-ER pointed on a real frame (clamped); the step it could not find has no pointer.
    assert s1.point_yx == [450, 1000] and s2.point_yx == [450, 1000]
    assert s3.point_yx is None
    assert all(exists for exists, _ in seen["frames"])
    assert sorted(t for _, t in seen["frames"]) == [19.0, 40.0, 55.0]
    assert sum(1 for c in fake.models.calls if c[0] == MODEL_ROBOTICS_ER) == 3

    # The verifier result is recorded as returned, with no invented citation or standard.
    assert s1.verifier == {"conflict": False, "detail": "Ferrule position and copper are visible.", "suggestion": ""}
    assert s2.verifier["conflict"] is True and s2.verifier["suggestion"] == "The brown wire is inside the middle terminal."
    assert all("citation" not in s.verifier for s in state.steps)
    assert sum(1 for c in fake.models.calls if c[0] == MODEL_FLASH_LITE) == 1

    # One translation call per language; every field translated.
    assert state.languages == ALL_LANGS
    for lang in ALL_LANGS[1:]:
        tr = s1.translations[lang]
        assert tr["instruction"].startswith(f"[{lang}] ") and tr["success_criteria"].startswith(f"[{lang}] ")
        assert tr["title"] and tr["why"] and tr["hazards"] == [f"[{lang}] Panel power is off before touching terminals."]
        assert "audio_uri" not in tr
    assert "en" not in s1.translations

    # Honest events: each node reports a finish with real timing; the temp video is gone.
    for agent in ("segmenter", "spatial", "verifier", "localizer", "publisher"):
        assert any("ms" in e for e in log.of(agent, "info")), agent
    assert any("Step 3: no pointer" in e["message"] for e in log.of("spatial", "warn"))
    assert "pointed at the part in 2 of 3 steps" in log.of("spatial", "info")[-1]["message"]
    assert "steps 2 flagged" in log.of("verifier", "info")[-1]["message"]
    assert not log.of("publisher", "error")
    assert not os.path.exists(seen["downloads"][0][1])
    assert state.work_dir is None and state.local_video_path is None


def test_missing_video_stops_the_run_before_any_model_call(studio, monkeypatch):
    fake, log, _ = studio
    monkeypatch.setattr(segmenter, "blob_size", lambda blob: None)
    with pytest.raises(FileNotFoundError):
        asyncio.run(wf.ForgePipeline().execute(capture_state()))
    assert fake.models.calls == [] and fake.files.uploaded == []
    errors = log.of("segmenter", "error")
    assert len(errors) == 1 and "not found in Cloud Storage" in errors[0]["message"]
    assert not log.of("publisher")


def test_video_limits_are_enforced(studio, monkeypatch):
    fake, log, _ = studio
    monkeypatch.setattr(segmenter, "blob_size", lambda blob: 900 * 1024 * 1024)
    with pytest.raises(ValueError, match="MB"):
        asyncio.run(wf.ForgePipeline().execute(capture_state()))
    monkeypatch.setattr(segmenter, "blob_size", lambda blob: 1024)
    monkeypatch.setattr(segmenter, "probe_duration_s", lambda path: 3600.0)
    with pytest.raises(ValueError, match="minutes"):
        asyncio.run(wf.ForgePipeline().execute(capture_state()))
    assert fake.files.uploaded == []


def test_segmenter_failure_is_reported_and_the_uploaded_file_deleted(studio):
    fake, log, _ = studio
    fake.models.answer = lambda model, contents, config: RuntimeError("503 UNAVAILABLE")
    with pytest.raises(gemini.StudioModelError, match="503 UNAVAILABLE"):
        asyncio.run(wf.ForgePipeline().execute(capture_state()))
    assert len(fake.models.calls) == 2  # one retry
    assert fake.files.deleted == ["files/abc"]
    assert "Stopped:" in log.of("segmenter", "error")[0]["message"]


def test_spatial_failure_leaves_steps_without_pointer(studio):
    fake, log, _ = studio

    def answer(model, contents, config):
        if model == MODEL_ROBOTICS_ER:
            return RuntimeError("robotics down")
        return default_answer(model, contents, config)

    fake.models.answer = answer
    state = asyncio.run(wf.ForgePipeline().execute(capture_state()))
    assert [s.point_yx for s in state.steps] == [None, None, None]
    assert [s.point_hint for s in state.steps][0] == "the left terminal screw"
    assert len(log.of("spatial", "warn")) == 3


def test_verifier_and_localizer_failures_are_recorded_not_filled(studio):
    fake, log, _ = studio

    def answer(model, contents, config):
        prompt = next((c for c in contents if isinstance(c, str)), "")
        if model == MODEL_FLASH_LITE:
            return RuntimeError("lite down")
        if "into Hindi" in prompt:
            return asyncio.TimeoutError()
        if "into Japanese" in prompt:
            return '{"steps": [{"n": 1, "instruction": "x", "success_criteria": "y", "why": "z"}]}'
        return default_answer(model, contents, config)

    fake.models.answer = answer
    state = asyncio.run(wf.ForgePipeline().execute(capture_state()))
    assert all(s.verifier is None for s in state.steps)
    assert any("Visible-fact check unavailable" in e["message"] for e in log.of("verifier", "warn"))
    assert state.languages == ["en", "vi", "id", "fil"]
    assert all("hi" not in s.translations and "ja" not in s.translations for s in state.steps)
    warns = " ".join(e["message"] for e in log.of("localizer", "warn"))
    assert "[hi] not translated" in warns and "[ja] not translated" in warns and "missing" in warns


def test_studio_graph_runs_the_three_checks_in_parallel(monkeypatch):
    from google.adk.workflow import Workflow

    box = wf.StateBox(ForgeState(job_id="j", capture_id="c", skill_id="s"))
    graph = wf.build_studio_workflow(box)
    assert isinstance(graph, Workflow)
    assert [n.name for n in graph.graph.nodes] == [
        "__START__", "load_capture", "segmenter", "spatial_annotator", "verifier", "localizer", "annotated", "publisher",
    ]

    timeline: list = []

    def node(name, delay=0.0):
        async def run(state):
            timeline.append(("start", name))
            await asyncio.sleep(delay)
            timeline.append(("end", name))
            return state
        return run

    monkeypatch.setattr(wf, "emit", lambda *a, **k: None)
    monkeypatch.setattr(wf, "run_load_capture", node("load_capture"))
    monkeypatch.setattr(wf, "run_segmenter", node("segmenter"))
    for name in ("spatial_annotator", "verifier", "localizer"):
        monkeypatch.setattr(wf, f"run_{name}", node(name, 0.05))
    monkeypatch.setattr(wf, "run_publisher", node("publisher"))
    asyncio.run(wf.ForgePipeline().execute(ForgeState(job_id="j", capture_id="c", skill_id="s")))

    parallel = {"spatial_annotator", "verifier", "localizer"}
    first_end = next(i for i, (kind, name) in enumerate(timeline) if kind == "end" and name in parallel)
    assert {name for kind, name in timeline[:first_end] if kind == "start"} >= parallel
    assert timeline[-1] == ("end", "publisher")


def test_a_failing_node_stops_the_graph(monkeypatch):
    ran, emitted = [], []

    async def ok(state):
        ran.append("ok")
        return state

    async def boom(state):
        raise ValueError("segmenter exploded")

    monkeypatch.setattr(wf, "run_load_capture", ok)
    monkeypatch.setattr(wf, "run_segmenter", boom)
    monkeypatch.setattr(wf, "run_publisher", ok)
    monkeypatch.setattr(wf, "emit", lambda *a, **k: emitted.append((a, k)))
    state = ForgeState(job_id="job_fail", capture_id="cap_fail", skill_id="skill_fail")
    with pytest.raises(ValueError, match="segmenter exploded"):
        asyncio.run(wf.ForgePipeline().execute(state))
    assert ran == ["ok"]
    assert state.errors and "segmenter exploded" in state.errors[0]
    assert len(emitted) == 1 and emitted[0][0][1] == "segmenter" and emitted[0][1]["level"] == "error"


def test_the_whole_run_is_bounded(monkeypatch):
    emitted = []

    async def hang(state):
        await asyncio.sleep(30)
        return state

    monkeypatch.setattr(wf, "STUDIO_RUN_TIMEOUT_S", 0.2)
    monkeypatch.setattr(wf, "run_load_capture", hang)
    monkeypatch.setattr(wf, "emit", lambda *a, **k: emitted.append((a, k)))
    t0 = time.perf_counter()
    with pytest.raises(TimeoutError, match="was stopped"):
        asyncio.run(wf.ForgePipeline().execute(ForgeState(job_id="j", capture_id="c", skill_id="s")))
    assert time.perf_counter() - t0 < 5
    assert any(k.get("level") == "error" and "was stopped" in a[2] for a, k in emitted)
