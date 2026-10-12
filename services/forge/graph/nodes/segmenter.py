"""Node 2: segmenter - Gemini watches the master's video (and hears the narration) and writes the steps.

The video is uploaded with the Gemini Files API, used for one generate_content call and deleted.
Each step gets its title, instruction, visible-fact success criteria, the reason (from the master's
words when spoken), a safety note, tools, a likely mistake, the part to point at and its timestamps.
"""

import asyncio
import logging
import os
import time

from google.genai import types
from pydantic import BaseModel, Field

from services.forge import gemini
from services.forge.config import (
    MODEL_FLASH,
    STUDIO_FILE_ACTIVE_TIMEOUT_S,
    STUDIO_MAX_STEPS,
    STUDIO_MAX_VIDEO_MB,
    STUDIO_MAX_VIDEO_S,
    STUDIO_SEGMENT_TIMEOUT_S,
)
from services.forge.events import emit
from services.forge.media import probe_duration_s
from services.forge.models.state import ForgeState, StepData
from services.forge.storage_client import blob_path_from_uri, blob_size, download_blob_to_file

logger = logging.getLogger("forge.node.segmenter")

LANGUAGE_NAMES = {
    "en": "English", "ja": "Japanese", "vi": "Vietnamese", "hi": "Hindi", "id": "Indonesian", "fil": "Filipino",
}
TRANSCRIPT_MAX_CHARS = 20000


class SegmentedStep(BaseModel):
    # Response schema for Gemini: no extra="forbid" (the API rejects additionalProperties).
    title: str = Field(description="Two to five words naming the step.")
    instruction: str = Field(description="One imperative sentence a trainee can follow, at most 20 words.")
    success_criteria: str = Field(
        description="What a camera sees when the step is finished: visible facts only (positions, colours, counts, "
        "readings, parts seated or connected). Never subjective words such as properly, correctly, carefully, well, "
        "safely or thoroughly."
    )
    why: str = Field(description="Why the step matters, one or two sentences.")
    why_from_master: bool = Field(description="True only if the master says this reason in the video.")
    why_start_s: float | None = Field(default=None, description="When the master starts saying the reason; null if not spoken.")
    why_end_s: float | None = Field(default=None, description="When the master finishes saying the reason; null if not spoken.")
    safety_note: str = Field(default="", description="One short sentence on a hazard in this step that is visible or said; empty if none.")
    tools: list[str] = Field(default_factory=list, description="Tools or materials used in this step, as seen or named.")
    common_mistake: str = Field(default="", description="The most likely beginner mistake in this step; empty if none is clear.")
    mistake_visual_cue: str = Field(default="", description="What the camera would see if that mistake happened; empty if none.")
    point_target: str = Field(description="Short noun phrase for the part or area the hands act on, as it looks on camera.")
    start_s: float = Field(description="Step start, seconds from the start of the video.")
    end_s: float = Field(description="Step end, seconds from the start of the video.")
    key_frame_s: float = Field(description="A moment in the step where the worked part is clearly visible, ideally just after it is done.")


class Segmentation(BaseModel):
    steps: list[SegmentedStep]
    safety_rules: list[str] = Field(
        default_factory=list,
        description="Zero to four rules for the whole task, each a visible fact a camera can check (for example "
        "'Safety glasses are on'); only rules the master says or visibly follows.",
    )


def transcript_text(transcript: list[dict]) -> str:
    """Joins the live-transcription fragments into timed lines: '[12.3s] master: ...'."""
    lines: list[list] = []
    last_t = -1e9
    for item in transcript:
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        speaker = "master" if item.get("speaker") == "master" else "apprentice"
        t = float(item.get("t") or 0.0)
        if lines and lines[-1][1] == speaker and t - last_t < 8.0:
            lines[-1][2] += " " + text
        else:
            lines.append([t, speaker, text])
        last_t = t
    out = "\n".join(f"[{t:.1f}s] {speaker}: {text}" for t, speaker, text in lines)
    if len(out) > TRANSCRIPT_MAX_CHARS:
        out = out[:TRANSCRIPT_MAX_CHARS] + "\n[transcript cut here]"
    return out


def build_prompt(state: ForgeState) -> str:
    language = LANGUAGE_NAMES.get(state.source_language, state.source_language)
    narration = transcript_text(state.transcript)
    narration_block = (
        f"Live transcript of the master and an apprentice interviewer (approximate, seconds from the start):\n{narration}"
        if narration
        else "No transcript was recorded; use the speech in the video's audio if there is any."
    )
    return f"""You turn a master's recorded demonstration into a standard work instruction for trainees.
Task title typed by the master: "{state.title}"
The master speaks {language}.
{narration_block}

Watch the whole video and listen to the audio. Split the work into ordered steps (1 to {STUDIO_MAX_STEPS}) where one
physical action ends and the next begins. Write every text field in English.
Rules:
- Describe only what happens in the video or what the master says. Never add steps, tools, numbers, standards or
  reasons that are not shown or said. Leave optional fields empty when you do not know.
- success_criteria are visible facts that a person could check on camera.
- Timestamps are seconds from the start of the video; steps are in order and do not overlap.
- why: use the master's own explanation (in English) when they give one and set why_from_master true with the time
  they say it. Otherwise give the most likely reason from what is shown and set why_from_master false.
- safety_rules apply to the whole task and are visible facts."""


def to_steps(seg: Segmentation, duration_s: float | None) -> tuple[list[StepData], list[str]]:
    """Turns the model's answer into ordered StepData. Returns the steps and notes about anything dropped."""
    notes: list[str] = []
    usable = [s for s in seg.steps if s.instruction.strip() and s.success_criteria.strip()]
    if len(usable) < len(seg.steps):
        notes.append(f"{len(seg.steps) - len(usable)} step(s) without an instruction or criteria were dropped")
    usable.sort(key=lambda s: s.start_s)
    if len(usable) > STUDIO_MAX_STEPS:
        notes.append(f"Gemini returned {len(usable)} steps; kept the first {STUDIO_MAX_STEPS}")
        usable = usable[:STUDIO_MAX_STEPS]

    limit = duration_s if duration_s and duration_s > 0 else None
    steps: list[StepData] = []
    for n, s in enumerate(usable, start=1):
        start = max(0.0, s.start_s)
        end = min(limit, s.end_s) if limit else s.end_s
        clip = None
        keyframe = None
        if end > start:
            clip = {"start_s": round(start, 2), "end_s": round(end, 2)}
            keyframe = round(min(max(s.key_frame_s, start), end), 2)
        else:
            notes.append(f"step {n} had no valid time range ({s.start_s}-{s.end_s} s)")

        why_source = None
        if s.why_from_master and s.why_start_s is not None and s.why_end_s is not None:
            if 0 <= s.why_start_s <= s.why_end_s and (not limit or s.why_start_s <= limit + 1.0):
                why_source = {"t_start": round(s.why_start_s, 2), "t_end": round(s.why_end_s, 2)}

        mistakes = []
        if s.common_mistake.strip() and s.mistake_visual_cue.strip():
            mistakes.append({"description": s.common_mistake.strip(), "visual_cue": s.mistake_visual_cue.strip()})

        steps.append(StepData(
            n=n,
            title=s.title.strip(),
            instruction=s.instruction.strip(),
            success_criteria=s.success_criteria.strip(),
            why=s.why.strip(),
            why_source=why_source,
            why_inferred=not s.why_from_master,
            tools=[t.strip() for t in s.tools if t.strip()],
            hazards=[s.safety_note.strip()] if s.safety_note.strip() else [],
            common_mistakes=mistakes,
            point_hint=s.point_target.strip() or None,
            clip=clip,
            keyframe_s=keyframe,
        ))
    return steps, notes


def fetch_video(state: ForgeState) -> str:
    """Downloads the capture video into the run's work dir after checking its size. Returns the local path."""
    blob = blob_path_from_uri(state.video_uri)
    size = blob_size(blob)
    if size is None:
        raise FileNotFoundError("The capture video was not found in Cloud Storage")
    if size > STUDIO_MAX_VIDEO_MB * 1024 * 1024:
        raise ValueError(f"The capture video is {size // (1024 * 1024)} MB; the Studio accepts up to {STUDIO_MAX_VIDEO_MB} MB")
    work_dir = state.work_dir or "."
    path = os.path.join(work_dir, "master" + os.path.splitext(blob)[1].lower())
    if not download_blob_to_file(blob, path):
        raise FileNotFoundError("The capture video could not be downloaded from Cloud Storage")
    return path


async def wait_until_active(client, file):
    """Polls the uploaded file until Gemini has processed it (bounded)."""
    deadline = time.monotonic() + STUDIO_FILE_ACTIVE_TIMEOUT_S
    while True:
        state = str(getattr(file.state, "value", file.state) or "")
        if state.endswith("ACTIVE"):
            return file
        if state.endswith("FAILED"):
            raise gemini.StudioModelError("Gemini could not process the video file")
        if time.monotonic() > deadline:
            raise gemini.StudioTimeout(f"Gemini did not finish processing the video within {int(STUDIO_FILE_ACTIVE_TIMEOUT_S)} s")
        await asyncio.sleep(3.0)
        try:
            file = await asyncio.wait_for(client.aio.files.get(name=file.name), timeout=30)
        except asyncio.TimeoutError:
            raise gemini.StudioTimeout("Gemini did not report the video file's status in time") from None


async def segment_video(state: ForgeState, path: str) -> Segmentation:
    client = gemini.get_client()
    mime = "video/webm" if path.endswith(".webm") else "video/mp4"
    try:
        file = await asyncio.wait_for(
            client.aio.files.upload(file=path, config=types.UploadFileConfig(mime_type=mime, display_name=state.capture_id)),
            timeout=STUDIO_FILE_ACTIVE_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        raise gemini.StudioTimeout("Uploading the video to Gemini took too long") from None
    try:
        file = await wait_until_active(client, file)
        video = types.Part.from_uri(file_uri=file.uri, mime_type=file.mime_type or mime)
        return await gemini.generate_json(
            MODEL_FLASH, [video, build_prompt(state)], Segmentation, timeout_s=STUDIO_SEGMENT_TIMEOUT_S,
        )
    finally:
        try:
            await asyncio.wait_for(client.aio.files.delete(name=file.name), timeout=30)
        except Exception as e:  # the Files API also expires uploads after 48 h
            logger.warning("Could not delete uploaded video %s: %s", file.name, e)


async def run_segmenter(state: ForgeState) -> ForgeState:
    t0 = time.perf_counter()
    emit(state.job_id, "segmenter", f"Sending the master's video to {MODEL_FLASH}", "info")

    path = await asyncio.to_thread(fetch_video, state)
    duration = await asyncio.to_thread(probe_duration_s, path) or state.duration_s or None
    if duration and duration > STUDIO_MAX_VIDEO_S:
        raise ValueError(f"The video is {duration / 60:.1f} minutes; the Studio accepts up to {STUDIO_MAX_VIDEO_S / 60:.0f} minutes")
    if duration:
        state.duration_s = round(duration, 2)
    state.local_video_path = path

    seg = await segment_video(state, path)
    steps, notes = to_steps(seg, duration)
    if not steps:
        raise gemini.StudioModelError("Gemini found no steps in this video")
    for note in notes:
        emit(state.job_id, "segmenter", note, "warn")

    state.steps = steps
    state.safety_rules = [r.strip() for r in seg.safety_rules if r.strip()]
    spoken = sum(1 for s in steps if s.why_source)
    video = f"{state.duration_s:.0f} s video" if state.duration_s else "video"
    emit(
        state.job_id,
        "segmenter",
        f"{MODEL_FLASH} found {len(steps)} steps in the {video}; "
        f"{spoken} reasons come from the master's own words, {len(state.safety_rules)} safety rules",
        "info",
        ms=int((time.perf_counter() - t0) * 1000),
    )
    return state
