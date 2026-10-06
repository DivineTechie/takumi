"""Model IDs and runtime configuration for TAKUMI API service.

Model IDs live ONLY in services/*/config.py and apps/web/src/config.ts.
Never use Gemini 1.x/2.x names or Imagen.
Do not set temperature (deprecated on 3.6+).
"""

import os

# Approved Google Model IDs
MODEL_FLASH = "gemini-3.8-flash"
MODEL_FLASH_LITE = "gemini-3.5-flash-lite"
MODEL_LIVE = "gemini-3.8-live"
MODEL_ROBOTICS_ER = "gemini-robotics-er-2-preview"
MODEL_FLASH_IMAGE = "gemini-3.1-flash-image"
MODEL_VEO = "veo-3.1-fast-generate-preview"
MODEL_OMNI = "gemini-omni-1.1-flash"
MODEL_TTS = "gemini-3.8-flash-tts"
MODEL_EMBEDDING = "gemini-embedding-2-preview"

# Environment & Credentials
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GCP_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "takumi-cup-2026")
LOCAL_DEV = os.environ.get("LOCAL_DEV") == "1"

# Per-User Daily Rate Limits
LIMIT_LIVE_TOKENS_PER_DAY = int(os.environ.get("LIMIT_LIVE_TOKENS_PER_DAY", "60"))
LIMIT_CHECKS_PER_DAY = int(os.environ.get("LIMIT_CHECKS_PER_DAY", "3000"))

# Timeouts in seconds
TIMEOUT_WATCH_S = 6.0
TIMEOUT_VERIFY_S = 15.0
TIMEOUT_POINT_S = 15.0
TIMEOUT_LIVE_TOKEN_S = 10.0

# Request limits
MAX_REQUEST_SIZE_BYTES = 2 * 1024 * 1024  # 2 MB

# Cloud Storage Bucket
STORAGE_BUCKET = os.environ.get("FIREBASE_STORAGE_BUCKET", "takumi-cup-2026.firebasestorage.app")

# Supervisor insight exclusions
EXCLUDED_UIDS = set(
    filter(None, [u.strip() for u in os.environ.get("EXCLUDED_UIDS", "").split(",")])
) | {"smoke-trainee"}
