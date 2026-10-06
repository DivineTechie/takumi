"""BigQuery streaming client for TAKUMI session events."""

import logging
from typing import Any
from google.cloud import bigquery
from services.api.config import GCP_PROJECT, BQ_LOCATION

logger = logging.getLogger("takumi.bigquery")

_bq_client: bigquery.Client | None = None


def get_bigquery_client() -> bigquery.Client:
    global _bq_client
    if _bq_client is None:
        _bq_client = bigquery.Client(project=GCP_PROJECT, location=BQ_LOCATION)
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


def stream_api_call(row: dict[str, Any]) -> None:
    """Streams an API call timing metric row into BigQuery table takumi.api_calls.
    Row contains: ts, endpoint, status, model_ms, total_ms.
    Fire-and-forget: logs warning on failure but never raises.
    """
    try:
        client = get_bigquery_client()
        table_id = f"{GCP_PROJECT}.takumi.api_calls"
        errors = client.insert_rows_json(table_id, [row])
        if errors:
            logger.warning(
                "BigQuery api_calls streaming insert failed",
                extra={"props": {"errors": str(errors)}},
            )
    except Exception as e:
        logger.warning(
            "BigQuery api_calls streaming insert exception",
            extra={"props": {"error": str(e)}},
        )

