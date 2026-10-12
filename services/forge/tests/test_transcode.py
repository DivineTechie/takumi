import pytest
from unittest.mock import patch, MagicMock
from services.forge.transcode import transcode_to_faststart_mp4, get_mp4_uri
from services.forge.config import STORAGE_BUCKET


def test_get_mp4_uri():
    uri = get_mp4_uri("cap_test_123")
    assert uri == f"gs://{STORAGE_BUCKET}/captures/cap_test_123/master.mp4"


def test_transcode_existing_blob():
    with patch("services.forge.transcode.blob_exists", return_value=True):
        uri = transcode_to_faststart_mp4("cap_123", "gs://takumi/captures/cap_123/master.webm")
        assert uri == f"gs://{STORAGE_BUCKET}/captures/cap_123/master.mp4"


def test_transcode_runs_ffmpeg(monkeypatch):
    with patch("services.forge.transcode.blob_exists", return_value=False), \
         patch("services.forge.transcode.download_blob_to_file", return_value=True), \
         patch("services.forge.transcode.upload_file", return_value="gs://bucket/path"), \
         patch("shutil.which", return_value="/usr/bin/ffmpeg"), \
         patch("subprocess.run") as mock_run, \
         patch("os.path.exists", return_value=True), \
         patch("os.path.getsize", return_value=1024):

        mock_run.return_value = MagicMock(returncode=0)

        uri = transcode_to_faststart_mp4("cap_abc", f"gs://{STORAGE_BUCKET}/captures/cap_abc/master.webm")
        assert uri == f"gs://{STORAGE_BUCKET}/captures/cap_abc/master.mp4"
        assert mock_run.called
        cmd_args = mock_run.call_args[0][0]
        assert "-c:v" in cmd_args
        assert "libx264" in cmd_args
        assert "+faststart" in cmd_args


def test_transcode_returns_none_when_no_mp4_was_made():
    with patch("services.forge.transcode.blob_exists", return_value=False), patch("shutil.which", return_value=None):
        assert transcode_to_faststart_mp4("cap_x") is None
    with patch("services.forge.transcode.blob_exists", return_value=False), \
         patch("shutil.which", return_value="/usr/bin/ffmpeg"), \
         patch("services.forge.transcode.download_blob_to_file", return_value=False):
        assert transcode_to_faststart_mp4("cap_x") is None
    with patch("services.forge.transcode.blob_exists", return_value=False), \
         patch("services.forge.transcode.download_blob_to_file", return_value=True), \
         patch("services.forge.transcode.upload_file", return_value=False), \
         patch("shutil.which", return_value="/usr/bin/ffmpeg"), \
         patch("subprocess.run", return_value=MagicMock(returncode=0)), \
         patch("os.path.exists", return_value=True), \
         patch("os.path.getsize", return_value=1024):
        assert transcode_to_faststart_mp4("cap_x") is None
