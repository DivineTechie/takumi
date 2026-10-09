"""Unit and integration tests for Machine Watch (Pillar 3)."""

import asyncio
import base64
from datetime import datetime, timedelta, timezone
import io
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from services.api.main import app
from services.api.machines import (
    MachineReadGeminiResponse,
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
    mock_db.events_db = events_db
    mock_db.truth_db = truth_db
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


def _gemini(light="green", count=None, alarm_text=None, alarm_active=None):
    if alarm_active is None:
        alarm_active = alarm_text is not None
    return MachineReadGeminiResponse(light=light, count=count, alarm_text=alarm_text, alarm_active=alarm_active)


def _read(mock_db, mach_id, gemini, crops, reason="change", soak_run_id=None, upload_path="evidence/x.jpg"):
    """POSTs one /read with call_flash_lite_read mocked to return `gemini` (or raise it if it is an exception)."""
    if isinstance(gemini, BaseException):
        fake = AsyncMock(side_effect=gemini)
    else:
        fake = AsyncMock(return_value=gemini)
    body = {"crops": crops, "reason": reason}
    if soak_run_id:
        body["soak_run_id"] = soak_run_id
    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.machines.get_firestore_client", return_value=mock_db), \
         patch("services.api.machines.check_machine_rate_limit"), \
         patch("services.api.machines.check_rate_limit"), \
         patch("services.api.machines.call_flash_lite_read", new=fake), \
         patch("services.api.machines.upload_machine_evidence_jpeg", return_value=upload_path):
        return client.post(
            f"/api/machines/{mach_id}/read",
            json=body,
            headers={"Authorization": "Bearer fake_token"},
        )


def _seed_machine(machines_db, mach_id, **overrides):
    doc = {
        "id": mach_id,
        "name": "Bench",
        "light_order": ["red", "yellow", "green"],
        "state_map": {"red": "stopped", "yellow": "idle", "green": "running"},
        "ideal_cycle_s": 10.0,
        "source": "LIVE",
        "state": "running",
        "last_alarm": None,
        "last_count": None,
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
        "last_misread_count": None,
    }
    doc.update(overrides)
    machines_db[mach_id] = doc
    return doc


def test_read_five_read_sequence_emits_only_transitions(mock_firestore):
    """green, green, red+alarm, red+alarm, green -> exactly 4 events, no duplicates."""
    mock_db, machines_db, _ = mock_firestore
    mach_id = "mach_seq"
    _seed_machine(machines_db, mach_id)
    crop = _make_dummy_image_b64(200, 200)
    crops = {"stack_light_b64": crop, "hmi_b64": crop}

    sequence = [
        _gemini("green"),
        _gemini("green"),
        _gemini("red", alarm_text="E-STOP PRESSED"),
        _gemini("red", alarm_text="E-STOP PRESSED"),
        _gemini("green"),
    ]
    changed_flags = []
    for g in sequence:
        resp = _read(mock_db, mach_id, g, crops)
        assert resp.status_code == 200
        changed_flags.append(resp.json()["changed"])

    events = list(mock_db.events_db.values())
    summary = [
        (e["event_type"], e.get("from_state"), e.get("to_state"), e.get("alarm_text"))
        for e in events
    ]
    assert summary == [
        ("state_change", "running", "stopped", None),
        ("alarm", None, None, "E-STOP PRESSED"),
        ("state_change", "stopped", "running", None),
        ("alarm_cleared", None, None, None),
    ]
    assert changed_flags == [False, False, True, False, True]
    assert all(e["source"] == "LIVE" for e in events)
    alarm_ev = next(e for e in events if e["event_type"] == "alarm")
    assert alarm_ev["evidence_path"] == "evidence/x.jpg"
    # Machine doc stores state + last_alarm (no last_state)
    assert machines_db[mach_id]["state"] == "running"
    assert machines_db[mach_id]["last_alarm"] is None
    assert "last_state" not in machines_db[mach_id]


def test_read_gemini_timeout_writes_nothing(mock_firestore):
    mock_db, machines_db, _ = mock_firestore
    mach_id = "mach_timeout"
    _seed_machine(machines_db, mach_id)
    before = dict(machines_db[mach_id])
    crop = _make_dummy_image_b64(200, 200)

    resp = _read(mock_db, mach_id, asyncio.TimeoutError(), {"stack_light_b64": crop})
    assert resp.status_code == 504
    assert "timed out" in resp.json()["detail"]
    assert mock_db.events_db == {}
    assert machines_db[mach_id] == before

    resp_err = _read(mock_db, mach_id, RuntimeError("backend unavailable"), {"stack_light_b64": crop})
    assert resp_err.status_code == 502
    assert "backend unavailable" not in resp_err.json()["detail"]
    assert mock_db.events_db == {}
    assert machines_db[mach_id] == before


def test_read_unclear_multiple_and_unmapped_off_write_nothing(mock_firestore):
    mock_db, machines_db, _ = mock_firestore
    mach_id = "mach_unclear"
    _seed_machine(machines_db, mach_id)
    crop = _make_dummy_image_b64(200, 200)

    for light in ("unclear", "multiple", "off"):
        resp = _read(mock_db, mach_id, _gemini(light), {"stack_light_b64": crop})
        assert resp.status_code == 200
        assert resp.json()["changed"] is False
        assert resp.json()["state"] == "running"
    assert mock_db.events_db == {}
    assert machines_db[mach_id]["state"] == "running"


def test_read_off_maps_only_when_state_map_says_so(mock_firestore):
    mock_db, machines_db, _ = mock_firestore
    mach_id = "mach_off"
    _seed_machine(
        machines_db, mach_id,
        state_map={"red": "stopped", "yellow": "idle", "green": "running", "off": "stopped"},
    )
    crop = _make_dummy_image_b64(200, 200)
    resp = _read(mock_db, mach_id, _gemini("off"), {"stack_light_b64": crop})
    assert resp.status_code == 200
    events = list(mock_db.events_db.values())
    assert [(e["event_type"], e["from_state"], e["to_state"]) for e in events] == [
        ("state_change", "running", "stopped")
    ]


def test_read_heartbeat_only_when_nothing_changed(mock_firestore):
    mock_db, machines_db, _ = mock_firestore
    mach_id = "mach_hb"
    _seed_machine(machines_db, mach_id)
    crop = _make_dummy_image_b64(200, 200)

    # reason=change, nothing changed -> no event
    resp = _read(mock_db, mach_id, _gemini("green"), {"stack_light_b64": crop}, reason="change")
    assert resp.json()["changed"] is False
    assert mock_db.events_db == {}

    # reason=heartbeat, nothing changed -> exactly one heartbeat
    resp = _read(mock_db, mach_id, _gemini("green"), {"stack_light_b64": crop}, reason="heartbeat")
    assert resp.status_code == 200
    events = list(mock_db.events_db.values())
    assert [e["event_type"] for e in events] == ["heartbeat"]

    # reason=heartbeat but the state changed -> state_change only, no heartbeat
    mock_db.events_db.clear()
    _read(mock_db, mach_id, _gemini("yellow"), {"stack_light_b64": crop}, reason="heartbeat")
    assert [e["event_type"] for e in mock_db.events_db.values()] == ["state_change"]


def test_read_source_label_home_rig(mock_firestore):
    mock_db, machines_db, soak_db = mock_firestore
    crop = _make_dummy_image_b64(200, 200)

    # Virtual machine -> HOME RIG
    _seed_machine(machines_db, "mach_virtual", source="VIRTUAL")
    _read(mock_db, "mach_virtual", _gemini("red"), {"stack_light_b64": crop})
    # Live machine read inside a soak run -> HOME RIG
    _seed_machine(machines_db, "mach_live_soak", source="LIVE")
    soak_db["soak_1"] = {"id": "soak_1", "started_at": datetime.now(timezone.utc).isoformat(), "status": "running"}
    _read(mock_db, "mach_live_soak", _gemini("red"), {"stack_light_b64": crop}, soak_run_id="soak_1")

    events = list(mock_db.events_db.values())
    assert len(events) == 2
    assert all(e["source"] == "HOME RIG" for e in events)


def test_read_count_sanity(mock_firestore):
    mock_db, machines_db, _ = mock_firestore
    mach_id = "mach_count"
    _seed_machine(machines_db, mach_id, last_count=50)
    crop = _make_dummy_image_b64(200, 200)
    counter = {"counter_b64": crop}

    # 51 accepted -> one count event
    resp = _read(mock_db, mach_id, _gemini("unclear", count=51), counter)
    assert resp.json()["count"] == 51
    assert [(e["event_type"], e["count"], e["flag"]) for e in mock_db.events_db.values()] == [("count", 51, None)]

    # Same count again -> nothing
    mock_db.events_db.clear()
    resp = _read(mock_db, mach_id, _gemini("unclear", count=51), counter)
    assert resp.json()["changed"] is False
    assert mock_db.events_db == {}

    # Impossible jump -> count event flagged rejected_misread, last_count kept
    resp = _read(mock_db, mach_id, _gemini("unclear", count=500), counter)
    assert resp.json()["count"] == 51
    assert [(e["event_type"], e["count"], e["flag"]) for e in mock_db.events_db.values()] == [
        ("count", 500, "rejected_misread")
    ]
    assert machines_db[mach_id]["last_count"] == 51

    # Reset needs two consecutive agreeing lower reads
    mock_db.events_db.clear()
    resp = _read(mock_db, mach_id, _gemini("unclear", count=0), counter)
    assert resp.json()["count"] == 51
    resp = _read(mock_db, mach_id, _gemini("unclear", count=0), counter)
    assert resp.json()["count"] == 0
    assert machines_db[mach_id]["last_count"] == 0


def test_read_prompt_labels_included_crops(mock_firestore):
    """Each crop is labelled in contents and the prompt names which crops are present."""
    from services.api import machines as machines_mod

    mock_db, machines_db, _ = mock_firestore
    mach_id = "mach_prompt"
    _seed_machine(machines_db, mach_id, light_order=["green", "yellow", "red"])
    crop = _make_dummy_image_b64(200, 200)

    captured = {}

    class FakeModels:
        def generate_content(self, model, contents, config):
            captured["contents"] = contents
            captured["config"] = config
            res = MagicMock()
            res.text = json.dumps({"light": "green", "count": None, "alarm_text": None, "alarm_active": False})
            return res

    fake_client = MagicMock()
    fake_client.models = FakeModels()

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.machines.get_firestore_client", return_value=mock_db), \
         patch("services.api.machines.check_machine_rate_limit"), \
         patch("services.api.machines.check_rate_limit"), \
         patch("services.api.machines.get_genai_client", return_value=fake_client):
        resp = client.post(
            f"/api/machines/{mach_id}/read",
            json={"crops": {"stack_light_b64": crop, "hmi_b64": crop}},
            headers={"Authorization": "Bearer fake_token"},
        )
    assert resp.status_code == 200
    contents = captured["contents"]
    prompt = contents[0]
    assert "This inspection includes the following crops: stack light, HMI screen." in prompt
    assert "top to bottom: green, yellow, red" in prompt
    text_parts = [c for c in contents[1:] if isinstance(c, str)]
    assert text_parts == ["Stack light crop:", "HMI screen crop:"]
    assert "Counter crop:" not in contents
    assert captured["config"].response_schema is machines_mod.MachineReadGeminiResponse


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


def test_machine_setup_failure_returns_error_not_invented_boxes():
    img_b64 = _make_dummy_image_b64(400, 300)

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "sup_1", "role": "supervisor"}):
        with patch("services.api.machines.check_rate_limit"):
            with patch("services.api.machines.call_robotics_er_setup", side_effect=RuntimeError("model down")):
                resp = client.post(
                    "/api/machines/setup",
                    json={"image_b64": img_b64},
                    headers={"Authorization": "Bearer fake_token"},
                )
            assert resp.status_code == 502
            assert "rois" not in resp.json()
            assert "model down" not in resp.json()["detail"]

            with patch("services.api.machines.call_robotics_er_setup", return_value={"stack_light": None}):
                resp = client.post(
                    "/api/machines/setup",
                    json={"image_b64": img_b64},
                    headers={"Authorization": "Bearer fake_token"},
                )
            assert resp.status_code == 422


def test_machine_setup_passes_machine_position_to_model():
    img_b64 = _make_dummy_image_b64(400, 300)
    boxes = {"stack_light": [100, 200, 500, 350], "counter": None, "hmi": None}

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "sup_1", "role": "supervisor"}):
        with patch("services.api.machines.check_rate_limit"):
            with patch("services.api.machines.call_robotics_er_setup", return_value=boxes) as er:
                resp = client.post(
                    "/api/machines/setup",
                    json={"image_b64": img_b64, "machine_count": 3, "machine_index": 2},
                    headers={"Authorization": "Bearer fake_token"},
                )
                assert resp.status_code == 200
                assert er.call_args.args[1:] == (3, 2)

                bad = client.post(
                    "/api/machines/setup",
                    json={"image_b64": img_b64, "machine_count": 2, "machine_index": 3},
                    headers={"Authorization": "Bearer fake_token"},
                )
                assert bad.status_code == 400

    from services.api import machines as machines_mod

    prompt = machines_mod.build_setup_prompt(3, 2)
    assert "3 machines side by side" in prompt
    assert "machine number 2, counting from the left" in prompt


def test_soak_truth_uses_server_time_and_accepts_alarm_cleared(mock_firestore):
    mock_db, _, soak_db = mock_firestore
    started = datetime.now(timezone.utc) - timedelta(seconds=90)
    soak_db["soak_t"] = {
        "id": "soak_t",
        "created_by": "user_alice",
        "started_at": started.isoformat(),
        "status": "running",
    }

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "user_alice", "role": "trainee"}):
        with patch("services.api.machines.get_firestore_client", return_value=mock_db):
            resp = client.post(
                "/api/soak/soak_t/truth",
                json={
                    "machine_id": "mach_1",
                    "ts": "1999-01-01T00:00:00+00:00",
                    "run_s": 5.0,
                    "event_type": "alarm_cleared",
                },
                headers={"Authorization": "Bearer fake_token"},
            )
    assert resp.status_code == 200
    (row,) = mock_db.truth_db.values()
    assert row["event_type"] == "alarm_cleared"
    assert not row["ts"].startswith("1999")
    assert 89.0 <= row["run_s"] <= 100.0
