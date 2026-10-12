"""Node 1: load_capture - reads the capture (title, language, video, transcript) and makes the MP4 copy."""

import asyncio
import logging
import time

from services.forge.events import emit, get_firestore_client
from services.forge.models.state import ForgeState
from services.forge.transcode import transcode_to_faststart_mp4

logger = logging.getLogger("forge.node.load_capture")


async def run_load_capture(state: ForgeState) -> ForgeState:
    t0 = time.perf_counter()
    emit(state.job_id, "segmenter", "Loading the capture", "info")

    db = get_firestore_client()
    if db is not None:
        snap = db.collection("captures").document(state.capture_id).get()
        if not snap.exists:
            raise LookupError(f"Capture {state.capture_id} was not found")
        capture = snap.to_dict() or {}
        state.title = capture.get("skill_title") or state.title
        state.source_language = capture.get("source_language") or state.source_language
        state.video_uri = capture.get("video_uri") or ""
        state.duration_s = float(capture.get("duration_s") or 0.0)
        state.transcript = list(capture.get("transcript") or [])

    if not state.video_uri:
        raise ValueError("The capture has no video")

    mp4_uri = await asyncio.to_thread(transcode_to_faststart_mp4, state.capture_id, state.video_uri)
    if mp4_uri:
        state.video_uri = mp4_uri
        if db is not None:
            try:
                db.collection("captures").document(state.capture_id).update({"video_uri": mp4_uri})
            except Exception as e:
                logger.warning("Could not update capture video_uri: %s", e)
    else:
        emit(state.job_id, "segmenter", "No MP4 copy of the video could be made; using the original recording", "warn")

    master_lines = sum(1 for t in state.transcript if t.get("speaker") == "master")
    emit(
        state.job_id,
        "segmenter",
        f"Loaded '{state.title}': {len(state.transcript)} transcript lines ({master_lines} from the master)",
        "info",
    )
    logger.info("load_capture took %d ms", int((time.perf_counter() - t0) * 1000))
    return state
