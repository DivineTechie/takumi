"""Public LIVE latency endpoint for /evals (aggregates only, cached)."""

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from services.api import evals_live
from services.api.main import app

client = TestClient(app)


def test_public_aggregates_and_cache():
    evals_live._CACHE.clear()
    row = MagicMock()
    row.items.return_value = [("endpoint", "watch"), ("n", 625), ("p50_ms", 1194), ("p90_ms", 2006), ("model_ms_p50", 1000),
                              ("first_ts", datetime(2026, 10, 6, tzinfo=timezone.utc)), ("last_ts", datetime(2026, 10, 10, tzinfo=timezone.utc))]
    bq = MagicMock()
    bq.query.return_value.result.return_value = [row]
    with patch("services.api.evals_live.get_bigquery_client", return_value=bq):
        res = client.get("/api/evals/live")  # no Authorization header: public
        assert res.status_code == 200
        body = res.json()
        assert body["label"] == "LIVE"
        assert body["endpoints"][0]["endpoint"] == "watch" and body["endpoints"][0]["p50_ms"] == 1194
        assert body["endpoints"][0]["first_ts"].startswith("2026-10-06")
        client.get("/api/evals/live")
    assert bq.query.call_count == 1  # second call served from cache
    assert client.get("/api/evals/live?days=500").status_code == 422
