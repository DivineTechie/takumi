"""BigQuery streaming client for TAKUMI session events."""

import logging
from typing import Any
from google.cloud import bigquery
from services.api.config import GCP_PROJECT

logger = logging.getLogger("takumi.bigquery")

_bq_client: bigquery.Client | None = None


def get_bigquery_client() -> bigquery.Client:
    global _bq_client
    if _bq_client is None:
        _bq_client = bigquery.Client(project=GCP_PROJECT)
    return _bq_client


def stream_session_event(row: dict[str, Any]) -> None:
    """Streams a single session event row into BigQuery table takumi.session_events.

    If the insert fails, logs an error but does NOT raise (Firestore is the source of truth).
    """
    try:
        client = get_bigquery_client()
        table_id = f"{GCP_PROJECT}.takumi.session_events"
        errors = client.insert_rows_json(table_id, [row])
        if errors:
            logger.error(
                "BigQuery streaming insert failed",
                extra={"props": {"errors": str(errors), "session_id": row.get("session_id")}},
            )
    except Exception as e:
        logger.error(
            "BigQuery streaming insert exception",
            extra={"props": {"error": str(e), "session_id": row.get("session_id")}},
        )
