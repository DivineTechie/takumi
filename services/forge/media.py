"""Local video helpers for the Studio: probe the duration and grab single frames.

Frames stay in memory and are only sent to the model; they are never written to storage.
"""

import io
import json
import logging
import shutil
import subprocess

from PIL import Image

logger = logging.getLogger("forge.media")

FRAME_MAX_SIDE = 1280


def probe_duration_s(path: str) -> float | None:
    """Duration from the container, or None when ffprobe is missing or the file has none (live WebM)."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", path],
            capture_output=True, timeout=30, check=True,
        ).stdout
        value = float(json.loads(out or b"{}").get("format", {}).get("duration"))
        return value if value > 0 else None
    except (subprocess.SubprocessError, ValueError, TypeError, OSError) as e:
        logger.info("No duration from ffprobe for %s: %s", path, e)
        return None


def extract_frame_jpeg(path: str, t_s: float, max_side: int = FRAME_MAX_SIDE) -> bytes | None:
    """One JPEG frame at t_s seconds, scaled so the long side is at most max_side. None if unavailable."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    try:
        raw = subprocess.run(
            [ffmpeg, "-v", "error", "-ss", f"{max(0.0, t_s):.2f}", "-i", path, "-frames:v", "1",
             "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"],
            capture_output=True, timeout=30, check=True,
        ).stdout
    except (subprocess.SubprocessError, OSError) as e:
        logger.info("No frame at %.2fs from %s: %s", t_s, path, e)
        return None
    if not raw:
        return None
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return buf.getvalue()
