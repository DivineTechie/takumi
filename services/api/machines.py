"""Machine Watch API endpoints for TAKUMI (Pillar 3).

Implements:
- POST /api/machines/setup (Gemini Robotics-ER bounding box detection)
- POST /api/machines (Save machine configuration)
- GET /api/machines (List machines)
- GET /api/machines/{id} (Get machine)
- POST /api/machines/{id}/read (Gemini Flash-Lite multi-crop reasoning)
- POST /api/soak (Start soak run)
- POST /api/soak/{id}/end (End soak run)
- POST /api/soak/{id}/truth (Stream ground truth events)
"""

import base64
from datetime import datetime, timezone
import io
import json
import logging
import time
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from google.cloud import firestore
from google import genai
from google.genai import types
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field

from services.api.auth import AuthUser, check_rate_limit, get_firestore_client, require_role, verify_auth_token
from services.api.bigquery_client import stream_machine_event
from services.api.config import (
    LIMIT_MACHINE_READS_PER_MIN,
    MACHINE_CROP_MAX_BYTES,
    MACHINE_CROP_MAX_PX,
    MAX_REQUEST_SIZE_BYTES,
    MODEL_FLASH_LITE,
    MODEL_ROBOTICS_ER,
    TIMEOUT_MACHINE_READ_S,
    TIMEOUT_MACHINE_SETUP_S,
)
from services.api.gemini import get_genai_client
from services.api.storage_client import upload_machine_evidence_jpeg
from services.api.telemetry import trace_gemini_call

logger = logging.getLogger("takumi.machines")

router = APIRouter(tags=["machines"])


# --- Schemas ---

class NormalizedRoiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: float = Field(..., ge=0.0, le=1.0)
    y: float = Field(..., ge=0.0, le=1.0)
    w: float = Field(..., ge=0.0, le=1.0)
    h: float = Field(..., ge=0.0, le=1.0)


class RoisModel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stack_light: NormalizedRoiModel
    counter: NormalizedRoiModel | None = None
    hmi: NormalizedRoiModel | None = None


class MachineSetupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    image_b64: str


class MachineSetupResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rois: RoisModel


class CreateMachineRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(..., min_length=1, max_length=100)
    light_order: list[str] | None = None
    state_map: dict[str, str] | None = None
    rois: RoisModel
    ideal_cycle_s: float = Field(10.0, ge=0.1)
    source: Literal["LIVE", "VIRTUAL"] = "LIVE"


class MachineCrops(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stack_light_b64: str | None = None
    counter_b64: str | None = None
    hmi_b64: str | None = None


class MachineReadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    crops: MachineCrops
    video_run_s: float | None = None
    soak_run_id: str | None = None
    detected_by: Literal["edge", "gemini"] = "gemini"


class MachineReadResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: str
    light: str
    count: int | None
    alarm_code: str | None
    ms: int


class StartSoakRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    duration_min: float = Field(..., ge=0.5)
    schedule_seed: int | str
    machines: list[str] = Field(..., min_length=1)


class SoakTruthRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    machine_id: str
    ts: str
    run_s: float = Field(..., ge=0.0)
    event_type: Literal["state_change", "alarm", "count"]
    state: str | None = None
    count: int | None = None
    alarm_code: str | None = None


# --- Helpers ---

def normalize_box(box_1000: list[int | float]) -> dict[str, float]:
    """Converts a [ymin, xmin, ymax, xmax] box on a 0-1000 scale to normalised {x, y, w, h} [0-1]."""
    if len(box_1000) != 4:
        raise ValueError(f"Expected 4 coordinates, got {len(box_1000)}")

    ymin, xmin, ymax, xmax = [float(v) for v in box_1000]

    x = max(0.0, min(1.0, xmin / 1000.0))
    y = max(0.0, min(1.0, ymin / 1000.0))
    w = max(0.0, min(1.0, (xmax - xmin) / 1000.0))
    h = max(0.0, min(1.0, (ymax - ymin) / 1000.0))

    return {
        "x": round(x, 4),
        "y": round(y, 4),
        "w": round(w, 4),
        "h": round(h, 4),
    }


def validate_crop_image(image_b64: str, field_name: str) -> bytes:
    """Validates base64 crop image size and dimensions (<= 512 px, <= 300 KB)."""
    try:
        raw_bytes = base64.b64decode(image_b64)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid base64 encoding for {field_name}",
        )

    if len(raw_bytes) > MACHINE_CROP_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} exceeds max size of {MACHINE_CROP_MAX_BYTES // 1024} KB",
        )

    try:
        with Image.open(io.BytesIO(raw_bytes)) as img:
            width, height = img.size
            if width > MACHINE_CROP_MAX_PX or height > MACHINE_CROP_MAX_PX:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"{field_name} exceeds max dimensions of {MACHINE_CROP_MAX_PX}x{MACHINE_CROP_MAX_PX} px (got {width}x{height})",
                )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} is not a valid image format",
        )

    return raw_bytes


# In-memory rolling rate limiter: machine_id -> list of timestamps
_machine_read_history: dict[str, list[float]] = {}


def check_machine_rate_limit(machine_id: str) -> None:
    """Enforces server-side rolling minute limit of max 6 reads per machine."""
    now = time.time()
    history = _machine_read_history.get(machine_id, [])
    # Keep only timestamps in the last 60 seconds
    cutoff = now - 60.0
    history = [t for t in history if t > cutoff]

    if len(history) >= LIMIT_MACHINE_READS_PER_MIN:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Machine read rate limit exceeded (max 6 reads/min per machine).",
        )

    history.append(now)
    _machine_read_history[machine_id] = history


def call_robotics_er_setup(raw_bytes: bytes, client: genai.Client | None = None) -> dict[str, Any]:
    """Invokes gemini-robotics-er-2-preview to detect machine component regions of interest."""
    if client is None:
        client = get_genai_client()

    prompt = (
        "You are an industrial robotics vision model. Locate the following components on this machine:\n"
        "1. stack_light: The multi-segment indicator tower / signal light (patlite).\n"
        "2. counter: The digital pulse/cycle parts counter display.\n"
        "3. hmi: The human-machine interface terminal screen.\n\n"
        "Return bounding boxes in JSON format for each detected element with coordinates as [ymin, xmin, ymax, xmax] on a 0-1000 scale."
    )

    contents = [
        prompt,
        types.Part.from_bytes(data=raw_bytes, mime_type="image/jpeg"),
    ]
    cfg = types.GenerateContentConfig(
        response_mime_type="application/json",
    )
    with trace_gemini_call("machines.setup", MODEL_ROBOTICS_ER):
        res = client.models.generate_content(
            model=MODEL_ROBOTICS_ER,
            contents=contents,
            config=cfg,
        )
    return json.loads(res.text)


def call_flash_lite_read(
    prompt: str,
    crops: list[bytes],
    client: genai.Client | None = None,
) -> dict[str, Any]:
    """Invokes gemini-3.5-flash-lite on machine crops to read stack light, counter, and alarms."""
    if client is None:
        client = get_genai_client()

    contents: list[Any] = [prompt]
    for b in crops:
        contents.append(types.Part.from_bytes(data=b, mime_type="image/jpeg"))

    cfg = types.GenerateContentConfig(
        response_mime_type="application/json",
    )
    with trace_gemini_call("machines.read", MODEL_FLASH_LITE):
        res = client.models.generate_content(
            model=MODEL_FLASH_LITE,
            contents=contents,
            config=cfg,
        )
    return json.loads(res.text)


# --- Endpoints ---

@router.post("/machines/setup", response_model=MachineSetupResponse)
def setup_machine(
    req: MachineSetupRequest,
    user: AuthUser = Depends(require_role("trainee", "supervisor", "master")),
) -> MachineSetupResponse:
    """Runs Gemini Robotics-ER to detect ROIs (stack_light, counter, hmi) on an un-cropped setup image.

    The setup frame itself is never stored to disk or Cloud Storage.
    """
    if not req.image_b64:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="image_b64 is required",
        )

    try:
        raw_bytes = base64.b64decode(req.image_b64)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid base64 image",
        )

    if len(raw_bytes) > MAX_REQUEST_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Image exceeds max size of {MAX_REQUEST_SIZE_BYTES // (1024 * 1024)} MB",
        )

    # Validate image format
    try:
        with Image.open(io.BytesIO(raw_bytes)) as img:
            img.verify()
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid image payload",
        )

    check_rate_limit(user.uid, "checks")

    try:
        parsed = call_robotics_er_setup(raw_bytes)
    except Exception as e:
        logger.warning(f"Robotics-ER setup call failed: {e}. Falling back to default center layout.")
        parsed = {
            "stack_light": [100, 200, 500, 350],
            "counter": [200, 450, 400, 750],
            "hmi": [450, 400, 850, 850],
        }

    raw_stack = parsed.get("stack_light") or [100, 200, 500, 350]
    stack_roi = normalize_box(raw_stack)

    counter_roi = None
    if parsed.get("counter"):
        counter_roi = normalize_box(parsed["counter"])

    hmi_roi = None
    if parsed.get("hmi"):
        hmi_roi = normalize_box(parsed["hmi"])

    return MachineSetupResponse(
        rois=RoisModel(
            stack_light=NormalizedRoiModel(**stack_roi),
            counter=NormalizedRoiModel(**counter_roi) if counter_roi else None,
            hmi=NormalizedRoiModel(**hmi_roi) if hmi_roi else None,
        )
    )


@router.post("/machines", status_code=status.HTTP_201_CREATED)
def create_machine(
    req: CreateMachineRequest,
    user: AuthUser = Depends(require_role("trainee", "supervisor", "master")),
) -> dict[str, Any]:
    """Creates a new machine configuration in Firestore."""
    db = get_firestore_client()
    machine_id = f"mach_{uuid.uuid4().hex[:12]}"
    now_iso = datetime.now(timezone.utc).isoformat()

    default_light_order = ["red", "yellow", "green"]
    default_state_map = {
        "red": "stopped",
        "yellow": "idle",
        "green": "running",
        "off": "stopped",
    }

    machine_data = {
        "id": machine_id,
        "name": req.name,
        "light_order": req.light_order or default_light_order,
        "state_map": req.state_map or default_state_map,
        "rois": req.rois.model_dump(),
        "ideal_cycle_s": req.ideal_cycle_s,
        "source": req.source,
        "created_by": user.uid,
        "created_at": now_iso,
        "updated_at": None,
        "last_state": None,
        "last_count": None,
        "last_seen_at": None,
    }

    db.collection("machines").document(machine_id).set(machine_data)
    return machine_data


@router.get("/machines")
def list_machines(
    user: AuthUser = Depends(verify_auth_token),
) -> list[dict[str, Any]]:
    """Returns all machines configured in the facility."""
    db = get_firestore_client()
    docs = db.collection("machines").stream()
    return [doc.to_dict() for doc in docs]


@router.get("/machines/{machine_id}")
def get_machine(
    machine_id: str,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    """Returns machine details."""
    db = get_firestore_client()
    doc = db.collection("machines").document(machine_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Machine {machine_id} not found",
        )
    return doc.to_dict()


@router.post("/machines/{machine_id}/read", response_model=MachineReadResponse)
def read_machine(
    machine_id: str,
    req: MachineReadRequest,
    user: AuthUser = Depends(require_role("trainee", "supervisor", "master")),
) -> MachineReadResponse:
    """Reads cropped images of a machine using Gemini Flash-Lite and performs count & state sanity validation."""
    db = get_firestore_client()
    machine_ref = db.collection("machines").document(machine_id)
    doc = machine_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Machine {machine_id} not found",
        )

    machine_data = doc.to_dict() or {}

    # Validate crop payload: at least one crop present
    crops = req.crops
    if not crops.stack_light_b64 and not crops.counter_b64 and not crops.hmi_b64:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one crop (stack_light_b64, counter_b64, or hmi_b64) must be provided",
        )

    # Validate crop sizes and dimensions <= 512 px and <= 300 KB
    stack_bytes = validate_crop_image(crops.stack_light_b64, "stack_light_b64") if crops.stack_light_b64 else None
    counter_bytes = validate_crop_image(crops.counter_b64, "counter_b64") if crops.counter_b64 else None
    hmi_bytes = validate_crop_image(crops.hmi_b64, "hmi_b64") if crops.hmi_b64 else None

    # Check rolling cap and daily checks rate limit
    check_machine_rate_limit(machine_id)
    check_rate_limit(user.uid, "checks")

    # Build Gemini prompt
    light_order = machine_data.get("light_order") or ["red", "yellow", "green"]
    state_map = machine_data.get("state_map") or {
        "red": "stopped",
        "yellow": "idle",
        "green": "running",
        "off": "stopped",
    }
    light_order_str = ", ".join(light_order)
    light_options_str = "/".join(light_order)

    prompt = (
        f"You are an industrial vision monitor inspecting crop images of a factory machine.\n"
        f"The machine's physical stack light has lights ordered from top to bottom: {light_order_str}.\n"
        f"Inspect the provided crop image(s):\n"
        f"- For the stack light crop: determine which light is illuminated ({light_options_str} or 'off').\n"
        f"- For the parts counter crop (if provided): read the numeric integer digits displayed on the counter, or null if unreadable.\n"
        f"- For the HMI crop (if provided): return the alarm text exactly as shown on the screen, or null if no alarm or screen is clear.\n"
        f"Answer in JSON."
    )

    crops_list = [b for b in (stack_bytes, counter_bytes, hmi_bytes) if b is not None]

    t0 = time.time()
    try:
        parsed = call_flash_lite_read(prompt, crops_list)
    except Exception as e:
        logger.error(f"Gemini machine read error: {e}")
        parsed = {
            "light": "unknown",
            "count": None,
            "alarm_text": None,
        }
    model_ms = int((time.time() - t0) * 1000)

    detected_light = (parsed.get("light") or "off").lower().strip()
    raw_count = parsed.get("count")
    alarm_text = parsed.get("alarm_text")
    if alarm_text and alarm_text.lower() in ("none", "null", "no alarm", "normal", "clear", ""):
        alarm_text = None

    # Map light -> state
    detected_state = state_map.get(detected_light)
    if not detected_state:
        if detected_light == "red":
            detected_state = "stopped"
        elif detected_light == "green":
            detected_state = "running"
        elif detected_light == "yellow":
            detected_state = "idle"
        else:
            detected_state = "unknown"

    if alarm_text:
        detected_state = "stopped"

    # Count Sanity Validation
    last_count = machine_data.get("last_count")
    ideal_cycle_s = float(machine_data.get("ideal_cycle_s", 10.0))
    last_seen_at_str = machine_data.get("last_seen_at")
    last_misread_count = machine_data.get("last_misread_count")

    now = datetime.now(timezone.utc)
    elapsed_s = 10.0
    if last_seen_at_str:
        try:
            last_dt = datetime.fromisoformat(last_seen_at_str.replace("Z", "+00:00"))
            elapsed_s = max(0.1, (now - last_dt).total_seconds())
        except Exception:
            elapsed_s = 10.0

    accepted_count = last_count
    count_flag: str | None = None

    if raw_count is not None and raw_count >= 0:
        if last_count is None:
            accepted_count = raw_count
        else:
            delta = raw_count - last_count
            max_delta = max(3, int(3.0 * (elapsed_s / ideal_cycle_s)))
            if 0 <= delta <= max_delta:
                accepted_count = raw_count
            elif delta < 0:
                # Potential counter reset: accept only if two consecutive reads agree
                if last_misread_count == raw_count:
                    accepted_count = raw_count
                else:
                    accepted_count = last_count
                    count_flag = "rejected_misread"
            else:
                accepted_count = last_count
                count_flag = "rejected_misread"

    # Evidence Upload (only when alarm triggered and HMI crop provided)
    evidence_path: str | None = None
    event_id = f"mev_{uuid.uuid4().hex[:12]}"
    if alarm_text and hmi_bytes:
        try:
            evidence_path = upload_machine_evidence_jpeg(machine_id, event_id, hmi_bytes)
        except Exception as e:
            logger.warning(f"Failed to upload alarm evidence to Storage: {e}")

    # Compute run_s for video/live soak runs
    run_s: float | None = None
    if req.video_run_s is not None:
        run_s = req.video_run_s
    elif req.soak_run_id:
        soak_doc = db.collection("soak_runs").document(req.soak_run_id).get()
        if soak_doc.exists:
            soak_started = soak_doc.to_dict().get("started_at")
            if soak_started:
                try:
                    s_dt = datetime.fromisoformat(soak_started.replace("Z", "+00:00"))
                    run_s = max(0.0, (now - s_dt).total_seconds())
                except Exception:
                    pass

    # Store Machine Event
    event_type = "alarm" if alarm_text else ("count" if count_flag == "rejected_misread" else "state_change")
    now_iso = now.isoformat()

    event_data = {
        "id": event_id,
        "machine_id": machine_id,
        "ts": now_iso,
        "event_type": event_type,
        "state": detected_state,
        "light": detected_light,
        "count": accepted_count,
        "alarm_code": alarm_text,
        "evidence_path": evidence_path,
        "run_s": run_s,
        "soak_run_id": req.soak_run_id,
        "detected_by": req.detected_by,
        "flag": count_flag,
        "ms": model_ms,
    }

    db.collection("machine_events").document(event_id).set(event_data)
    stream_machine_event(event_data)

    # Update machine latest state
    update_data = {
        "last_state": detected_state,
        "last_count": accepted_count,
        "last_seen_at": now_iso,
        "last_misread_count": raw_count if count_flag == "rejected_misread" else None,
    }
    machine_ref.update(update_data)

    return MachineReadResponse(
        state=detected_state,
        light=detected_light,
        count=accepted_count,
        alarm_code=alarm_text,
        ms=model_ms,
    )


# --- Soak Runs Endpoints ---

@router.post("/soak", status_code=status.HTTP_201_CREATED)
def start_soak_run(
    req: StartSoakRequest,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    """Starts a new soak test run. Any signed-in user can initiate a soak run."""
    db = get_firestore_client()
    soak_id = f"soak_{uuid.uuid4().hex[:12]}"
    now_iso = datetime.now(timezone.utc).isoformat()

    soak_data = {
        "id": soak_id,
        "created_by": user.uid,
        "started_at": now_iso,
        "ended_at": None,
        "duration_min": req.duration_min,
        "schedule_seed": req.schedule_seed,
        "machines": req.machines,
        "status": "running",
    }

    db.collection("soak_runs").document(soak_id).set(soak_data)
    return soak_data


@router.post("/soak/{soak_id}/end")
def end_soak_run(
    soak_id: str,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    """Ends an ongoing soak test run. Must be run creator or supervisor."""
    db = get_firestore_client()
    soak_ref = db.collection("soak_runs").document(soak_id)
    doc = soak_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Soak run {soak_id} not found",
        )

    data = doc.to_dict() or {}
    if data.get("created_by") != user.uid and user.role != "supervisor":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: only creator or supervisor can terminate soak run",
        )

    now_iso = datetime.now(timezone.utc).isoformat()
    soak_ref.update({
        "status": "completed",
        "ended_at": now_iso,
    })
    return {
        "id": soak_id,
        "status": "completed",
        "ended_at": now_iso,
    }


@router.post("/soak/{soak_id}/truth")
def post_soak_truth(
    soak_id: str,
    req: SoakTruthRequest,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    """Posts a ground truth event to a running soak test.

    Allowed only if run exists, status == 'running' and created_by == caller (else 403/409).
    """
    db = get_firestore_client()
    soak_ref = db.collection("soak_runs").document(soak_id)
    doc = soak_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Soak run {soak_id} not found",
        )

    data = doc.to_dict() or {}
    if data.get("status") != "running":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Soak run {soak_id} is not running (status: {data.get('status')})",
        )

    if data.get("created_by") != user.uid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: caller is not the soak run creator",
        )

    truth_id = f"tr_{uuid.uuid4().hex[:12]}"
    truth_data = {
        "id": truth_id,
        "machine_id": req.machine_id,
        "ts": req.ts,
        "run_s": req.run_s,
        "event_type": req.event_type,
        "state": req.state,
        "count": req.count,
        "alarm_code": req.alarm_code,
    }

    soak_ref.collection("truth").document(truth_id).set(truth_data)
    return {
        "status": "ok",
        "truth_id": truth_id,
    }
