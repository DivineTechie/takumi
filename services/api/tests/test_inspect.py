"""Unit and integration tests for End-of-Line Quality Inspection API.

Tests:
- Dual-stage few_false_alarms mode (screen ok -> skip confirm; screen flag -> confirm).
- Dual-stage catch_everything mode (both run; defective if either flags).
- Timeout/failure fallback -> ai_verdict: needs_review (never ok).
- Unit lifecycle state transitions (passed vs needs_review; never failed by AI).
- Human decision lifecycle (supervisor confirmed_defect -> failed; overridden_ok -> passed).
- Input validation (unit_id regex, image format, product existence).
- Rate limit deduction (cost=2).
- Product and Unit CRUD/retrieval endpoints and role guards.
"""

import base64
import io
import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from services.api.main import app

client = TestClient(app)


def _make_dummy_image_b64(width: int = 100, height: int = 100) -> str:
    img = Image.new("RGB", (width, height), color=(200, 200, 200))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


SAMPLE_PRODUCT = {
    "id": "test_candle",
    "name": "Test Candle",
    "description": "White cylindrical candle in clear plastic holder",
    "defect_types": ["chunk of wax missing", "damaged corner", "weird candle wick"],
    "reference_image_paths": ["products/test_candle/ref_1.jpg", "products/test_candle/ref_2.jpg", "products/test_candle/ref_3.jpg"],
    "default_mode": "few_false_alarms",
    "source": "PUBLIC DATA: VisA (CC BY 4.0)",
    "created_at": "2026-10-09T00:00:00Z",
}


@pytest.fixture
def mock_firestore():
    """Mock Firestore client providing products, inspections, units, and gallery collections."""
    products_db = {"test_candle": dict(SAMPLE_PRODUCT)}
    inspections_db = {}
    units_db = {}
    gallery_db = {}

    mock_db = MagicMock()

    def get_collection(col_name: str):
        mock_col = MagicMock()

        def get_document(doc_id: str):
            mock_doc = MagicMock()

            def snap_get():
                snap = MagicMock()
                if col_name == "products":
                    exists = doc_id in products_db
                    snap.exists = exists
                    snap.to_dict.return_value = products_db.get(doc_id)
                elif col_name == "inspections":
                    exists = doc_id in inspections_db
                    snap.exists = exists
                    snap.to_dict.return_value = inspections_db.get(doc_id)
                elif col_name == "units":
                    exists = doc_id in units_db
                    snap.exists = exists
                    snap.to_dict.return_value = units_db.get(doc_id)
                elif col_name == "gallery":
                    exists = doc_id in gallery_db
                    snap.exists = exists
                    snap.to_dict.return_value = gallery_db.get(doc_id)
                else:
                    snap.exists = False
                    snap.to_dict.return_value = {}
                return snap

            mock_doc.get.side_effect = snap_get

            def doc_set(data, merge=False):
                if col_name == "products":
                    products_db[doc_id] = data
                elif col_name == "inspections":
                    inspections_db[doc_id] = data
                elif col_name == "units":
                    units_db[doc_id] = data
                elif col_name == "gallery":
                    gallery_db[doc_id] = data

            mock_doc.set.side_effect = doc_set

            def doc_update(data):
                target = (
                    products_db if col_name == "products"
                    else inspections_db if col_name == "inspections"
                    else gallery_db if col_name == "gallery"
                    else units_db
                )
                if doc_id in target:
                    target[doc_id].update(data)
                else:
                    target[doc_id] = data

            mock_doc.update.side_effect = doc_update
            return mock_doc

        mock_col.document.side_effect = get_document

        def col_stream():
            docs = []
            target = (
                products_db if col_name == "products"
                else inspections_db if col_name == "inspections"
                else gallery_db if col_name == "gallery"
                else units_db
            )
            for k, v in target.items():
                d = MagicMock()
                d.id = k
                d.to_dict.return_value = v
                docs.append(d)
            return docs

        mock_col.stream.side_effect = col_stream
        mock_col.order_by.return_value = mock_col
        mock_col.limit.return_value = mock_col
        mock_col.where.return_value = mock_col
        return mock_col

    mock_db.collection.side_effect = get_collection
    return mock_db


@pytest.fixture
def mock_storage():
    """Mocks Cloud Storage bytes downloads and uploads."""
    dummy_bytes = base64.b64decode(_make_dummy_image_b64(width=50, height=50))
    with patch("services.api.storage_client.download_blob_bytes", return_value=dummy_bytes), \
         patch("services.api.storage_client.upload_inspection_jpeg", return_value="inspections/test.jpg"), \
         patch("services.api.main.download_blob_bytes", return_value=dummy_bytes), \
         patch("services.api.main.upload_inspection_jpeg", return_value="inspections/test.jpg"), \
         patch("services.api.inspection.get_or_load_references", return_value=[dummy_bytes, dummy_bytes, dummy_bytes]):
        yield


def test_inspect_few_false_alarms_clean(mock_firestore, mock_storage):
    """Clean unit in few_false_alarms mode: screen says clean, confirm is skipped, verdict ok."""
    img_b64 = _make_dummy_image_b64()

    mock_screen = AsyncMock(return_value={
        "model": "gemini-3.5-flash-lite",
        "defective": False,
        "confidence": 0.95,
        "defect": None,
        "where": None,
        "ms": 450,
    })
    mock_confirm = AsyncMock()

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_firestore), \
         patch("services.api.main.check_rate_limit") as mock_rate_limit, \
         patch("services.api.inspection.call_inspect_screen", mock_screen), \
         patch("services.api.inspection.call_inspect_confirm", mock_confirm):

        res = client.post(
            "/api/inspect",
            json={
                "product_id": "test_candle",
                "unit_id": "UNIT-001",
                "image_b64": img_b64,
                "mode": "few_false_alarms",
            },
            headers={"Authorization": "Bearer token"},
        )

        assert res.status_code == 200
        data = res.json()
        assert data["ai_verdict"] == "ok"
        assert data["defect"] is None
        assert data["screen"]["defective"] is False
        assert data["confirm"] is None
        # Confirm was NOT called
        mock_confirm.assert_not_called()
        # Rate limit deducted 2 checks
        mock_rate_limit.assert_called_with("trainee_1", "checks", guest=False, cost=2)

        # Unit status was set to passed
        unit_snap = mock_firestore.collection("units").document("UNIT-001").get()
        assert unit_snap.exists
        assert unit_snap.to_dict()["status"] == "passed"


def test_inspect_few_false_alarms_both_flag(mock_firestore, mock_storage):
    """Defective unit in few_false_alarms: screen flags, confirm also flags -> verdict defective."""
    img_b64 = _make_dummy_image_b64()

    mock_screen = AsyncMock(return_value={
        "model": "gemini-3.5-flash-lite",
        "defective": True,
        "confidence": 0.88,
        "defect": "chunk of wax missing",
        "where": "upper rim",
        "ms": 420,
    })
    mock_confirm = AsyncMock(return_value={
        "model": "gemini-3.8-flash",
        "defective": True,
        "confidence": 0.92,
        "defect": "chunk of wax missing",
        "where": "top right corner",
        "ms": 890,
    })

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_firestore), \
         patch("services.api.main.check_rate_limit"), \
         patch("services.api.inspection.call_inspect_screen", mock_screen), \
         patch("services.api.inspection.call_inspect_confirm", mock_confirm):

        res = client.post(
            "/api/inspect",
            json={
                "product_id": "test_candle",
                "unit_id": "UNIT-002",
                "image_b64": img_b64,
                "mode": "few_false_alarms",
            },
            headers={"Authorization": "Bearer token"},
        )

        assert res.status_code == 200
        data = res.json()
        assert data["ai_verdict"] == "defective"
        assert data["defect"] == "chunk of wax missing"
        assert data["screen"]["defective"] is True
        assert data["confirm"]["defective"] is True
        mock_confirm.assert_called_once()

        # Unit status is needs_review (NEVER failed directly by AI)
        unit_snap = mock_firestore.collection("units").document("UNIT-002").get()
        assert unit_snap.to_dict()["status"] == "needs_review"


def test_inspect_few_false_alarms_screen_flags_confirm_clears(mock_firestore, mock_storage):
    """False alarm: screen flags, but confirm says clean -> verdict ok."""
    img_b64 = _make_dummy_image_b64()

    mock_screen = AsyncMock(return_value={
        "model": "gemini-3.5-flash-lite",
        "defective": True,
        "confidence": 0.55,
        "defect": "suspected spot",
        "where": "base",
        "ms": 400,
    })
    mock_confirm = AsyncMock(return_value={
        "model": "gemini-3.8-flash",
        "defective": False,
        "confidence": 0.91,
        "defect": None,
        "where": None,
        "ms": 850,
    })

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_firestore), \
         patch("services.api.main.check_rate_limit"), \
         patch("services.api.inspection.call_inspect_screen", mock_screen), \
         patch("services.api.inspection.call_inspect_confirm", mock_confirm):

        res = client.post(
            "/api/inspect",
            json={
                "product_id": "test_candle",
                "unit_id": "UNIT-003",
                "image_b64": img_b64,
                "mode": "few_false_alarms",
            },
            headers={"Authorization": "Bearer token"},
        )

        assert res.status_code == 200
        data = res.json()
        assert data["ai_verdict"] == "ok"
        assert data["screen"]["defective"] is True
        assert data["confirm"]["defective"] is False

        unit_snap = mock_firestore.collection("units").document("UNIT-003").get()
        assert unit_snap.to_dict()["status"] == "passed"


def test_inspect_catch_everything_mode(mock_firestore, mock_storage):
    """catch_everything runs screen and confirm in parallel; defective if EITHER flags."""
    img_b64 = _make_dummy_image_b64()

    # Screen clean, but confirm flags
    mock_screen = AsyncMock(return_value={
        "model": "gemini-3.5-flash-lite",
        "defective": False,
        "confidence": 0.80,
        "defect": None,
        "where": None,
        "ms": 300,
    })
    mock_confirm = AsyncMock(return_value={
        "model": "gemini-3.8-flash",
        "defective": True,
        "confidence": 0.85,
        "defect": "damaged corner",
        "where": "corner",
        "ms": 700,
    })

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_firestore), \
         patch("services.api.main.check_rate_limit"), \
         patch("services.api.inspection.call_inspect_screen", mock_screen), \
         patch("services.api.inspection.call_inspect_confirm", mock_confirm):

        res = client.post(
            "/api/inspect",
            json={
                "product_id": "test_candle",
                "unit_id": "UNIT-004",
                "image_b64": img_b64,
                "mode": "catch_everything",
            },
            headers={"Authorization": "Bearer token"},
        )

        assert res.status_code == 200
        data = res.json()
        assert data["ai_verdict"] == "defective"
        assert data["defect"] == "damaged corner"
        mock_screen.assert_called_once()
        mock_confirm.assert_called_once()


def test_inspect_timeout_fallback(mock_firestore, mock_storage):
    """Timeout during inspection yields ai_verdict: needs_review (never ok)."""
    img_b64 = _make_dummy_image_b64()

    mock_screen = AsyncMock(side_effect=TimeoutError("Inspection model timed out"))

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_firestore), \
         patch("services.api.main.check_rate_limit"), \
         patch("services.api.inspection.call_inspect_screen", mock_screen):

        res = client.post(
            "/api/inspect",
            json={
                "product_id": "test_candle",
                "unit_id": "UNIT-TIMEOUT",
                "image_b64": img_b64,
                "mode": "few_false_alarms",
            },
            headers={"Authorization": "Bearer token"},
        )

        assert res.status_code == 200
        data = res.json()
        assert data["ai_verdict"] == "needs_review"
        assert data["defect"] is None

        unit_snap = mock_firestore.collection("units").document("UNIT-TIMEOUT").get()
        assert unit_snap.to_dict()["status"] == "needs_review"


def test_inspect_validation_errors(mock_firestore, mock_storage):
    """Validation errors: invalid unit_id, corrupt image, non-existent product.
    Verifies that check_rate_limit is NOT called when validations fail.
    """
    img_b64 = _make_dummy_image_b64()

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_firestore), \
         patch("services.api.main.check_rate_limit") as mock_rate_limit:

        # 1. Invalid unit_id regex
        res_unit = client.post(
            "/api/inspect",
            json={
                "product_id": "test_candle",
                "unit_id": "invalid unit id with spaces!",
                "image_b64": img_b64,
            },
            headers={"Authorization": "Bearer token"},
        )
        assert res_unit.status_code == 400
        mock_rate_limit.assert_not_called()

        # 2. Corrupt image_b64
        res_img = client.post(
            "/api/inspect",
            json={
                "product_id": "test_candle",
                "unit_id": "UNIT-VALID",
                "image_b64": "not-a-valid-base64-image",
            },
            headers={"Authorization": "Bearer token"},
        )
        assert res_img.status_code == 400
        mock_rate_limit.assert_not_called()

        # 3. Product not found
        res_prod = client.post(
            "/api/inspect",
            json={
                "product_id": "non_existent_product",
                "unit_id": "UNIT-VALID",
                "image_b64": img_b64,
            },
            headers={"Authorization": "Bearer token"},
        )
        assert res_prod.status_code == 404
        mock_rate_limit.assert_not_called()


def test_inspection_and_unit_access_control(mock_firestore):
    """Access control: other trainee -> 403, owner trainee -> 200, supervisor -> 200."""
    insp_id = "insp_ac_test"
    unit_id = "UNIT-AC-TEST"

    mock_firestore.collection("inspections").document(insp_id).set({
        "id": insp_id,
        "unit_id": unit_id,
        "product_id": "test_candle",
        "image_path": "inspections/test.jpg",
        "mode": "few_false_alarms",
        "ai_verdict": "ok",
        "human_decision": None,
        "inspector_uid": "trainee_owner",
        "created_at": "2026-10-09T00:00:00Z",
        "total_ms": 1000,
    })

    mock_firestore.collection("units").document(unit_id).set({
        "id": unit_id,
        "product_id": "test_candle",
        "created_at": "2026-10-09T00:00:00Z",
        "status": "passed",
        "station_records": [],
        "inspections": [insp_id],
        "created_by": "trainee_owner",
    })

    # 1. Other trainee is denied access (403)
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_other", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_firestore):

        res_insp_other = client.get(f"/api/inspections/{insp_id}", headers={"Authorization": "Bearer token"})
        assert res_insp_other.status_code == 403

        res_unit_other = client.get(f"/api/units/{unit_id}", headers={"Authorization": "Bearer token"})
        assert res_unit_other.status_code == 403

    # 2. Owner trainee is granted access (200)
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_owner", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_firestore):

        res_insp_owner = client.get(f"/api/inspections/{insp_id}", headers={"Authorization": "Bearer token"})
        assert res_insp_owner.status_code == 200
        assert res_insp_owner.json()["id"] == insp_id

        res_unit_owner = client.get(f"/api/units/{unit_id}", headers={"Authorization": "Bearer token"})
        assert res_unit_owner.status_code == 200
        assert res_unit_owner.json()["id"] == unit_id

    # 3. Supervisor is granted access to all (200)
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "supervisor_1", "role": "supervisor"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_firestore):

        res_insp_sup = client.get(f"/api/inspections/{insp_id}", headers={"Authorization": "Bearer token"})
        assert res_insp_sup.status_code == 200

        res_unit_sup = client.get(f"/api/units/{unit_id}", headers={"Authorization": "Bearer token"})
        assert res_unit_sup.status_code == 200


def test_human_decision_lifecycle(mock_firestore):
    """Supervisor decision overrides unit status: confirmed_defect -> failed, overridden_ok -> passed."""
    # Seed an inspection and associated unit
    insp_id = "insp_test_decision_123"
    unit_id = "UNIT-DECISION-1"

    mock_firestore.collection("inspections").document(insp_id).set({
        "id": insp_id,
        "unit_id": unit_id,
        "product_id": "test_candle",
        "image_path": "inspections/test.jpg",
        "mode": "few_false_alarms",
        "ai_verdict": "defective",
        "human_decision": None,
        "decided_by_uid": None,
        "decided_at": None,
        "source": "LIVE",
        "inspector_uid": "trainee_1",
        "created_at": "2026-10-09T00:00:00Z",
        "total_ms": 1200,
    })

    mock_firestore.collection("units").document(unit_id).set({
        "id": unit_id,
        "product_id": "test_candle",
        "created_at": "2026-10-09T00:00:00Z",
        "status": "needs_review",
        "station_records": [],
        "inspections": [insp_id],
        "created_by": "trainee_1",
    })

    # Non-supervisor cannot decide (403)
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_firestore):

        res_forbidden = client.post(
            f"/api/inspections/{insp_id}/decision",
            json={"decision": "confirmed_defect"},
            headers={"Authorization": "Bearer token"},
        )
        assert res_forbidden.status_code == 403

    # Supervisor confirms defect -> status becomes failed
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "supervisor_1", "role": "supervisor"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_firestore):

        res_defect = client.post(
            f"/api/inspections/{insp_id}/decision",
            json={"decision": "confirmed_defect", "notes": "Confirmed crack on rim"},
            headers={"Authorization": "Bearer token"},
        )
        assert res_defect.status_code == 200
        assert res_defect.json()["human_decision"] == "confirmed_defect"

        unit_snap = mock_firestore.collection("units").document(unit_id).get()
        assert unit_snap.to_dict()["status"] == "failed"

        # Supervisor overrides ok -> status becomes passed
        res_override = client.post(
            f"/api/inspections/{insp_id}/decision",
            json={"decision": "overridden_ok", "notes": "Acceptable surface variance"},
            headers={"Authorization": "Bearer token"},
        )
        assert res_override.status_code == 200
        assert res_override.json()["human_decision"] == "overridden_ok"

        unit_snap2 = mock_firestore.collection("units").document(unit_id).get()
        assert unit_snap2.to_dict()["status"] == "passed"


def test_product_and_unit_endpoints(mock_firestore):
    """GET/POST /api/products and GET /api/units."""
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_firestore):

        # List products
        res_list = client.get("/api/products", headers={"Authorization": "Bearer token"})
        assert res_list.status_code == 200
        prods = res_list.json()
        assert any(p["id"] == "test_candle" for p in prods)

        # Get single product
        res_get = client.get("/api/products/test_candle", headers={"Authorization": "Bearer token"})
        assert res_get.status_code == 200
        assert res_get.json()["name"] == "Test Candle"

        # Non-supervisor cannot create product
        res_post_forbidden = client.post(
            "/api/products",
            json={
                "id": "new_prod",
                "name": "New",
                "description": "Desc",
                "defect_types": ["d1"],
                "reference_image_paths": ["p/1.jpg", "p/2.jpg", "p/3.jpg"],
                "default_mode": "few_false_alarms",
            },
            headers={"Authorization": "Bearer token"},
        )
        assert res_post_forbidden.status_code == 403


def test_gallery_endpoints(mock_firestore, mock_storage):
    """GET /api/inspect/gallery and POST /api/inspect/gallery."""
    # Seed gallery items with opaque ids (one normal, one anomaly)
    gal_id = "gal_3f9a1c2b7d4e"
    mock_firestore.collection("gallery").document(gal_id).set({
        "id": gal_id,
        "product_id": "test_candle",
        "image_path": "gallery/9c1e0a7b44d2.jpg",
        "label": "normal",
        "source_file": "candle/Data/Images/Normal/0001.JPG",
        "split": "test",
        "source": "PUBLIC DATA: VisA (CC BY 4.0)",
        "created_at": "2026-10-09T00:00:00Z",
    })
    mock_firestore.collection("gallery").document("gal_a81d55e0c9f3").set({
        "id": "gal_a81d55e0c9f3",
        "product_id": "test_candle",
        "image_path": "gallery/0b7f3e9a12c6.jpg",
        "label": "wax melded out of the candle",
        "source_file": "candle/Data/Images/Anomaly/013.JPG",
        "split": "test",
        "source": "PUBLIC DATA: VisA (CC BY 4.0)",
        "created_at": "2026-10-09T00:00:00Z",
    })

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_firestore), \
         patch("services.api.main.stream_inspection_event") as mock_stream, \
         patch("services.api.main.check_rate_limit") as mock_rate_limit, \
         patch("services.api.main.run_inspection_pipeline", autospec=True) as mock_pipe:

        mock_pipe.return_value = {
            "ai_verdict": "ok",
            "defect": None,
            "where": None,
            "confidence": 0.98,
            "screen": {
                "stage": "screen",
                "model": "gemini-3.5-flash-lite",
                "defective": False,
                "confidence": 0.98,
                "defect": None,
                "where": None,
                "ms": 400,
            },
            "confirm": None,
            "total_ms": 450,
        }

        # 1. GET gallery list (labels, filenames and source paths must NOT be exposed)
        res_list = client.get("/api/inspect/gallery", headers={"Authorization": "Bearer token"})
        assert res_list.status_code == 200
        items = res_list.json()
        assert len(items) >= 2
        for it in items:
            assert set(it.keys()) == {"id", "category", "image_url"}
            for value in it.values():
                text = str(value).lower()
                assert "normal" not in text
                assert "anomaly" not in text
        gal_item = next(i for i in items if i["id"] == gal_id)
        assert gal_item["category"] == "test_candle"
        # Same fixed order on every call
        res_list2 = client.get("/api/inspect/gallery", headers={"Authorization": "Bearer token"})
        assert [i["id"] for i in res_list2.json()] == [i["id"] for i in items]

        # 2. POST inspect gallery
        res_insp = client.post(
            "/api/inspect/gallery",
            json={"gallery_id": gal_id, "mode": "few_false_alarms"},
            headers={"Authorization": "Bearer token"},
        )
        assert res_insp.status_code == 200
        data = res_insp.json()
        assert data["ai_verdict"] == "ok"
        assert data["source"] == "PUBLIC DATA: VisA (CC BY 4.0)"
        # Revealed only after inspection
        assert data["dataset_label"] == "normal"
        mock_rate_limit.assert_called_once()
        mock_stream.assert_called_once()

        # Check firestore inspection saved without unit
        insp_id = data["inspection_id"]
        saved = mock_firestore.collection("inspections").document(insp_id).get().to_dict()
        assert saved["unit_id"] is None
        assert saved["source"] == "PUBLIC DATA: VisA (CC BY 4.0)"


def test_supervisor_insights_inspections(mock_firestore):
    """GET /api/insights/inspections: supervisor only, separates LIVE from PUBLIC DATA."""
    # Seed 1 LIVE inspection and 1 PUBLIC DATA gallery inspection
    mock_firestore.collection("inspections").document("insp_live_1").set({
        "id": "insp_live_1",
        "product_id": "test_candle",
        "unit_id": "UNIT-100",
        "source": "LIVE",
        "ai_verdict": "defective",
        "defect": "scratch",
        "human_decision": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    mock_firestore.collection("inspections").document("insp_gal_1").set({
        "id": "insp_gal_1",
        "product_id": "test_candle",
        "unit_id": None,
        "source": "PUBLIC DATA: VisA (CC BY 4.0)",
        "dataset_label": "scratch",
        "ai_verdict": "defective",
        "defect": "scratch",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    # Trainee denied (403)
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_firestore):
        res_trainee = client.get("/api/insights/inspections", headers={"Authorization": "Bearer token"})
        assert res_trainee.status_code == 403

    # Supervisor allowed (200)
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "sup_1", "role": "supervisor"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_firestore):
        res_sup = client.get("/api/insights/inspections", headers={"Authorization": "Bearer token"})
        assert res_sup.status_code == 200
        insights = res_sup.json()
        assert insights["live"]["today_count"] == 1
        assert insights["live"]["flagged_awaiting_count"] == 1
        assert len(insights["live"]["recent"]) == 1
        assert insights["gallery"]["trials_count"] == 1
        assert insights["gallery"]["hits_count"] == 1
        assert insights["gallery"]["hit_rate"] == 100.0


def test_create_product_with_images_uploads_references_as_live():
    import base64 as _b64
    import io as _io
    from PIL import Image as _Image

    buf = _io.BytesIO()
    _Image.new("RGB", (1600, 1200), (200, 200, 200)).save(buf, format="JPEG")
    img = _b64.b64encode(buf.getvalue()).decode()
    uploaded = {}
    db = MagicMock()
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "sup", "role": "supervisor"}), \
         patch("services.api.main.get_firestore_client", return_value=db), \
         patch("services.api.main.upload_blob_bytes", side_effect=lambda p, b: uploaded.setdefault(p, b) and p):
        res = client.post("/api/products/with-images", headers={"Authorization": "Bearer t"},
                          json={"name": "Charger kit", "description": "a phone charger kit", "defect_types": ["label missing", " "],
                                "images_b64": [img, img, img]})
    assert res.status_code == 201
    data = res.json()
    assert data["source"] == "LIVE" and data["id"].startswith("charger_kit_")
    assert data["defect_types"] == ["label missing"]
    assert len(uploaded) == 3 and all(p.startswith(f"products/{data['id']}/ref_") for p in uploaded)
    assert max(_Image.open(_io.BytesIO(next(iter(uploaded.values())))).size) == 1024

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "t", "role": "trainee"}):
        assert client.post("/api/products/with-images", headers={"Authorization": "Bearer t"},
                           json={"name": "X kit", "description": "abc", "images_b64": [img, img, img]}).status_code == 403
