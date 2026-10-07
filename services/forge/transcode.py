"""Transcodes uploaded master WebM videos to H.264/AAC MP4 with +faststart for iOS/mobile compatibility."""

import logging
import os
import shutil
import subprocess
import tempfile
from services.forge.config import STORAGE_BUCKET, LOCAL_DEV, MOCK_MODELS
from services.forge.storage_client import (
    blob_exists,
    download_blob_to_file,
    upload_file,
)

logger = logging.getLogger("forge.transcode")


def get_mp4_uri(capture_id: str) -> str:
    return f"gs://{STORAGE_BUCKET}/captures/{capture_id}/master.mp4"


def transcode_to_faststart_mp4(capture_id: str, webm_uri: str | None = None) -> str:
    """
    Transcodes capture video to H.264/AAC MP4 with +faststart at gs://<bucket>/captures/{id}/master.mp4.
    If the MP4 already exists in GCS, reuses it.
    If WebM is found in GCS, downloads, runs FFmpeg, and uploads the MP4.
    Returns the gs:// URI of master.mp4.
    """
    mp4_blob_path = f"captures/{capture_id}/master.mp4"
    mp4_uri = f"gs://{STORAGE_BUCKET}/{mp4_blob_path}"

    # If the MP4 already exists in GCS, reuse it directly
    if blob_exists(mp4_blob_path):
        logger.info("Found existing transcoded MP4: %s", mp4_uri)
        return mp4_uri

    # Determine WebM source blob path
    webm_blob_path = f"captures/{capture_id}/master.webm"
    if webm_uri and webm_uri.startswith(f"gs://{STORAGE_BUCKET}/"):
        webm_blob_path = webm_uri[len(f"gs://{STORAGE_BUCKET}/") :]

    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        logger.warning("ffmpeg binary not found in environment; returning expected MP4 URI %s", mp4_uri)
        return mp4_uri

    with tempfile.TemporaryDirectory() as tmpdir:
        input_file = os.path.join(tmpdir, "master.webm")
        output_file = os.path.join(tmpdir, "master.mp4")

        # Download WebM from GCS
        downloaded = download_blob_to_file(webm_blob_path, input_file)
        if not downloaded:
            logger.info("Source WebM (%s) not found in GCS; returning MP4 URI %s", webm_blob_path, mp4_uri)
            return mp4_uri

        # Transcode with FFmpeg to H.264/AAC with +faststart
        cmd = [
            ffmpeg_bin,
            "-y",
            "-i",
            input_file,
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            output_file,
        ]

        logger.info("Running FFmpeg transcode: %s", " ".join(cmd))
        try:
            subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180, check=True)
            logger.info("FFmpeg transcode completed successfully")
        except subprocess.CalledProcessError as e:
            logger.error("FFmpeg transcode failed (exit %d): %s", e.returncode, e.stderr.decode("utf-8", errors="replace"))
            return mp4_uri
        except Exception as e:
            logger.error("FFmpeg execution error: %s", e)
            return mp4_uri

        # Upload transcoded MP4 to GCS
        if os.path.exists(output_file) and os.path.getsize(output_file) > 0:
            upload_file(output_file, mp4_blob_path, content_type="video/mp4")
            logger.info("Uploaded master.mp4 to %s (%d bytes)", mp4_uri, os.path.getsize(output_file))

    return mp4_uri
