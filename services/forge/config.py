"""Model IDs and runtime configuration for TAKUMI Forge service.

Model IDs live ONLY in services/*/config.py and apps/web/src/config.ts.
Never use Gemini 1.x/2.x names or Imagen.
Do not set temperature (deprecated on 3.6+).
"""

import os

# Approved Google Model IDs
MODEL_FLASH = "gemini-3.8-flash"
MODEL_FLASH_LITE = "gemini-3.5-flash-lite"
MODEL_ROBOTICS_ER = "gemini-robotics-er-2-preview"
MODEL_FLASH_IMAGE = "gemini-3.1-flash-image"
MODEL_VEO = "veo-3.1-fast-generate-preview"
MODEL_OMNI = "gemini-omni-1.1-flash"
MODEL_TTS = "gemini-3.8-flash-tts"

# Environment & Credentials
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GCP_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "takumi-cup-2026")
STORAGE_BUCKET = os.environ.get("STORAGE_BUCKET", "takumi-cup-2026.firebasestorage.app")
LOCAL_DEV = os.environ.get("LOCAL_DEV") == "1"

# Offline / Mock Mode for fast (<5s) deterministic testing
MOCK_MODELS = os.environ.get("MOCK_MODELS", "0") == "1" or not GEMINI_API_KEY

# Pipeline Feature Flags & Budget Guards
FORGE_ENABLE_VERIFIER = os.environ.get("FORGE_ENABLE_VERIFIER", "1") == "1"
FORGE_ENABLE_ILLUSTRATOR = os.environ.get("FORGE_ENABLE_ILLUSTRATOR", "0") == "1"
# Budget guard: at most 3 mistake clips per skill; skip when 0
FORGE_MAX_VIDEO = int(os.environ.get("FORGE_MAX_VIDEO", "0"))

# Target languages for localization
SUPPORTED_LANGUAGES = ["en", "ja", "vi", "hi", "id", "fil"]
