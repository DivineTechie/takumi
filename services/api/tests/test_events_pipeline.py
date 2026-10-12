"""Events pipeline: event shape, source labels, publishing guard and control tower KPIs."""

import json
from datetime import datetime, timezone
from unittest.mock import patch

from fastapi.testclient import TestClient

from services.api import control_tower
from services.api.control_tower import summarise
from services.api.events_bus import build_event, normalise_source, publish_event
from services.api.main import app

client = TestClient(app)
COLUMNS = [c["name"] for c in json.load(open("shared/schema/bigquery/events.json", encoding="utf-8"))]


def test_event_keys_match_bigquery_columns_exactly():
    row = build_event("machine", "alarm", machine_id="m1", status="stopped", detail={"alarm_text": "E-104"})
    assert sorted(row) == sorted(COLUMNS)
    assert json.loads(row["detail"]) == {"alarm_text": "E-104"}
    assert row["source"] == "LIVE"


def test_source_labels():
    assert normalise_source(None) == "LIVE"
    assert normalise_source("manual_upload") == "LIVE"
    assert normalise_source("HOME RIG") == "HOME RIG"
    assert normalise_source("TEST FIXTURES") == "TEST FIXTURES"
    assert normalise_source("PUBLIC DATA: VisA (CC BY 4.0)") == "PUBLIC DATA: VisA (CC BY 4.0)"


def test_unknown_kind_is_not_published_and_tests_never_publish():
    assert publish_event("weather", "rain") is None
    with patch("services.api.events_bus._get_publisher") as pub:
        row = publish_event("unit", "hold", unit_id="A")
        assert row["kind"] == "unit"
        pub.assert_not_called()  # PYTEST_CURRENT_TEST guard


def test_summarise_splits_by_source_and_computes_first_pass_rate():
    t = datetime(2026, 10, 10, 9, tzinfo=timezone.utc)
    rows = [
        {"source": "LIVE", "kind": "inspection", "event_type": "inspected", "status": "ok", "n": 8, "last_ts": t},
        {"source": "LIVE", "kind": "inspection", "event_type": "inspected", "status": "defective", "n": 2, "last_ts": t},
        {"source": "LIVE", "kind": "inspection", "event_type": "decision", "status": "confirmed_defect", "n": 1, "last_ts": t},
        {"source": "LIVE", "kind": "station", "event_type": "mistake", "status": "", "n": 3, "last_ts": t},
        {"source": "HOME RIG", "kind": "machine", "event_type": "state_change", "status": "stopped", "n": 4, "last_ts": t},
        {"source": "PUBLIC DATA: VisA (CC BY 4.0)", "kind": "inspection", "event_type": "inspected", "status": "ok", "n": 5, "last_ts": t},
    ]
    s = summarise(rows)
    live = s["by_source"]["LIVE"]
    assert live["inspected"] == 10 and live["ok"] == 8 and live["first_pass_rate"] == 0.8
    assert live["confirmed_defects"] == 1 and live["mistakes"] == 3
    assert live["events"] == 14
    assert s["by_source"]["HOME RIG"]["machine_stops"] == 4
    assert s["by_source"]["PUBLIC DATA: VisA (CC BY 4.0)"]["inspected"] == 5
    assert s["last_event_at"] == t.isoformat()


def test_control_summary_supervisor_only():
    control_tower._CACHE.clear()
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "t", "role": "trainee"}):
        assert client.get("/api/control/summary", headers={"Authorization": "Bearer x"}).status_code == 403
    t = datetime(2026, 10, 10, 9, tzinfo=timezone.utc)
    agg = [{"source": "LIVE", "kind": "unit", "event_type": "hold", "status": "on_hold", "n": 2, "last_ts": t}]
    recent = [{"ts": t, "kind": "unit", "event_type": "hold", "source": "LIVE", "unit_id": "A", "machine_id": None,
               "product_id": None, "station": None, "step": None, "status": "on_hold", "detail": '{"reason": "x"}'}]
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "s", "role": "supervisor"}), \
         patch("services.api.control_tower._query", side_effect=[agg, recent]):
        res = client.get("/api/control/summary", headers={"Authorization": "Bearer x"})
    assert res.status_code == 200
    body = res.json()
    assert body["by_source"]["LIVE"]["units_held"] == 2
    assert body["feed"][0]["detail"] == {"reason": "x"}
