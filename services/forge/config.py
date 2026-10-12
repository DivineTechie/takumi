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
MODEL_OMNI = "gemini-omni-1.1-flash"
MODEL_TTS = "gemini-3.8-flash-tts"

# Environment & Credentials
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GCP_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "takumi-cup-2026")
STORAGE_BUCKET = os.environ.get("STORAGE_BUCKET", "takumi-cup-2026.firebasestorage.app")
LOCAL_DEV = os.environ.get("LOCAL_DEV") == "1"

# Offline mode (no key or MOCK_MODELS=1): no Firestore, Storage or model clients are created.
MOCK_MODELS = os.environ.get("MOCK_MODELS", "0") == "1" or not GEMINI_API_KEY

# Standard Work Studio limits
STUDIO_MAX_VIDEO_S = float(os.environ.get("STUDIO_MAX_VIDEO_S", "960"))  # 15-minute capture cap + margin
STUDIO_MAX_VIDEO_MB = int(os.environ.get("STUDIO_MAX_VIDEO_MB", "300"))  # Cloud Run instance has 1 GiB of memory
STUDIO_MAX_STEPS = 12
STUDIO_RUNS_PER_DAY = int(os.environ.get("STUDIO_RUNS_PER_DAY", "10"))
# Every model call is bounded; the whole run is bounded too, so a job can never hang.
STUDIO_FILE_ACTIVE_TIMEOUT_S = 300.0
STUDIO_SEGMENT_TIMEOUT_S = 300.0
STUDIO_POINT_TIMEOUT_S = 30.0
STUDIO_VERIFY_TIMEOUT_S = 60.0
STUDIO_TRANSLATE_TIMEOUT_S = 120.0
STUDIO_REGENERATE_TIMEOUT_S = 45.0
STUDIO_RUN_TIMEOUT_S = float(os.environ.get("STUDIO_RUN_TIMEOUT_S", "900"))

# Agents
# Firebase Hosting gives a rewritten request 60 s, so agents must answer (or fail clearly) before that.
TRACEBACK_TIMEOUT_S = float(os.environ.get("TRACEBACK_TIMEOUT_S", "50"))

# Lesson languages; steps are written in English and translated into the others.
SUPPORTED_LANGUAGES = ["en", "ja", "vi", "hi", "id", "fil"]
