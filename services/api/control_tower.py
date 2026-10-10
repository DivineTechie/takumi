"""Control tower (P18): one view of the factory built from `takumi.events` in BigQuery.

Events arrive there through Pub/Sub (Cloud Run publishes, a BigQuery subscription writes). Every
figure is split by source label (LIVE, HOME RIG, PUBLIC DATA), so simulated or public-dataset events
never mix with live ones.
"""

import json
import time
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, Depends, Query
from google.cloud import bigquery

from services.api.auth import AuthUser, require_role
from services.api.bigquery_client import get_bigquery_client
from services.api.config import GCP_PROJECT

router = APIRouter(tags=["control"])

_CACHE: dict[str, tuple[float, Any]] = {}
CACHE_S = 10.0

AGG_SQL = """
SELECT source, kind, event_type, IFNULL(status, '') AS status, COUNT(*) AS n, MAX(ts) AS last_ts
FROM `{table}`
WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR)
GROUP BY source, kind, event_type, status
"""

RECENT_SQL = """
SELECT ts, kind, event_type, source, unit_id, machine_id, product_id, station, step, status, detail
FROM `{table}`
WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR)
ORDER BY ts DESC
LIMIT @limit
"""


def summarise(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Turns grouped counts into per-source KPIs (pure function)."""
    by_source: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    last_ts = None
    for r in rows:
        s = by_source[r["source"]]
        key = f"{r['kind']}.{r['event_type']}"
        s[key] += r["n"]
        if r["status"]:
            s[f"{key}.{r['status']}"] += r["n"]
        ts = r.get("last_ts")
        if ts is not None and (last_ts is None or ts > last_ts):
            last_ts = ts

    out = {}
    for source, c in by_source.items():
        inspected = c["inspection.inspected"]
        ok = c["inspection.inspected.ok"]
        out[source] = {
            "inspected": inspected,
            "ok": ok,
            "defective": c["inspection.inspected.defective"],
            "needs_review": c["inspection.inspected.needs_review"],
            "first_pass_rate": (ok / inspected) if inspected else None,
            "confirmed_defects": c["inspection.decision.confirmed_defect"],
            "overridden": c["inspection.decision.overridden_ok"],
            "stations_completed": c["station.station_completed"],
            "steps_verified": c["station.step_done"],
            "mistakes": c["station.mistake"],
            "safety_stops": c["station.safety_stop"],
            "machine_stops": c["machine.state_change.stopped"],
            "machine_alarms": c["machine.alarm"],
            "units_held": c["unit.hold"],
            "events": sum(v for k, v in c.items() if k.count(".") == 1),
        }
    return {"by_source": out, "last_event_at": last_ts.isoformat() if hasattr(last_ts, "isoformat") else last_ts}


def _query(sql: str, params: list[bigquery.ScalarQueryParameter]) -> list[dict[str, Any]]:
    client = get_bigquery_client()
    job = client.query(
        sql.format(table=f"{GCP_PROJECT}.takumi.events"),
        job_config=bigquery.QueryJobConfig(query_parameters=params),
    )
    return [dict(r.items()) for r in job.result(timeout=20)]


@router.get("/control/summary")
def control_summary(
    hours: int = Query(default=24, ge=1, le=168),
    limit: int = Query(default=40, ge=1, le=200),
    user: AuthUser = Depends(require_role("supervisor")),
) -> dict[str, Any]:
    """KPIs per source and the latest events for the control tower (cached for 10 s)."""
    key = f"{hours}:{limit}"
    hit = _CACHE.get(key)
    if hit and time.time() - hit[0] < CACHE_S:
        return hit[1]

    hours_p = bigquery.ScalarQueryParameter("hours", "INT64", hours)
    agg = _query(AGG_SQL, [hours_p])
    recent = _query(RECENT_SQL, [hours_p, bigquery.ScalarQueryParameter("limit", "INT64", limit)])

    feed = []
    for r in recent:
        try:
            detail = json.loads(r.get("detail") or "{}")
        except ValueError:
            detail = {}
        feed.append({**r, "ts": r["ts"].isoformat() if hasattr(r["ts"], "isoformat") else r["ts"], "detail": detail})

    result = {"hours": hours, **summarise(agg), "feed": feed}
    _CACHE[key] = (time.time(), result)
    return result
