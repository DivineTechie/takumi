"""Model IDs used across TAKUMI services.

Model IDs live ONLY in services/*/config.py and apps/web/src/config.ts.
Never use Gemini 1.x/2.x names or Imagen.
Do not set temperature (deprecated on 3.6+).
"""

MODEL_FLASH = "gemini-3.8-flash"
MODEL_FLASH_LITE = "gemini-3.5-flash-lite"
MODEL_LIVE = "gemini-3.8-live"
MODEL_ROBOTICS_ER = "gemini-robotics-er-2-preview"
MODEL_FLASH_IMAGE = "gemini-3.1-flash-image"
MODEL_VEO = "veo-3.1-fast-generate-preview"
MODEL_OMNI = "gemini-omni-1.1-flash"
MODEL_TTS = "gemini-3.8-flash-tts"
MODEL_EMBEDDING = "gemini-embedding-2-preview"
