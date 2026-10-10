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
TIMEOUT_VERIFY_S = 12.0
TIMEOUT_POINT_S = 15.0
TIMEOUT_LIVE_TOKEN_S = 10.0
TIMEOUT_ASK_S = 12.0
TIMEOUT_INSPECT_SCREEN_S = 10.0
TIMEOUT_INSPECT_CONFIRM_S = 30.0
TIMEOUT_MACHINE_SETUP_S = 20.0
TIMEOUT_MACHINE_READ_S = 8.0

# Machine rate & crop limits
LIMIT_MACHINE_READS_PER_MIN = 6
MACHINE_CROP_MAX_PX = 512
MACHINE_CROP_MAX_BYTES = 300 * 1024  # 300 KB

# Inspection image settings
INSPECT_MAX_PX = 1024
INSPECT_JPEG_QUALITY = 90

# Request limits
MAX_REQUEST_SIZE_BYTES = 2 * 1024 * 1024  # 2 MB

# Cloud Storage Bucket
# Pub/Sub topic for operational events (P18); a BigQuery subscription writes them to takumi.events
EVENTS_TOPIC = os.environ.get("EVENTS_TOPIC", "takumi-events").strip()
STORAGE_BUCKET = os.environ.get("FIREBASE_STORAGE_BUCKET", "takumi-cup-2026.firebasestorage.app")
BQ_LOCATION = os.environ.get("BIGQUERY_LOCATION", "asia-southeast1")
SESSIONS_ENABLED = os.environ.get("SESSIONS_ENABLED", "true").lower() in ("true", "1", "yes")

# Supervisor insight exclusions
EXCLUDED_UIDS = set(
    filter(None, [u.strip() for u in os.environ.get("EXCLUDED_UIDS", "").split(",")])
) | {"smoke-trainee"} | {f"loadtest-{i}" for i in range(1, 11)}

# Latency tuning settings (defaults preserve existing production behavior)
VERIFY_THINKING = os.environ.get("VERIFY_THINKING", "default").strip().lower()
VERIFY_MAX_PX = int(os.environ.get("VERIFY_MAX_PX", "1280"))
POINT_THINKING = os.environ.get("POINT_THINKING", "default").strip().lower()

