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


def blob_path_from_uri(uri: str) -> str:
    """gs://<our bucket>/<path> -> <path>. Media outside the Studio's bucket is refused."""
    prefix = f"gs://{STORAGE_BUCKET}/"
    if not uri or not uri.startswith(prefix) or len(uri) == len(prefix):
        raise ValueError("the capture video is not in the TAKUMI storage bucket")
    return uri[len(prefix):]


def blob_exists(blob_path: str) -> bool:
    """Checks whether a blob exists in the configured Cloud Storage bucket."""
    client = get_storage_client()
    if client is None or LOCAL_DEV or MOCK_MODELS:
        return False
    try:
        bucket = client.bucket(STORAGE_BUCKET)
        blob = bucket.blob(blob_path)
        return blob.exists()
    except Exception as e:
        logger.warning("Error checking if blob %s exists: %s", blob_path, e)
        return False


def blob_size(blob_path: str) -> int | None:
    """Size in bytes, or None when the blob does not exist (or storage is unavailable)."""
    client = get_storage_client()
    if client is None or LOCAL_DEV or MOCK_MODELS:
        return None
    try:
        blob = client.bucket(STORAGE_BUCKET).get_blob(blob_path)
        return int(blob.size) if blob is not None and blob.size is not None else None
    except Exception as e:
        logger.warning("Error reading size of blob %s: %s", blob_path, e)
        return None


def download_blob_to_file(source_blob_path: str, local_filepath: str) -> bool:
    """Downloads a blob from Cloud Storage to a local file path."""
    client = get_storage_client()
    if client is None or LOCAL_DEV or MOCK_MODELS:
        return False
    try:
        bucket = client.bucket(STORAGE_BUCKET)
        blob = bucket.blob(source_blob_path)
        if not blob.exists():
            return False
        blob.download_to_filename(local_filepath)
        return True
    except Exception as e:
        logger.warning("Error downloading blob %s to %s: %s", source_blob_path, local_filepath, e)
        return False


def upload_file(
    local_filepath: str,
    destination_blob_path: str,
    content_type: str = "video/mp4",
) -> bool:
    """Uploads a local file to Cloud Storage. Returns False when the upload did not happen."""
    client = get_storage_client()
    if client is None or LOCAL_DEV or MOCK_MODELS:
        logger.info("Storage unavailable; not uploading %s", destination_blob_path)
        return False
    try:
        bucket = client.bucket(STORAGE_BUCKET)
        blob = bucket.blob(destination_blob_path)
        blob.upload_from_filename(local_filepath, content_type=content_type)
        return True
    except Exception as e:
        logger.error("Failed to upload_file to %s: %s", destination_blob_path, e)
        return False
