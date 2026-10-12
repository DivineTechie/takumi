"""Offline fakes for Studio tests: a google-genai client, Firestore event capture and a capture state."""

import json
from types import SimpleNamespace

from services.forge.config import MODEL_FLASH, MODEL_FLASH_LITE, MODEL_ROBOTICS_ER, STORAGE_BUCKET
from services.forge.models.state import ForgeState

SEGMENTATION = {
    "steps": [
        {
            "title": "Seat the blue wire", "instruction": "Insert the blue wire into the left terminal and tighten its screw.",
            "success_criteria": "The blue wire's ferrule is inside the left terminal; no bare copper is visible.",
            "why": "The left terminal is neutral, so a swap fails inspection.", "why_from_master": True,
            "why_start_s": 14.0, "why_end_s": 18.5, "safety_note": "Panel power is off before touching terminals.",
            "tools": ["3 mm flat screwdriver"], "common_mistake": "Wire in the middle terminal",
            "mistake_visual_cue": "blue wire entering the second terminal", "point_target": "the left terminal screw",
            "start_s": 2.0, "end_s": 20.0, "key_frame_s": 19.0,
        },
        {
            "title": "Seat the brown wire", "instruction": "Insert the brown wire into the middle terminal and tighten its screw.",
            "success_criteria": "The brown wire is seated properly.",
            "why": "Keeps the conductor order the same on every panel.", "why_from_master": False,
            "tools": ["3 mm flat screwdriver"], "point_target": "the middle terminal screw",
            "start_s": 20.0, "end_s": 41.0, "key_frame_s": 40.0,
        },
        {
            "title": "Tug test", "instruction": "Pull each wire lightly.",
            "success_criteria": "Both wires stay in their terminals after a light pull; 2 wires are visible.",
            "why": "A loose clamp shows up before the panel ships.", "why_from_master": False,
            "point_target": "the two seated wires", "start_s": 41.0, "end_s": 70.0, "key_frame_s": 55.0,
        },
    ],
    "safety_rules": ["Panel power switch is in the OFF position"],
}

LANGUAGE_BY_NAME = {"Japanese": "ja", "Vietnamese": "vi", "Hindi": "hi", "Indonesian": "id", "Filipino": "fil"}


def _translation(prompt: str) -> dict:
    lang = next(code for name, code in LANGUAGE_BY_NAME.items() if f"into {name}" in prompt)
    steps = json.loads(prompt[prompt.index("Steps (JSON):") + len("Steps (JSON):"):])
    return {"steps": [
        {k: ([f"[{lang}] {h}" for h in v] if k == "hazards" else v if k == "n" else f"[{lang}] {v}" if v else "")
         for k, v in s.items()}
        for s in steps
    ]}


def default_answer(model: str, contents: list, config) -> str:
    prompt = next((c for c in contents if isinstance(c, str)), "")
    if model == MODEL_ROBOTICS_ER:
        if "two seated wires" in prompt:
            return json.dumps({"points": []})
        return json.dumps({"points": [{"point": [450, 1200], "label": "screw"}]})
    if model == MODEL_FLASH_LITE:
        return json.dumps({"checks": [
            {"n": 1, "visible_fact": True, "reason": "Ferrule position and copper are visible.", "suggestion": ""},
            {"n": 2, "visible_fact": False, "reason": "'properly' is subjective.", "suggestion": "The brown wire is inside the middle terminal."},
            {"n": 3, "visible_fact": True, "reason": "Wire positions are visible.", "suggestion": ""},
        ]})
    if model == MODEL_FLASH and "Translate these work-instruction steps" in prompt:
        return json.dumps(_translation(prompt))
    if model == MODEL_FLASH:
        return "```json\n" + json.dumps(SEGMENTATION) + "\n```"
    raise AssertionError(f"unexpected model {model}")


class FakeFiles:
    def __init__(self, first_state: str = "ACTIVE"):
        self.first_state = first_state
        self.uploaded: list = []
        self.deleted: list = []

    def _file(self, state: str):
        return SimpleNamespace(name="files/abc", uri="https://generativelanguage.test/files/abc", mime_type="video/webm", state=state)

    async def upload(self, *, file, config=None):
        self.uploaded.append((str(file), config))
        return self._file(self.first_state)

    async def get(self, *, name):
        return self._file("ACTIVE")

    async def delete(self, *, name):
        self.deleted.append(name)


class FakeModels:
    def __init__(self, answer):
        self.answer = answer
        self.calls: list = []

    async def generate_content(self, *, model, contents, config):
        self.calls.append((model, contents, config))
        result = self.answer(model, contents, config)
        if isinstance(result, Exception):
            raise result
        return SimpleNamespace(text=result)


class FakeGenai:
    def __init__(self, answer=default_answer, first_state: str = "ACTIVE"):
        self.files = FakeFiles(first_state)
        self.models = FakeModels(answer)
        self.aio = SimpleNamespace(files=self.files, models=self.models)


class EventLog:
    """Stands in for Firestore in events.emit: records forge_jobs/{job}/events payloads."""

    def __init__(self):
        self.events: list[dict] = []

    def collection(self, name):
        log = self

        class _Doc:
            def collection(self, sub):
                return SimpleNamespace(add=lambda payload: log.events.append(payload))

        return SimpleNamespace(document=lambda _id: _Doc())

    def of(self, agent: str, level: str | None = None) -> list[dict]:
        return [e for e in self.events if e["agent"] == agent and (level is None or e["level"] == level)]


def capture_state(**kw) -> ForgeState:
    base = dict(
        job_id="job_test", capture_id="cap_test", skill_id="skill_test", title="Wire a terminal block",
        source_language="ja", video_uri=f"gs://{STORAGE_BUCKET}/captures/cap_test/master.webm", duration_s=72.0,
        transcript=[
            {"t": 14.0, "speaker": "interviewer", "text": "Why the left one?"},
            {"t": 15.2, "speaker": "master", "text": "Left is neutral."},
            {"t": 16.0, "speaker": "master", "text": "A swap fails inspection."},
        ],
    )
    base.update(kw)
    return ForgeState(**base)
