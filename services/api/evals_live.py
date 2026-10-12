"""Public LIVE evaluation figures for the /evals page: production API timings from BigQuery.

Only aggregates are returned (count, median and 90th-percentile latency per endpoint), never rows.
"""

import time
from typing import Any

from fastapi import APIRouter, Query
from google.cloud import bigquery

from services.api.bigquery_client import get_bigquery_client
from services.api.config import GCP_PROJECT

router = APIRouter(tags=["evals"])

_CACHE: dict[int, tuple[float, Any]] = {}
CACHE_S = 300.0

LATENCY_SQL = """
SELECT endpoint,
       COUNT(*) AS n,
       APPROX_QUANTILES(total_ms, 100)[OFFSET(50)] AS p50_ms,
       APPROX_QUANTILES(total_ms, 100)[OFFSET(90)] AS p90_ms,
       APPROX_QUANTILES(model_ms, 100)[OFFSET(50)] AS model_p50_ms,
       MIN(ts) AS first_ts,
       MAX(ts) AS last_ts
FROM `{table}`
WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY) AND status = 200
GROUP BY endpoint
ORDER BY n DESC
"""


@router.get("/evals/live")
def live_latency(days: int = Query(default=90, ge=1, le=90)) -> dict[str, Any]:
    """Successful production calls per endpoint with median and p90 latency (LIVE label)."""
    hit = _CACHE.get(days)
    if hit and time.time() - hit[0] < CACHE_S:
        return hit[1]
    job = get_bigquery_client().query(
        LATENCY_SQL.format(table=f"{GCP_PROJECT}.takumi.api_calls"),
        job_config=bigquery.QueryJobConfig(query_parameters=[bigquery.ScalarQueryParameter("days", "INT64", days)]),
    )
    rows = []
    for r in job.result(timeout=20):
        d = dict(r.items())
        for k in ("first_ts", "last_ts"):
            d[k] = d[k].isoformat() if d.get(k) is not None else None
        rows.append(d)
    result = {"label": "LIVE", "days": days, "endpoints": rows}
    _CACHE[days] = (time.time(), result)
    return result
