"""Unit records and quality trace-back data (P16).

A unit is one physical product, identified by its serial. Each Station Watch session started with a
serial adds a station record (which station, which steps were verified, where mistakes or safety
stops happened, with evidence frames); each end-of-line inspection adds its result. Supervisors see
the full history, and can put units on hold (quarantine) and release them. Holds are always a human
decision; the trace-back agent only proposes them.
"""

import re
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from google.cloud import firestore
from pydantic import BaseModel, ConfigDict, Field

from services.api.auth import AuthUser, get_firestore_client, require_role, verify_auth_token
from services.api.config import STORAGE_BUCKET
from services.api.storage_client import get_signed_url_for_gs_uri

router = APIRouter(tags=["units"])

UNIT_ID_REGEX = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
ISSUE_EVENT_TYPES = ("mistake", "safety_stop", "blocked")


def build_station_record(session: dict[str, Any], events: list[dict[str, Any]], skill: dict[str, Any]) -> dict[str, Any]:
    """Summarises one finished Station Watch session for the unit's record (pure function)."""
    steps = session.get("steps") or []
    result = session.get("result") or {}
    titles = {
        s.get("n"): (s.get("title") or s.get("instruction") or "")[:120] or None for s in (skill.get("steps") or [])
    }
    issues = []
    for e in sorted(events, key=lambda e: str(e.get("t") or "")):
        if e.get("type") in ISSUE_EVENT_TYPES:
            issues.append({
                "step": e.get("step"),
                "step_title": titles.get(e.get("step")),
                "type": e.get("type"),
                "reason": e.get("reason"),
                "t": e.get("t"),
                "frame_uri": e.get("frame_uri"),
            })
    return {
        "session_id": session.get("id"),
        "skill_id": session.get("skill_id"),
        "station": skill.get("title") or session.get("skill_id"),
        "operator_uid": session.get("trainee_uid"),
        "status": session.get("status"),
        "started_at": session.get("started_at"),
        "ended_at": session.get("ended_at"),
        "steps_total": len(steps),
        "steps_done": result.get("steps_done", sum(1 for s in steps if s.get("state") == "done")),
        "incomplete_steps": [s.get("n") for s in steps if s.get("state") != "done"],
        "mistakes": result.get("mistakes", 0),
        "safety_stops": result.get("safety_stops", 0),
        "issues": issues,
    }


def ensure_unit(db: Any, unit_id: str, product_id: str | None, uid: str) -> None:
    """Creates the unit if it does not exist yet (status in_progress)."""
    ref = db.collection("units").document(unit_id)
    if ref.get().exists:
        if product_id:
            ref.set({"product_id": product_id}, merge=True)
        return
    ref.set({
        "id": unit_id,
        "product_id": product_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "in_progress",
        "station_records": [],
        "inspections": [],
        "created_by": uid,
    })


def append_station_record(db: Any, unit_id: str, record: dict[str, Any]) -> None:
    db.collection("units").document(unit_id).update({"station_records": firestore.ArrayUnion([record])})


def _can_read(user: AuthUser, unit: dict[str, Any]) -> bool:
    return user.role == "supervisor" or unit.get("created_by") == user.uid


def _signed(uri: str | None) -> str | None:
    if not uri:
        return None
    gs = uri if uri.startswith("gs://") else f"gs://{STORAGE_BUCKET}/{uri}"
    try:
        return get_signed_url_for_gs_uri(gs)
    except Exception:
        return None


@router.get("/units")
def list_units(
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    user: AuthUser = Depends(require_role("supervisor")),
) -> list[dict[str, Any]]:
    """Most recent units (newest first), optionally filtered by status, without heavy fields."""
    db = get_firestore_client()
    query = db.collection("units")
    if status_filter:
        query = query.where("status", "==", status_filter)
    units = [d.to_dict() or {} for d in query.stream()]
    units.sort(key=lambda u: str(u.get("created_at") or ""), reverse=True)
    return [
        {
            "id": u.get("id"),
            "product_id": u.get("product_id"),
            "status": u.get("status"),
            "created_at": u.get("created_at"),
            "stations": len(u.get("station_records") or []),
            "inspections": len(u.get("inspections") or []),
            "issues": sum(len(r.get("issues") or []) for r in (u.get("station_records") or [])),
        }
        for u in units[:limit]
    ]


@router.get("/units/{unit_id}/history")
def unit_history(
    unit_id: str,
    user: AuthUser = Depends(verify_auth_token),
) -> dict[str, Any]:
    """Full unit history: station records (with signed evidence frames) and inspections (with photos)."""
    if not UNIT_ID_REGEX.match(unit_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid unit_id")
    db = get_firestore_client()
    doc = db.collection("units").document(unit_id).get()
    if not doc.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Unit '{unit_id}' not found")
    unit = doc.to_dict() or {}
    if not _can_read(user, unit):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden: access denied to this unit")

    records = []
    for r in unit.get("station_records") or []:
        r = dict(r)
        r["issues"] = [{**i, "frame_url": _signed(i.get("frame_uri"))} for i in (r.get("issues") or [])]
        if user.role != "supervisor":
            r.pop("operator_uid", None)
        records.append(r)

    inspections = []
    for insp_id in unit.get("inspections") or []:
        snap = db.collection("inspections").document(insp_id).get()
        if not snap.exists:
            continue
        i = snap.to_dict() or {}
        confirm = i.get("confirm") or {}
        screen = i.get("screen") or {}
        inspections.append({
            "id": insp_id,
            "created_at": i.get("created_at"),
            "ai_verdict": i.get("ai_verdict"),
            "defect": confirm.get("defect") or screen.get("defect"),
            "where": confirm.get("where") or screen.get("where"),
            "human_decision": i.get("human_decision"),
            "mode": i.get("mode"),
            "source": i.get("source"),
            "image_url": _signed(i.get("image_path")),
        })
    inspections.sort(key=lambda i: str(i.get("created_at") or ""))

    return {
        "id": unit.get("id", unit_id),
        "product_id": unit.get("product_id"),
        "status": unit.get("status"),
        "created_at": unit.get("created_at"),
        "holds": unit.get("holds") or [],
        "station_records": records,
        "inspections": inspections,
    }


class HoldRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    unit_ids: list[str] = Field(..., min_length=1, max_length=200)
    reason: str = Field(..., min_length=3, max_length=500)
    source: Literal["traceback", "manual"] = "manual"


@router.post("/units/hold")
def hold_units(req: HoldRequest, user: AuthUser = Depends(require_role("supervisor"))) -> dict[str, Any]:
    """Puts units on hold (quarantine). Failed units stay failed; already-held units are skipped."""
    db = get_firestore_client()
    now = datetime.now(timezone.utc).isoformat()
    held, skipped = [], []
    for unit_id in dict.fromkeys(req.unit_ids):
        if not UNIT_ID_REGEX.match(unit_id):
            skipped.append({"id": unit_id, "reason": "invalid id"})
            continue
        ref = db.collection("units").document(unit_id)
        snap = ref.get()
        if not snap.exists:
            skipped.append({"id": unit_id, "reason": "not found"})
            continue
        unit = snap.to_dict() or {}
        if unit.get("status") in ("failed", "on_hold"):
            skipped.append({"id": unit_id, "reason": f"already {unit.get('status')}"})
            continue
        ref.update({
            "status": "on_hold",
            "holds": firestore.ArrayUnion([{
                "at": now,
                "by_uid": user.uid,
                "reason": req.reason,
                "source": req.source,
                "previous_status": unit.get("status"),
            }]),
        })
        held.append(unit_id)
    return {"held": held, "skipped": skipped}


@router.post("/units/{unit_id}/release")
def release_unit(unit_id: str, user: AuthUser = Depends(require_role("supervisor"))) -> dict[str, Any]:
    """Releases a held unit back to the status it had before the hold."""
    if not UNIT_ID_REGEX.match(unit_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid unit_id")
    db = get_firestore_client()
    ref = db.collection("units").document(unit_id)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Unit '{unit_id}' not found")
    unit = snap.to_dict() or {}
    if unit.get("status") != "on_hold":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Unit is not on hold")
    holds = unit.get("holds") or []
    previous = (holds[-1].get("previous_status") if holds else None) or "in_progress"
    ref.update({"status": previous, "released_at": datetime.now(timezone.utc).isoformat(), "released_by_uid": user.uid})
    return {"id": unit_id, "status": previous}
