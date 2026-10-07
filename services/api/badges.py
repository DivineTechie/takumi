"""Gemini 3.1 Flash Image badge generator and signed URL handler."""

from datetime import timedelta
import logging
from google.cloud import storage

from services.api.config import (
    MODEL_FLASH_IMAGE,
    STORAGE_BUCKET,
)
from services.api.gemini import get_genai_client
from services.api.storage_client import get_signed_url_for_gs_uri, get_storage_client

logger = logging.getLogger("takumi.badges")


def generate_and_store_badge_if_needed(skill_id: str, skill_title: str) -> None:
    """Generates a hanko seal badge via gemini-3.1-flash-image and caches in Cloud Storage.

    Prompt format adheres to specification:
    'A minimalist Japanese hanko-style seal badge, circular, deep vermilion red
    on warm off-white paper texture, abstract motif inspired by: <skill_title>,
    clean vector look, centered, no text, no letters, no numbers, no kanji.'
    """
    try:
        storage_client = get_storage_client()
        bucket = storage_client.bucket(STORAGE_BUCKET)
        blob_path = f"passports/badges/{skill_id}.png"
        blob = bucket.blob(blob_path)

        if blob.exists():
            logger.info("Badge already exists for skill %s at %s", skill_id, blob_path)
            return

        prompt = (
            f"A minimalist Japanese hanko-style seal badge, circular, deep vermilion red "
            f"on warm off-white paper texture, abstract motif inspired by: {skill_title}, "
            f"clean vector look, centered, no text, no letters, no numbers, no kanji."
        )

        client = get_genai_client()
        # Call generate_images with gemini-3.1-flash-image. Do not set temperature.
        response = client.models.generate_images(
            model=MODEL_FLASH_IMAGE,
            prompt=prompt,
        )

        if response and response.generated_images:
            image_bytes = response.generated_images[0].image.image_bytes
            blob.upload_from_string(image_bytes, content_type="image/png")
            logger.info("Successfully uploaded badge for skill %s to %s", skill_id, blob_path)
        else:
            logger.warning("No image returned by model for skill badge %s", skill_id)
    except Exception as e:
        logger.warning("Error generating badge for skill %s: %s", skill_id, e)


def get_badge_signed_url_if_exists(skill_id: str, expires_hours: int = 1) -> str | None:
    """Returns a 1-hour IAM signed URL if the badge exists in Cloud Storage, otherwise None."""
    try:
        storage_client = get_storage_client()
        bucket = storage_client.bucket(STORAGE_BUCKET)
        blob_path = f"passports/badges/{skill_id}.png"
        blob = bucket.blob(blob_path)
        if not blob.exists():
            return None

        gs_uri = f"gs://{STORAGE_BUCKET}/{blob_path}"
        return get_signed_url_for_gs_uri(gs_uri, expires_minutes=expires_hours * 60)
    except Exception as e:
        logger.warning("Failed to check or sign badge for skill %s: %s", skill_id, e)
        return None
