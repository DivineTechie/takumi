"""Short spoken alerts: translate a sentence into the floor's language and speak it with Gemini TTS."""

from __future__ import annotations

import asyncio
import io
import logging
import wave

from google.genai import types

from services.api.config import MODEL_FLASH_LITE, MODEL_TTS, TIMEOUT_TRANSLATE_S, TIMEOUT_TTS_S, TTS_VOICE
from services.api.gemini import get_genai_client

logger = logging.getLogger("takumi.speech")

LANGUAGE_NAMES = {
    "en": "English",
    "ja": "Japanese",
    "vi": "Vietnamese",
    "hi": "Hindi",
    "id": "Bahasa Indonesia",
    "fil": "Filipino",
}

MAX_SPOKEN_CHARS = 400


def pcm_to_wav(pcm: bytes, rate: int = 24000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


async def translate_short(text: str, language: str) -> str:
    """Translates one or two short sentences; English is returned unchanged."""
    if language == "en":
        return text
    prompt = (
        f"Translate this factory floor announcement into {LANGUAGE_NAMES[language]}. Keep machine names, alarm codes "
        f"and numbers exactly as written. Reply with the translation only.\n\n{text}"
    )
    resp = await asyncio.wait_for(
        get_genai_client().aio.models.generate_content(model=MODEL_FLASH_LITE, contents=prompt),
        timeout=TIMEOUT_TRANSLATE_S,
    )
    out = (resp.text or "").strip()
    if not out:
        raise RuntimeError("empty translation")
    return out[:MAX_SPOKEN_CHARS]


async def synthesize_speech(text: str, voice: str | None = None) -> bytes:
    """Speaks `text` with Gemini TTS and returns a WAV file (24 kHz mono)."""
    config = types.GenerateContentConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice or TTS_VOICE))
        ),
    )
    resp = await asyncio.wait_for(
        get_genai_client().aio.models.generate_content(model=MODEL_TTS, contents=text[:MAX_SPOKEN_CHARS], config=config),
        timeout=TIMEOUT_TTS_S,
    )
    part = resp.candidates[0].content.parts[0].inline_data
    data = part.data
    # The model returns a complete WAV today; raw PCM is wrapped in case that changes.
    return data if data[:4] == b"RIFF" else pcm_to_wav(data)
