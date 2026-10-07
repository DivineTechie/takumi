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
