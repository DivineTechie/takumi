"""Cloud Storage client and IAM v4 signed URL generator for TAKUMI."""

from datetime import timedelta
import logging
from typing import Any
import google.auth
import google.auth.transport.requests
from google.cloud import storage

from services.api.config import GCP_PROJECT, STORAGE_BUCKET

logger = logging.getLogger("takumi.storage")

_storage_client: storage.Client | None = None


def get_storage_client() -> storage.Client:
    global _storage_client
    if _storage_client is None:
        _storage_client = storage.Client(project=GCP_PROJECT)
    return _storage_client


def upload_frame_jpeg(session_id: str, event_id: str, jpeg_bytes: bytes) -> str:
    """Uploads a 640px JPEG frame to Cloud Storage and returns the gs:// URI."""
    client = get_storage_client()
    bucket = client.bucket(STORAGE_BUCKET)
    blob_path = f"sessions/{session_id}/frames/{event_id}.jpg"
    blob = bucket.blob(blob_path)
    blob.upload_from_string(jpeg_bytes, content_type="image/jpeg")
    return f"gs://{STORAGE_BUCKET}/{blob_path}"


def get_signed_url_for_gs_uri(gs_uri: str, expires_minutes: int = 15) -> str:
    """Generates a v4 signed HTTPS URL for a gs:// URI using IAM credentials."""
    if not gs_uri or not gs_uri.startswith("gs://"):
        return gs_uri

    parts = gs_uri[5:].split("/", 1)
    if len(parts) != 2:
        return gs_uri
    bucket_name, blob_name = parts[0], parts[1]

    try:
        storage_client = get_storage_client()
        bucket = storage_client.bucket(bucket_name)
        blob = bucket.blob(blob_name)

        # Get service account credentials and refresh access token for IAM signing
        credentials, project = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        auth_req = google.auth.transport.requests.Request()
        if not credentials.valid or credentials.expired:
            credentials.refresh(auth_req)

        sa_email = getattr(credentials, "service_account_email", None)
        if not sa_email or sa_email == "default":
            sa_email = f"takumi-api@{project or GCP_PROJECT}.iam.gserviceaccount.com"

        token = getattr(credentials, "token", None)

        signed_url = blob.generate_signed_url(
            version="v4",
            service_account_email=sa_email,
            access_token=token,
            expiration=timedelta(minutes=expires_minutes),
            method="GET",
        )
        return signed_url
    except Exception as e:
        logger.warning(
            f"Failed to generate signed URL for {gs_uri}: {e}. Falling back to storage URL."
        )
        return f"https://storage.googleapis.com/{bucket_name}/{blob_name}"


_blob_bytes_cache: dict[str, bytes] = {}


def upload_inspection_jpeg(inspection_id: str, jpeg_bytes: bytes) -> str:
    """Uploads a candidate inspection image to Cloud Storage and returns the path inspections/{id}.jpg."""
    client = get_storage_client()
    bucket = client.bucket(STORAGE_BUCKET)
    blob_path = f"inspections/{inspection_id}.jpg"
    blob = bucket.blob(blob_path)
    blob.upload_from_string(jpeg_bytes, content_type="image/jpeg")
    return blob_path


def download_blob_bytes(path_or_uri: str, use_cache: bool = True) -> bytes:
    """Downloads raw bytes from a Cloud Storage path or gs:// URI with optional in-memory caching."""
    if use_cache and path_or_uri in _blob_bytes_cache:
        return _blob_bytes_cache[path_or_uri]

    client = get_storage_client()
    if path_or_uri.startswith("gs://"):
        parts = path_or_uri[5:].split("/", 1)
        bucket_name, blob_name = parts[0], parts[1]
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(blob_name)
    else:
        bucket = client.bucket(STORAGE_BUCKET)
        blob = bucket.blob(path_or_uri)

    data = blob.download_as_bytes()
    if use_cache:
        _blob_bytes_cache[path_or_uri] = data
    return data


def upload_machine_evidence_jpeg(machine_id: str, event_id: str, jpeg_bytes: bytes) -> str:
    """Uploads an HMI alarm evidence crop to Cloud Storage and returns path evidence/machines/{machine_id}/{event_id}.jpg."""
    client = get_storage_client()
    bucket = client.bucket(STORAGE_BUCKET)
    blob_path = f"evidence/machines/{machine_id}/{event_id}.jpg"
    blob = bucket.blob(blob_path)
    blob.upload_from_string(jpeg_bytes, content_type="image/jpeg")
    return blob_path




def upload_blob_bytes(path: str, jpeg_bytes: bytes) -> str:
    """Uploads a JPEG to the bucket at `path` and returns the path."""
    client = get_storage_client()
    client.bucket(STORAGE_BUCKET).blob(path).upload_from_string(jpeg_bytes, content_type="image/jpeg")
    return path
