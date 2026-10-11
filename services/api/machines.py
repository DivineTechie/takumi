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

import asyncio
import base64
from datetime import datetime, timedelta, timezone
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
from services.api.bigquery_client import stream_api_call, stream_machine_event
from services.api.events_bus import publish_event
from services.api.config import (
    LIMIT_MACHINE_READS_PER_MIN,
    MACHINE_CROP_MAX_BYTES,
    MACHINE_CROP_MAX_PX,
    MAX_REQUEST_SIZE_BYTES,
    MODEL_FLASH_LITE,
    MODEL_ROBOTICS_ER,
    POINT_THINKING,
    TIMEOUT_MACHINE_READ_S,
    TIMEOUT_MACHINE_SETUP_S,
)
from services.api.gemini import _parse_thinking_config, get_genai_client
from services.api.machine_stats import compute_machine_day
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
    machine_count: int = Field(1, ge=1, le=6)
    machine_index: int = Field(1, ge=1, le=6)


class SetupBoxesGeminiResponse(BaseModel):
    """Robotics-ER output: [ymin, xmin, ymax, xmax] boxes on a 0-1000 scale."""

    stack_light: list[int] | None = None
    counter: list[int] | None = None
    hmi: list[int] | None = None


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
    bench_slot: int | None = Field(None, ge=1, le=6)


class MachineCrops(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stack_light_b64: str | None = None
    counter_b64: str | None = None
    hmi_b64: str | None = None


class MachineReadGeminiResponse(BaseModel):
    # Used as the Gemini response_schema: no extra="forbid", because the API rejects additionalProperties.
    light: Literal["red", "yellow", "green", "off", "multiple", "unclear"]
    count: int | None = None
    alarm_text: str | None = None
    alarm_active: bool = False


class MachineReadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    crops: MachineCrops
    video_run_s: float | None = None
    soak_run_id: str | None = None
    detected_by: Literal["edge", "gemini"] = "gemini"
    reason: Literal["change", "heartbeat"] = "change"


class MachineReadResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: str | None = None
    light: str | None = None
    count: int | None = None
    alarm_text: str | None = None
    alarm_code: str | None = None
    changed: bool = False
    ms: int


class StartSoakRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    duration_min: float = Field(..., ge=0.5)
    schedule_seed: int | str
    machines: list[str] = Field(..., min_length=1)


class SoakTruthRequest(BaseModel):
    """Truth event from the test bench. ts and run_s are set by the server; client values are ignored."""

    model_config = ConfigDict(extra="forbid")
    machine_id: str = Field(..., min_length=1, max_length=64)
    ts: str | None = None
    run_s: float | None = None
    event_type: Literal["state_change", "alarm", "alarm_cleared", "count"]
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


def build_setup_prompt(machine_count: int, machine_index: int) -> str:
    """Builds the Robotics-ER setup prompt for one machine in the frame."""
    if machine_count > 1:
        target = (
            f"The image shows {machine_count} machines side by side. "
            f"Only locate the parts of machine number {machine_index}, counting from the left."
        )
    else:
        target = "The image shows one machine."
    return (
        f"{target}\n"
        "Locate these parts of that machine:\n"
        "- stack_light: the coloured lamps of the signal light tower (box the lamps only, not the pole or base).\n"
        "- counter: the numeric parts/cycle counter display.\n"
        "- hmi: the operator screen that shows status or alarm text.\n"
        'Return JSON: {"stack_light": [ymin, xmin, ymax, xmax], "counter": [ymin, xmin, ymax, xmax] or null, '
        '"hmi": [ymin, xmin, ymax, xmax] or null}, with coordinates normalised to 0-1000. '
        "Use null for a part that is not visible."
    )


def call_robotics_er_setup(
    raw_bytes: bytes,
    machine_count: int = 1,
    machine_index: int = 1,
    client: genai.Client | None = None,
) -> dict[str, Any]:
    """Invokes gemini-robotics-er-2-preview to detect machine component regions of interest."""
    if client is None:
        client = get_genai_client()

    contents = [
        types.Part.from_bytes(data=raw_bytes, mime_type="image/jpeg"),
        build_setup_prompt(machine_count, machine_index),
    ]
    cfg = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=SetupBoxesGeminiResponse,
        thinking_config=_parse_thinking_config(POINT_THINKING),
    )
    with trace_gemini_call("machines.setup", MODEL_ROBOTICS_ER):
        res = client.models.generate_content(
            model=MODEL_ROBOTICS_ER,
            contents=contents,
            config=cfg,
        )
    return json.loads(res.text)


NOT_ALARMS = {"", "NONE", "NULL", "NO ALARM", "NORMAL", "CLEAR", "OK", "RUNNING", "RUN", "IDLE", "STOPPED", "STOP", "READY", "AUTO", "MANUAL", "STANDBY"}

READ_PROMPT_TEMPLATE = """You are an industrial vision monitor inspecting cropped regions of a factory machine.
This inspection includes the following crops: {included_crops_str}.
The machine's physical stack light has lights ordered from top to bottom: {light_order_str}.

Task instructions:
- Stack light: identify which light is illuminated ('red', 'yellow', 'green', 'off', 'multiple' if more than one is illuminated, or 'unclear' if not legible).
- Parts counter: read the numeric integer value displayed on the counter, or null if unreadable or absent.
- HMI screen: an alarm is a fault, error or warning message (often with a code). Return its text exactly as shown and set alarm_active to true. Normal status words such as RUNNING, IDLE, STOPPED, READY, AUTO or MANUAL are not alarms: then return null and alarm_active false. Also return null when the screen is blank or absent.

Answer in JSON conforming to the schema."""


async def call_flash_lite_read(
    prompt: str,
    labeled_crops: list[tuple[str, bytes]],
    client: genai.Client | None = None,
    usage_out: dict[str, int] | None = None,
) -> MachineReadGeminiResponse:
    """Invokes gemini-3.5-flash-lite on machine crops to read stack light, counter, and alarms.

    When usage_out is given it receives the call's token counts (for soak-run cost reporting).
    """
    if client is None:
        client = get_genai_client()

    contents: list[Any] = [prompt]
    for label, b in labeled_crops:
        contents.append(f"{label}:")
        contents.append(types.Part.from_bytes(data=b, mime_type="image/jpeg"))

    cfg = types.GenerateContentConfig(
        response_schema=MachineReadGeminiResponse,
        response_mime_type="application/json",
    )

    def _sync():
        with trace_gemini_call("machines.read", MODEL_FLASH_LITE):
            return client.models.generate_content(
                model=MODEL_FLASH_LITE,
                contents=contents,
                config=cfg,
            )

    res = await asyncio.wait_for(
        asyncio.to_thread(_sync),
        timeout=TIMEOUT_MACHINE_READ_S,
    )
    if usage_out is not None and res.usage_metadata is not None:
        u = res.usage_metadata
        usage_out["tokens_in"] = u.prompt_token_count or 0
        usage_out["tokens_out"] = (u.candidates_token_count or 0) + (u.thoughts_token_count or 0)
    data = json.loads(res.text)
    return MachineReadGeminiResponse.model_validate(data)


# --- Endpoints ---

@router.post("/machines/setup", response_model=MachineSetupResponse)
async def setup_machine(
    req: MachineSetupRequest,
    user: AuthUser = Depends(require_role("trainee", "supervisor", "master")),
) -> MachineSetupResponse:
    """Runs Gemini Robotics-ER to detect ROIs (stack_light, counter, hmi) on an un-cropped setup image.

    The setup frame itself is never stored to disk or Cloud Storage. If the model call fails, no
    boxes are invented: the caller gets an error and can retry or draw the boxes by hand.
    """
    if not req.image_b64:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="image_b64 is required",
        )
    if req.machine_index > req.machine_count:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="machine_index must be between 1 and machine_count",
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
        parsed = await asyncio.wait_for(
            asyncio.to_thread(call_robotics_er_setup, raw_bytes, req.machine_count, req.machine_index),
            timeout=TIMEOUT_MACHINE_SETUP_S,
        )
    except (asyncio.TimeoutError, TimeoutError):
        logger.warning("Robotics-ER setup timed out")
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Machine setup timed out. Try again or draw the boxes by hand.",
        )
    except Exception as e:
        logger.warning("Robotics-ER setup failed: %s", e)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Machine setup failed. Try again or draw the boxes by hand.",
        )

    try:
        raw_stack = parsed.get("stack_light")
        if not raw_stack:
            raise ValueError("no stack light found")
        stack_roi = normalize_box(raw_stack)
        counter_roi = normalize_box(parsed["counter"]) if parsed.get("counter") else None
        hmi_roi = normalize_box(parsed["hmi"]) if parsed.get("hmi") else None
    except (ValueError, TypeError) as e:
        logger.warning("Robotics-ER setup returned unusable boxes: %s", e)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No stack light was found. Point the camera at the machine and try again.",
        )

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
    }

    machine_data = {
        "id": machine_id,
        "name": req.name,
        "light_order": req.light_order or default_light_order,
        "state_map": req.state_map or default_state_map,
        "rois": req.rois.model_dump(),
        "ideal_cycle_s": req.ideal_cycle_s,
        "source": req.source,
        "bench_slot": req.bench_slot,
        "created_by": user.uid,
        "created_at": now_iso,
        "updated_at": None,
        "state": None,
        "last_alarm": None,
        "last_count": None,
        "last_seen_at": None,
    }

    db.collection("machines").document(machine_id).set(machine_data)
    return machine_data


@router.get("/machines")
def list_machines(
    user: AuthUser = Depends(verify_auth_token),
) -> list[dict[str, Any]]:
    """Returns the machines in use (removed machines are left out), oldest first."""
    db = get_firestore_client()
    machines = [doc.to_dict() or {} for doc in db.collection("machines").stream()]
    machines = [m for m in machines if not m.get("archived")]
    machines.sort(key=lambda m: str(m.get("created_at") or ""))
    return machines


@router.post("/machines/{machine_id}/remove")
def remove_machine(
    machine_id: str,
    user: AuthUser = Depends(require_role("trainee", "supervisor", "master")),
) -> dict[str, Any]:
    """Hides a machine from lists (for example a duplicate setup). Its events and history are kept.

    Allowed for supervisors and for the user who set the machine up.
    """
    db = get_firestore_client()
    ref = db.collection("machines").document(machine_id)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Machine {machine_id} not found")
    data = snap.to_dict() or {}
    if user.role != "supervisor" and data.get("created_by") != user.uid:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only a supervisor or the person who set it up can remove it")
    ref.update({"archived": True, "archived_at": datetime.now(timezone.utc).isoformat(), "archived_by": user.uid})
    return {"id": machine_id, "archived": True}


@router.get("/machines/summary")
def machines_summary(
    day: str | None = None,
    user: AuthUser = Depends(require_role("supervisor")),
) -> dict[str, Any]:
    """Per-machine day summary for the dashboard: state timeline, availability, stops, alarms, parts, OEE parts.

    day is YYYY-MM-DD in UTC (default: today). Only real machine_events are used; empty days return zeros/None.
    """
    now = datetime.now(timezone.utc)
    try:
        day_start = (
            datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            if day
            else now.replace(hour=0, minute=0, second=0, microsecond=0)
        )
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="day must be YYYY-MM-DD")
    day_end = min(day_start + timedelta(days=1), now)

    db = get_firestore_client()
    machines = [m for m in (d.to_dict() or {} for d in db.collection("machines").stream()) if not m.get("archived")]
    events_by_machine: dict[str, list[dict[str, Any]]] = {}
    for d in db.collection("machine_events").where("ts", ">=", day_start.isoformat()).stream():
        ev = d.to_dict() or {}
        events_by_machine.setdefault(ev.get("machine_id", ""), []).append(ev)

    out = []
    for m in machines:
        stats = compute_machine_day(
            events_by_machine.get(m.get("id", ""), []),
            float(m.get("ideal_cycle_s") or 10.0),
            day_start,
            day_end,
        )
        out.append({
            "id": m.get("id"),
            "name": m.get("name"),
            "bench_slot": m.get("bench_slot"),
            "state": m.get("state"),
            "last_alarm": m.get("last_alarm"),
            "last_count": m.get("last_count"),
            "last_seen_at": m.get("last_seen_at"),
            **stats,
        })
    out.sort(key=lambda r: (r.get("name") or "", r.get("id") or ""))
    return {"day": day_start.date().isoformat(), "window_end": day_end.isoformat(), "machines": out}


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
async def read_machine(
    machine_id: str,
    req: MachineReadRequest,
    user: AuthUser = Depends(require_role("trainee", "supervisor", "master")),
) -> MachineReadResponse:
    """Reads cropped images of a machine using Gemini Flash-Lite and performs count & state sanity validation."""
    t_request = time.time()
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
    }
    light_order_str = ", ".join(light_order)

    labeled_crops: list[tuple[str, bytes]] = []
    included_labels: list[str] = []
    if stack_bytes is not None:
        labeled_crops.append(("Stack light crop", stack_bytes))
        included_labels.append("stack light")
    if counter_bytes is not None:
        labeled_crops.append(("Counter crop", counter_bytes))
        included_labels.append("parts counter")
    if hmi_bytes is not None:
        labeled_crops.append(("HMI screen crop", hmi_bytes))
        included_labels.append("HMI screen")

    included_crops_str = ", ".join(included_labels)
    prompt = READ_PROMPT_TEMPLATE.format(
        included_crops_str=included_crops_str,
        light_order_str=light_order_str,
    )

    usage: dict[str, int] = {}
    t0 = time.time()
    try:
        parsed = await call_flash_lite_read(prompt, labeled_crops, usage_out=usage)
    except (asyncio.TimeoutError, TimeoutError):
        logger.warning(f"Machine read timed out for machine {machine_id}")
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Gemini machine read timed out (8s limit exceeded)",
        )
    except Exception as e:
        logger.error(f"Gemini machine read error for machine {machine_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Gemini machine read failed",
        )
    model_ms = int((time.time() - t0) * 1000)

    detected_light = (parsed.light or "unclear").lower().strip()
    if detected_light in ("unclear", "multiple"):
        detected_state = None
    elif detected_light == "off":
        detected_state = state_map.get("off")
    else:
        detected_state = state_map.get(detected_light)

    alarm_text = (parsed.alarm_text or "").strip() if parsed.alarm_active else ""
    # Status words are never alarms, even if the model flags them (seen in a soak run: "IDLE").
    if alarm_text.upper().strip(" .!") in NOT_ALARMS:
        alarm_text = ""
    alarm_text = alarm_text or None

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

    raw_count = parsed.count
    accepted_count = last_count
    count_flag: str | None = None

    if raw_count is not None and counter_bytes is not None and raw_count >= 0:
        if last_count is None:
            accepted_count = raw_count
        else:
            delta = raw_count - last_count
            max_delta = max(3, int(3.0 * (elapsed_s / ideal_cycle_s)))
            if 0 <= delta <= max_delta:
                accepted_count = raw_count
            elif delta < 0:
                # A lower count is a reset (counter cleared, shift change) when the previous read was
                # also lower and this one follows on plausibly from it; one odd read is a misread.
                follows = last_misread_count is not None and 0 <= raw_count - last_misread_count <= max_delta
                if follows and last_misread_count < last_count:
                    accepted_count = raw_count
                else:
                    accepted_count = last_count
                    count_flag = "rejected_misread"
            else:
                accepted_count = last_count
                count_flag = "rejected_misread"

    machine_state = machine_data.get("state")
    machine_alarm = machine_data.get("last_alarm")

    machine_source = str(machine_data.get("source", "")).lower()
    event_source = "HOME RIG" if (req.soak_run_id or machine_source == "virtual") else "LIVE"

    events_to_write: list[dict[str, Any]] = []

    # 1. state_change: detected_state != machine.state and detected_state != "unknown" (store from_state, to_state)
    if detected_state is not None and detected_state != "unknown" and detected_state != machine_state:
        events_to_write.append({
            "event_type": "state_change",
            "from_state": machine_state,
            "to_state": detected_state,
            "state": detected_state,
            "light": detected_light,
        })

    # 2. alarm: alarm_text non-null and != machine.last_alarm;
    #    alarm_cleared: machine.last_alarm non-null and alarm_text null (only when an HMI crop was sent)
    if hmi_bytes is not None:
        if alarm_text is not None and alarm_text != machine_alarm:
            evidence_path = None
            ev_id = f"mev_{uuid.uuid4().hex[:12]}"
            try:
                evidence_path = upload_machine_evidence_jpeg(machine_id, ev_id, hmi_bytes)
            except Exception as e:
                logger.warning(f"Failed to upload alarm evidence to Storage: {e}")
            events_to_write.append({
                "id": ev_id,
                "event_type": "alarm",
                "alarm_text": alarm_text,
                "alarm_code": alarm_text,
                "evidence_path": evidence_path,
                "state": detected_state or machine_state,
                "light": detected_light,
            })
        elif machine_alarm is not None and alarm_text is None:
            events_to_write.append({
                "event_type": "alarm_cleared",
                "alarm_text": None,
                "alarm_code": None,
                "state": detected_state or machine_state,
                "light": detected_light,
            })

    # 3. count: accepted_count > last_count; rejected misreads are logged as event_type "count" with flag "rejected_misread"
    if count_flag == "rejected_misread":
        events_to_write.append({
            "event_type": "count",
            "count": raw_count,
            "flag": "rejected_misread",
            "state": detected_state or machine_state,
            "light": detected_light,
        })
    elif accepted_count is not None and (last_count is None or accepted_count > last_count):
        events_to_write.append({
            "event_type": "count",
            "count": accepted_count,
            "flag": None,
            "state": detected_state or machine_state,
            "light": detected_light,
        })

    # 4. heartbeat: only when reason == "heartbeat" and nothing else changed
    if req.reason == "heartbeat" and len(events_to_write) == 0:
        events_to_write.append({
            "event_type": "heartbeat",
            "state": machine_state,
            "light": detected_light,
            "count": last_count,
        })

    # Compute run_s for video/live soak runs, and count this read against the run (cost per machine)
    run_s: float | None = None
    if req.video_run_s is not None:
        run_s = req.video_run_s
    if req.soak_run_id:
        soak_ref = db.collection("soak_runs").document(req.soak_run_id)
        soak_doc = soak_ref.get()
        if soak_doc.exists:
            soak_started = (soak_doc.to_dict() or {}).get("started_at")
            if run_s is None and soak_started:
                try:
                    s_dt = datetime.fromisoformat(soak_started.replace("Z", "+00:00"))
                    run_s = max(0.0, (now - s_dt).total_seconds())
                except ValueError:
                    pass
            try:
                soak_ref.update({
                    f"reads.{machine_id}": firestore.Increment(1),
                    "tokens_in": firestore.Increment(usage.get("tokens_in", 0)),
                    "tokens_out": firestore.Increment(usage.get("tokens_out", 0)),
                })
            except Exception as e:
                logger.warning("Failed to count soak read: %s", e)

    now_iso = now.isoformat()
    changed = len(events_to_write) > 0

    for ev in events_to_write:
        ev_id = ev.get("id") or f"mev_{uuid.uuid4().hex[:12]}"
        ev["id"] = ev_id
        ev["machine_id"] = machine_id
        ev["ts"] = now_iso
        ev["run_s"] = run_s
        ev["soak_run_id"] = req.soak_run_id
        ev["source"] = event_source
        ev["detected_by"] = req.detected_by
        ev["ms"] = model_ms
        ev.setdefault("from_state", None)
        ev.setdefault("to_state", None)
        ev.setdefault("state", detected_state or machine_state)
        ev.setdefault("light", detected_light)
        ev.setdefault("count", accepted_count)
        ev.setdefault("alarm_text", None)
        ev.setdefault("alarm_code", None)
        ev.setdefault("evidence_path", None)
        ev.setdefault("flag", None)

        db.collection("machine_events").document(ev_id).set(ev)
        stream_machine_event(ev)
        publish_event(
            "machine", ev["event_type"], ts=now_iso, entity_id=ev_id, machine_id=machine_id, status=ev.get("state"),
            source=event_source, detail={k: ev.get(k) for k in ("from_state", "to_state", "alarm_text", "count", "light", "flag", "run_s")},
        )

    # Update machine document state and last_alarm
    update_data: dict[str, Any] = {
        "last_seen_at": now_iso,
        "updated_at": now_iso,
    }
    if detected_state is not None and detected_state != "unknown":
        update_data["state"] = detected_state
    if hmi_bytes is not None:
        update_data["last_alarm"] = alarm_text
    if accepted_count is not None:
        update_data["last_count"] = accepted_count
        update_data["last_misread_count"] = raw_count if count_flag == "rejected_misread" else None

    machine_ref.update(update_data)

    stream_api_call({
        "ts": now_iso,
        "endpoint": "machine_read",
        "status": 200,
        "model_ms": model_ms,
        "total_ms": int((time.time() - t_request) * 1000),
    })

    return MachineReadResponse(
        state=detected_state or machine_state,
        light=detected_light,
        count=accepted_count,
        alarm_text=alarm_text,
        alarm_code=alarm_text,
        changed=changed,
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


@router.get("/soak/mine")
def list_my_soak_runs(
    user: AuthUser = Depends(verify_auth_token),
) -> list[dict[str, Any]]:
    """The caller's 20 most recent soak runs (newest first), for picking a run on the watch page."""
    db = get_firestore_client()
    runs = [d.to_dict() or {} for d in db.collection("soak_runs").where("created_by", "==", user.uid).stream()]
    runs.sort(key=lambda r: str(r.get("started_at") or ""), reverse=True)
    return runs[:20]


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
    # Server clock only, so truth and detections share one time base.
    now = datetime.now(timezone.utc)
    run_s: float | None = None
    try:
        started = datetime.fromisoformat(str(data.get("started_at")).replace("Z", "+00:00"))
        run_s = round(max(0.0, (now - started).total_seconds()), 3)
    except ValueError:
        run_s = None

    truth_data = {
        "id": truth_id,
        "machine_id": req.machine_id,
        "ts": now.isoformat(),
        "run_s": run_s,
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
