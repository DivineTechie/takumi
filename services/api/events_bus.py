"""Operational event bus (P18): every factory event is published to Pub/Sub topic `takumi-events`.

A BigQuery subscription writes the messages into `takumi.events` (one row per event, same columns as
the message), which the control tower queries. Publishing is fire-and-forget: a Pub/Sub problem is
logged and never fails or slows the request that produced the event (Firestore stays the source of
truth for the app).
"""

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from services.api.config import EVENTS_TOPIC, GCP_PROJECT

logger = logging.getLogger("takumi.events_bus")

_publisher: Any = None

KINDS = ("station", "inspection", "machine", "unit")


def normalise_source(source: str | None) -> str:
    """Every event carries LIVE, HOME RIG or a PUBLIC DATA label."""
    s = (source or "").strip()
    if s.upper().startswith("PUBLIC DATA"):
        return s
    if s.upper() == "HOME RIG":
        return "HOME RIG"
    return "LIVE"


def build_event(
    kind: str,
    event_type: str,
    *,
    source: str | None = None,
    ts: str | None = None,
    entity_id: str | None = None,
    unit_id: str | None = None,
    machine_id: str | None = None,
    product_id: str | None = None,
    station: str | None = None,
    step: int | None = None,
    status: str | None = None,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Builds one event row; the keys match the `takumi.events` BigQuery columns exactly."""
    if kind not in KINDS:
        raise ValueError(f"unknown event kind {kind}")
    return {
        "event_id": f"evt_{uuid.uuid4().hex[:16]}",
        "ts": ts or datetime.now(timezone.utc).isoformat(),
        "kind": kind,
        "event_type": event_type,
        "source": normalise_source(source),
        "entity_id": entity_id,
        "unit_id": unit_id,
        "machine_id": machine_id,
        "product_id": product_id,
        "station": station,
        "step": step,
        "status": status,
        "detail": json.dumps(detail or {}, default=str),
    }


def _get_publisher() -> Any:
    global _publisher
    if _publisher is None:
        from google.cloud import pubsub_v1

        _publisher = pubsub_v1.PublisherClient()
    return _publisher


def publish_event(kind: str, event_type: str, **fields: Any) -> dict[str, Any] | None:
    """Publishes one event (fire-and-forget). Returns the row, or None when publishing is off or failed."""
    try:
        row = build_event(kind, event_type, **fields)
    except Exception as e:
        logger.warning("Invalid event %s/%s: %s", kind, event_type, e)
        return None
    if os.environ.get("PYTEST_CURRENT_TEST") or not EVENTS_TOPIC:
        return row
    try:
        publisher = _get_publisher()
        topic = publisher.topic_path(GCP_PROJECT, EVENTS_TOPIC)
        future = publisher.publish(topic, json.dumps(row).encode("utf-8"), kind=kind)
        future.add_done_callback(_log_failure)
    except Exception as e:
        logger.warning("Pub/Sub publish failed for %s/%s: %s", kind, event_type, e)
        return None
    return row


def _log_failure(future: Any) -> None:
    try:
        future.result()
    except Exception as e:
        logger.warning("Pub/Sub publish failed: %s", e)
