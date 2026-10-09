"""Unit and integration tests for Machine Watch (Pillar 3)."""

import base64
from datetime import datetime, timezone
import io
import json
import time
from unittest.mock import MagicMock, patch
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from services.api.main import app
from services.api.machines import (
    _machine_read_history,
    check_machine_rate_limit,
    normalize_box,
    validate_crop_image,
)

client = TestClient(app)


def _make_dummy_image_b64(width: int = 100, height: int = 100) -> str:
    img = Image.new("RGB", (width, height), color=(100, 150, 200))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


# --- Unit Tests: Coordinate Normalization ---

def test_normalize_box_standard():
    # [ymin, xmin, ymax, xmax] -> {x, y, w, h}
    # ymin=100, xmin=200, ymax=500, xmax=600
    box = [100, 200, 500, 600]
    res = normalize_box(box)
    assert res["x"] == 0.2
    assert res["y"] == 0.1
    assert res["w"] == 0.4
    assert res["h"] == 0.4


def test_normalize_box_clamping_and_boundaries():
    box = [0, 0, 1000, 1000]
    res = normalize_box(box)
    assert res["x"] == 0.0
    assert res["y"] == 0.0
    assert res["w"] == 1.0
    assert res["h"] == 1.0

    # Beyond bounds clamping
    box_out = [-50, -20, 1200, 1050]
    res_out = normalize_box(box_out)
    assert res_out["x"] == 0.0
    assert res_out["y"] == 0.0
    assert res_out["w"] == 1.0
    assert res_out["h"] == 1.0


def test_normalize_box_invalid_length():
    with pytest.raises(ValueError):
        normalize_box([100, 200, 300])


# --- Unit Tests: Crop Validation ---

def test_validate_crop_image_success():
    b64 = _make_dummy_image_b64(256, 256)
    data = validate_crop_image(b64, "stack_light")
    assert isinstance(data, bytes)
    assert len(data) > 0


def test_validate_crop_image_oversized_dimensions():
    b64 = _make_dummy_image_b64(600, 200)  # > 512 px
    with pytest.raises(Exception) as excinfo:
        validate_crop_image(b64, "stack_light")
    assert "exceeds max dimensions" in str(excinfo.value.detail)


def test_validate_crop_image_invalid_base64():
    with pytest.raises(Exception) as excinfo:
        validate_crop_image("not-valid-base64!!!", "counter")
    assert "Invalid base64" in str(excinfo.value.detail)


# --- Unit Tests: Rolling Minute Rate Limiting ---

def test_check_machine_rate_limit_six_per_min():
    mach_id = f"test_rate_{time.time()}"
    _machine_read_history[mach_id] = []

    # 6 calls succeed
    for _ in range(6):
        check_machine_rate_limit(mach_id)

    # 7th call triggers 429
    with pytest.raises(Exception) as excinfo:
        check_machine_rate_limit(mach_id)
    assert excinfo.value.status_code == 429
    assert "max 6 reads/min" in str(excinfo.value.detail)


# --- Mock Firestore Fixture ---

@pytest.fixture
def mock_firestore():
    machines_db = {}
    events_db = {}
    soak_db = {}
    truth_db = {}

    mock_db = MagicMock()

    def get_collection(col_name: str):
        mock_col = MagicMock()

        def get_document(doc_id: str):
            mock_doc = MagicMock()

            def get_fn():
                m_snap = MagicMock()
                if col_name == "machines":
                    m_snap.exists = doc_id in machines_db
                    m_snap.to_dict.return_value = dict(machines_db.get(doc_id, {}))
                elif col_name == "soak_runs":
                    m_snap.exists = doc_id in soak_db
                    m_snap.to_dict.return_value = dict(soak_db.get(doc_id, {}))
                return m_snap

            def set_fn(data):
                if col_name == "machines":
                    machines_db[doc_id] = dict(data)
                elif col_name == "machine_events":
                    events_db[doc_id] = dict(data)
                elif col_name == "soak_runs":
                    soak_db[doc_id] = dict(data)

            def update_fn(data):
                if col_name == "machines" and doc_id in machines_db:
                    machines_db[doc_id].update(data)
                elif col_name == "soak_runs" and doc_id in soak_db:
                    soak_db[doc_id].update(data)

            def sub_collection(sub_name: str):
                mock_sub_col = MagicMock()
                def sub_doc(t_id: str):
                    m_t_doc = MagicMock()
                    def sub_set(t_data):
                        truth_db[f"{doc_id}/{t_id}"] = dict(t_data)
                    m_t_doc.set.side_effect = sub_set
                    return m_t_doc
                mock_sub_col.document.side_effect = sub_doc
                return mock_sub_col

            mock_doc.get.side_effect = get_fn
            mock_doc.set.side_effect = set_fn
            mock_doc.update.side_effect = update_fn
            mock_doc.collection.side_effect = sub_collection
            return mock_doc

        def stream_fn():
            docs = []
            if col_name == "machines":
                for m_id, m_data in machines_db.items():
                    m_snap = MagicMock()
                    m_snap.to_dict.return_value = dict(m_data)
                    docs.append(m_snap)
            return docs

        mock_col.document.side_effect = get_document
        mock_col.stream.side_effect = stream_fn
        return mock_col

    mock_db.collection.side_effect = get_collection
    return mock_db, machines_db, soak_db


# --- API Endpoint Integration Tests ---

def test_machine_setup_endpoint():
    img_b64 = _make_dummy_image_b64(400, 300)

    mock_er_result = {
        "stack_light": [100, 200, 500, 350],
        "counter": [200, 450, 400, 750],
        "hmi": [450, 400, 850, 850],
    }

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        with patch("services.api.machines.check_rate_limit"):
            with patch("services.api.machines.call_robotics_er_setup", return_value=mock_er_result):
                resp = client.post(
                    "/api/machines/setup",
                    json={"image_b64": img_b64},
                    headers={"Authorization": "Bearer fake_token"},
                )

                assert resp.status_code == 200
                data = resp.json()
                assert "rois" in data
                assert data["rois"]["stack_light"]["x"] == 0.2
                assert data["rois"]["stack_light"]["y"] == 0.1
                assert data["rois"]["counter"]["x"] == 0.45
                assert data["rois"]["hmi"]["y"] == 0.45


def test_create_and_get_machine(mock_firestore):
    mock_db, machines_db, _ = mock_firestore

    create_payload = {
        "name": "Assembly Cell 1",
        "rois": {
            "stack_light": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.5},
            "counter": {"x": 0.4, "y": 0.2, "w": 0.3, "h": 0.2},
            "hmi": None,
        },
        "ideal_cycle_s": 8.5,
        "source": "LIVE",
    }

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "supervisor_1", "role": "supervisor"}):
        with patch("services.api.machines.get_firestore_client", return_value=mock_db):
            resp = client.post(
                "/api/machines",
                json=create_payload,
                headers={"Authorization": "Bearer fake_token"},
            )
            assert resp.status_code == 201
            m_data = resp.json()
            mach_id = m_data["id"]
            assert m_data["name"] == "Assembly Cell 1"
            assert m_data["ideal_cycle_s"] == 8.5

            # Get Machine
            get_resp = client.get(
                f"/api/machines/{mach_id}",
                headers={"Authorization": "Bearer fake_token"},
            )
            assert get_resp.status_code == 200
            assert get_resp.json()["name"] == "Assembly Cell 1"

            # List Machines
            list_resp = client.get(
                "/api/machines",
                headers={"Authorization": "Bearer fake_token"},
            )
            assert list_resp.status_code == 200
            assert len(list_resp.json()) == 1


def test_read_machine_missing_crops(mock_firestore):
    mock_db, machines_db, _ = mock_firestore
    machines_db["mach_test"] = {"id": "mach_test", "name": "M1"}

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        with patch("services.api.machines.get_firestore_client", return_value=mock_db):
            resp = client.post(
                "/api/machines/mach_test/read",
                json={"crops": {}},
                headers={"Authorization": "Bearer fake_token"},
            )
            assert resp.status_code == 400
            assert "At least one crop" in resp.json()["detail"]


def test_read_machine_happy_path_and_count_sanity(mock_firestore):
    mock_db, machines_db, _ = mock_firestore
    mach_id = "mach_bench_01"
    machines_db[mach_id] = {
        "id": mach_id,
        "name": "Bench 1",
        "light_order": ["red", "yellow", "green"],
        "state_map": {"red": "stopped", "yellow": "idle", "green": "running", "off": "stopped"},
        "ideal_cycle_s": 10.0,
        "last_count": 50,
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
        "last_misread_count": None,
    }

    crop_b64 = _make_dummy_image_b64(200, 200)

    # 1. Normal read: green light, count 51 -> state running, count 51 accepted
    mock_resp_1 = {"light": "green", "count": 51, "alarm_text": None}

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        with patch("services.api.machines.get_firestore_client", return_value=mock_db):
            with patch("services.api.machines.check_machine_rate_limit"):
                with patch("services.api.machines.check_rate_limit"):
                    with patch("services.api.machines.call_flash_lite_read", return_value=mock_resp_1):
                        resp = client.post(
                            f"/api/machines/{mach_id}/read",
                            json={"crops": {"stack_light_b64": crop_b64, "counter_b64": crop_b64}},
                            headers={"Authorization": "Bearer fake_token"},
                        )
                        assert resp.status_code == 200
                        data = resp.json()
                        assert data["state"] == "running"
                        assert data["light"] == "green"
                        assert data["count"] == 51

    # 2. Impossible jump: count reads 500 (delta +449 when max allowed is ~3) -> rejected_misread, retains 51
    mock_resp_2 = {"light": "green", "count": 500, "alarm_text": None}

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        with patch("services.api.machines.get_firestore_client", return_value=mock_db):
            with patch("services.api.machines.check_machine_rate_limit"):
                with patch("services.api.machines.check_rate_limit"):
                    with patch("services.api.machines.call_flash_lite_read", return_value=mock_resp_2):
                        resp = client.post(
                            f"/api/machines/{mach_id}/read",
                            json={"crops": {"counter_b64": crop_b64}},
                            headers={"Authorization": "Bearer fake_token"},
                        )
                        assert resp.status_code == 200
                        data = resp.json()
                        assert data["count"] == 51  # retained!

    # 3. Counter reset check:
    # First lower read (e.g. 0): rejected_misread, holds 51
    mock_resp_3 = {"light": "green", "count": 0, "alarm_text": None}
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        with patch("services.api.machines.get_firestore_client", return_value=mock_db):
            with patch("services.api.machines.check_machine_rate_limit"):
                with patch("services.api.machines.check_rate_limit"):
                    with patch("services.api.machines.call_flash_lite_read", return_value=mock_resp_3):
                        resp = client.post(
                            f"/api/machines/{mach_id}/read",
                            json={"crops": {"counter_b64": crop_b64}},
                            headers={"Authorization": "Bearer fake_token"},
                        )
                        assert resp.status_code == 200
                        assert resp.json()["count"] == 51

    # Second lower read with SAME value (0): consecutive reads agree -> accepted reset to 0!
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        with patch("services.api.machines.get_firestore_client", return_value=mock_db):
            with patch("services.api.machines.check_machine_rate_limit"):
                with patch("services.api.machines.check_rate_limit"):
                    with patch("services.api.machines.call_flash_lite_read", return_value=mock_resp_3):
                        resp = client.post(
                            f"/api/machines/{mach_id}/read",
                            json={"crops": {"counter_b64": crop_b64}},
                            headers={"Authorization": "Bearer fake_token"},
                        )
                        assert resp.status_code == 200
                        assert resp.json()["count"] == 0  # reset accepted!


def test_read_machine_alarm_evidence_upload(mock_firestore):
    mock_db, machines_db, _ = mock_firestore
    mach_id = "mach_alarm_01"
    machines_db[mach_id] = {
        "id": mach_id,
        "name": "Cell Alarm Test",
        "state_map": {"red": "stopped", "yellow": "idle", "green": "running", "off": "stopped"},
        "last_count": 10,
    }

    crop_b64 = _make_dummy_image_b64(200, 200)

    mock_resp = {"light": "red", "count": 10, "alarm_text": "E-STOP PRESSED [E-101]"}

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}):
        with patch("services.api.machines.get_firestore_client", return_value=mock_db):
            with patch("services.api.machines.check_machine_rate_limit"):
                with patch("services.api.machines.check_rate_limit"):
                    with patch("services.api.machines.call_flash_lite_read", return_value=mock_resp):
                        with patch("services.api.machines.upload_machine_evidence_jpeg", return_value="evidence/machines/mach_alarm_01/mev_123.jpg") as mock_upload:
                            resp = client.post(
                                f"/api/machines/{mach_id}/read",
                                json={"crops": {"stack_light_b64": crop_b64, "hmi_b64": crop_b64}},
                                headers={"Authorization": "Bearer fake_token"},
                            )
                            assert resp.status_code == 200
                            data = resp.json()
                            assert data["state"] == "stopped"
                            assert data["alarm_code"] == "E-STOP PRESSED [E-101]"
                            assert mock_upload.called


def test_soak_run_lifecycle_and_truth_permissions(mock_firestore):
    mock_db, _, soak_db = mock_firestore

    # 1. Start soak run
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "user_alice", "role": "trainee"}):
        with patch("services.api.machines.get_firestore_client", return_value=mock_db):
            start_resp = client.post(
                "/api/soak",
                json={
                    "duration_min": 15.0,
                    "schedule_seed": 42,
                    "machines": ["mach_1", "mach_2"],
                },
                headers={"Authorization": "Bearer fake_token"},
            )
            assert start_resp.status_code == 201
            soak_id = start_resp.json()["id"]
            assert start_resp.json()["status"] == "running"

            # 2. Post truth by creator -> 200 OK
            truth_payload = {
                "machine_id": "mach_1",
                "ts": datetime.now(timezone.utc).isoformat(),
                "run_s": 12.5,
                "event_type": "state_change",
                "state": "running",
            }
            truth_resp = client.post(
                f"/api/soak/{soak_id}/truth",
                json=truth_payload,
                headers={"Authorization": "Bearer fake_token"},
            )
            assert truth_resp.status_code == 200
            assert truth_resp.json()["status"] == "ok"

    # 3. Post truth by another user -> 403 Forbidden
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "user_bob", "role": "trainee"}):
        with patch("services.api.machines.get_firestore_client", return_value=mock_db):
            truth_bob_resp = client.post(
                f"/api/soak/{soak_id}/truth",
                json=truth_payload,
                headers={"Authorization": "Bearer fake_token"},
            )
            assert truth_bob_resp.status_code == 403
            assert "Forbidden" in truth_bob_resp.json()["detail"]

    # 4. End soak run
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "user_alice", "role": "trainee"}):
        with patch("services.api.machines.get_firestore_client", return_value=mock_db):
            end_resp = client.post(
                f"/api/soak/{soak_id}/end",
                headers={"Authorization": "Bearer fake_token"},
            )
            assert end_resp.status_code == 200
            assert end_resp.json()["status"] == "completed"

            # 5. Post truth to completed run -> 409 Conflict
            post_completed_resp = client.post(
                f"/api/soak/{soak_id}/truth",
                json=truth_payload,
                headers={"Authorization": "Bearer fake_token"},
            )
            assert post_completed_resp.status_code == 409
            assert "not running" in post_completed_resp.json()["detail"]
