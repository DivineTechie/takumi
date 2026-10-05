import logging
try:
    from google.cloud import storage
except (ImportError, AttributeError):
    storage = None
from services.forge.config import STORAGE_BUCKET, LOCAL_DEV, MOCK_MODELS

from typing import Any

logger = logging.getLogger("forge.storage")

_storage_client: Any = None


def get_storage_client() -> Any:
    global _storage_client
    if _storage_client is None and storage is not None and not LOCAL_DEV and not MOCK_MODELS:
        try:
            _storage_client = storage.Client()
        except Exception as e:
            logger.warning("Could not initialize Storage client: %s", e)
    return _storage_client


def upload_bytes(
    data: bytes,
    destination_blob_path: str,
    content_type: str = "image/jpeg",
) -> str:
    """Uploads bytes to the configured Cloud Storage bucket and returns gs:// URI."""
    gs_uri = f"gs://{STORAGE_BUCKET}/{destination_blob_path}"

    client = get_storage_client()
    if client is None or LOCAL_DEV or MOCK_MODELS:
        logger.info("Local/Mock upload to %s (%s bytes)", gs_uri, len(data))
        return gs_uri

    try:
        bucket = client.bucket(STORAGE_BUCKET)
        blob = bucket.blob(destination_blob_path)
        blob.upload_from_string(data, content_type=content_type)
        return gs_uri
    except Exception as e:
        logger.error("Failed to upload to %s: %s", gs_uri, e)
        return gs_uri
