"""Speech helpers: WAV handling and translation shortcut (no model calls)."""

import asyncio
import io
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from services.api import speech


def _client_returning(data):
    part = SimpleNamespace(inline_data=SimpleNamespace(data=data, mime_type="audio/wav"))
    resp = SimpleNamespace(candidates=[SimpleNamespace(content=SimpleNamespace(parts=[part]))])
    gen = AsyncMock(return_value=resp)
    return SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=gen))), gen


def test_pcm_is_wrapped_as_24k_mono_wav():
    with wave.open(io.BytesIO(speech.pcm_to_wav(b"\x00\x00" * 2400))) as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()) == (24000, 1, 2, 2400)


def test_synthesize_keeps_wav_and_wraps_raw_pcm():
    client, gen = _client_returning(b"RIFFxxxxWAVE")
    with patch("services.api.speech.get_genai_client", return_value=client):
        assert asyncio.run(speech.synthesize_speech("hello")) == b"RIFFxxxxWAVE"
    assert gen.await_args.kwargs["model"] == speech.MODEL_TTS
    client, _ = _client_returning(b"\x01\x00" * 10)
    with patch("services.api.speech.get_genai_client", return_value=client):
        assert asyncio.run(speech.synthesize_speech("hello"))[:4] == b"RIFF"


def test_english_is_not_translated():
    with patch("services.api.speech.get_genai_client") as g:
        assert asyncio.run(speech.translate_short("Press 2 stopped.", "en")) == "Press 2 stopped."
        g.assert_not_called()
