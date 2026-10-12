"""Orders and live projection for the demand agent."""

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi.testclient import TestClient

from services.api.main import app
from services.api.tests.test_units import FakeDB

client = TestClient(app)
AUTH = {"Authorization": "Bearer t"}


def _as(role):
    return patch("services.api.auth.auth.verify_id_token", return_value={"uid": "sup_1", "role": role})


def _db_patch(db):
    return patch("services.api.orders.get_firestore_client", return_value=db)


def test_create_validates_and_is_supervisor_only():
    db = FakeDB()
    db.store["machines/m1"] = {"id": "m1", "name": "Press 2", "source": "VIRTUAL", "ideal_cycle_s": 8}
    due = (datetime.now(timezone.utc) + timedelta(hours=4)).isoformat()
    body = {"name": "Order A", "quantity": 500, "due_at": due, "machine_ids": ["m1"]}
    with _db_patch(db):
        with _as("trainee"):
            assert client.post("/api/orders", json=body, headers=AUTH).status_code == 403
        with _as("supervisor"):
            assert client.post("/api/orders", json={**body, "machine_ids": ["nope"]}, headers=AUTH).status_code == 404
            past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
            assert client.post("/api/orders", json={**body, "due_at": past}, headers=AUTH).status_code == 400
            res = client.post("/api/orders", json=body, headers=AUTH)
            assert res.status_code == 201 and res.json()["status"] == "open"


def test_list_projects_from_real_counts_and_excludes_gallery_inspections():
    db = FakeDB()
    now = datetime.now(timezone.utc)
    created = now - timedelta(hours=1)
    db.store["machines/m1"] = {"id": "m1", "name": "Press 2", "source": "VIRTUAL", "ideal_cycle_s": 8, "state": "running"}
    db.store["orders/o1"] = {"id": "o1", "name": "Order A", "quantity": 1000, "status": "open", "machine_ids": ["m1"],
                            "product_id": "candle", "created_at": created.isoformat(), "due_at": (now + timedelta(hours=2)).isoformat()}
    for i, (mins, count) in enumerate([(55, 100), (25, 300), (1, 400)]):
        db.store[f"machine_events/e{i}"] = {"machine_id": "m1", "event_type": "count", "count": count, "flag": None,
                                            "ts": (now - timedelta(minutes=mins)).isoformat()}
    db.store["inspections/i1"] = {"product_id": "candle", "ai_verdict": "ok", "source": "LIVE", "created_at": now.isoformat()}
    db.store["inspections/i2"] = {"product_id": "candle", "ai_verdict": "defective", "source": "PUBLIC DATA: VisA (CC BY 4.0)",
                                  "created_at": now.isoformat()}
    with _db_patch(db), _as("supervisor"):
        (o,) = client.get("/api/orders", headers=AUTH).json()
    assert o["made"] == 300
    assert o["first_pass_rate"] == 1.0  # the gallery (PUBLIC DATA) defect is ignored
    assert o["source"] == "HOME RIG"
    assert o["rate_per_hour"] == round(100 / (24 / 60), 1)
    assert o["on_track"] is False and o["shortfall"] > 0
    assert o["machines"][0]["ideal_rate_per_hour"] == 450.0
