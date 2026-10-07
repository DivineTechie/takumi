"""Real-time event streaming for Forge multi-agent pipeline."""

from datetime import datetime, timezone
import logging
try:
    from google.cloud import firestore
except (ImportError, AttributeError):
    firestore = None
from shared.schema.py.forge_job_events import ForgeJobEvent, Agent, Level

from typing import Any

logger = logging.getLogger("forge.events")

_firestore_client: Any = None


from services.forge.config import LOCAL_DEV, MOCK_MODELS


def get_firestore_client() -> Any:
    global _firestore_client
    if _firestore_client is None and firestore is not None and not LOCAL_DEV and not MOCK_MODELS:
        try:
            _firestore_client = firestore.Client()
        except Exception as e:
            logger.warning("Could not initialize Firestore client (running offline?): %s", e)
    return _firestore_client


def emit(
    job_id: str,
    agent: str,
    message: str,
    level: str = "info",
    artifact_uri: str | None = None,
    ms: int | None = None,
) -> dict:
    """Emits a structured progress event to forge_jobs/{job_id}/events.

    Agent Trace UI listens via onSnapshot and renders live DAG glowing status.
    """
    now = datetime.now(timezone.utc)

    # Validate against shared Pydantic model
    event_data = {
        "t": now.isoformat(),
        "agent": agent,
        "level": level,
        "message": message,
        "artifact_uri": artifact_uri,
        "ms": ms,
    }

    try:
        validated = ForgeJobEvent(
            t=now,
            agent=Agent(agent),
            level=Level(level),
            message=message,
            artifact_uri=artifact_uri,
            ms=ms,
        )
        payload = validated.model_dump(mode="json", exclude_none=True)
    except Exception as e:
        logger.error("Failed to validate ForgeJobEvent schema: %s", e)
        payload = {k: v for k, v in event_data.items() if v is not None}

    logger.info("[%s][%s][%s] %s (%sms)", job_id[:8], agent, level.upper(), message, ms or 0)

    db = get_firestore_client()
    if db is not None:
        try:
            events_ref = db.collection("forge_jobs").document(job_id).collection("events")
            events_ref.add(payload)
        except Exception as err:
            logger.warning("Could not write event to Firestore: %s", err)

    return payload
