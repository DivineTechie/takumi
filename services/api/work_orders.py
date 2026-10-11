"""Work orders drafted by the maintenance agent (Forge): list, approve or dismiss, and speak the alert.

The agent only drafts. A supervisor approves or dismisses every work order here, and the decision is
published to the events pipeline. The operator alert can be spoken in the floor's language: the
translation and the audio are made once per language and cached in Cloud Storage.
"""

from __future__ import annotations

import base64
import logging
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

from services.api.auth import AuthUser, get_firestore_client, require_role
from services.api.events_bus import publish_event
from services.api.model_armor import screen_text
from services.api.speech import LANGUAGE_NAMES, synthesize_speech, translate_short
from services.api.storage_client import download_blob_bytes, upload_blob_bytes

logger = logging.getLogger("takumi.work_orders")

router = APIRouter(tags=["work_orders"])


@router.get("/work-orders")
def list_work_orders(
    status_filter: Literal["draft", "approved", "dismissed", "all"] = "all",
    user: AuthUser = Depends(require_role("supervisor")),
) -> list[dict[str, Any]]:
    """Newest 30 work orders."""
    db = get_firestore_client()
    col = db.collection("work_orders")
    query = col if status_filter == "all" else col.where("status", "==", status_filter)
    rows = [d.to_dict() or {} for d in query.stream()]
    rows.sort(key=lambda w: str(w.get("created_at") or ""), reverse=True)
    return rows[:30]


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["approve", "dismiss"]
    note: str | None = Field(default=None, max_length=300)


@router.post("/work-orders/{wo_id}/decision")
def decide_work_order(wo_id: str, req: Decision, user: AuthUser = Depends(require_role("supervisor"))) -> dict[str, Any]:
    db = get_firestore_client()
    ref = db.collection("work_orders").document(wo_id)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Work order not found")
    wo = snap.to_dict() or {}
    if wo.get("status") != "draft":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Work order already decided")
    note = (req.note or "").strip() or None
    # The note is shown to the agent later as history, so it is screened like any user text.
    if note and not screen_text(note, purpose="question").get("allowed"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Note was blocked by content screening")
    new_status = "approved" if req.decision == "approve" else "dismissed"
    now = datetime.now(timezone.utc).isoformat()
    ref.update({"status": new_status, "decided_at": now, "decided_by": user.uid, "decision_note": note})
    publish_event(
        "machine", f"work_order_{new_status}", ts=now, entity_id=wo_id, machine_id=wo.get("machine_id"), status=new_status,
        source=wo.get("source"), detail={"title": (wo.get("draft") or {}).get("title"), "alarm_text": wo.get("alarm_text"),
                                         "priority": (wo.get("draft") or {}).get("priority")},
    )
    return {"id": wo_id, "status": new_status, "decided_at": now}


class SpeakRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    language: Literal["en", "ja", "vi", "hi", "id", "fil"] = "en"


@router.post("/work-orders/{wo_id}/speak")
async def speak_work_order(wo_id: str, req: SpeakRequest, user: AuthUser = Depends(require_role("supervisor"))) -> Response:
    """Returns the operator alert as WAV audio in the requested language (header X-Spoken-Text-B64 carries the text)."""
    db = get_firestore_client()
    ref = db.collection("work_orders").document(wo_id)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Work order not found")
    wo = snap.to_dict() or {}
    alert = str((wo.get("draft") or {}).get("operator_alert") or "").strip()
    if not alert:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Work order has no alert")

    spoken = wo.get("spoken") or {}
    cached = spoken.get(req.language) or {}
    audio: bytes | None = None
    text = cached.get("text")
    if cached.get("path"):
        try:
            audio = download_blob_bytes(cached["path"], use_cache=False)
        except Exception as e:
            logger.warning("Cached alert audio missing for %s/%s: %s", wo_id, req.language, e)
    if audio is None:
        try:
            text = await translate_short(alert, req.language)
            audio = await synthesize_speech(text)
        except Exception as e:
            logger.error("Speaking work order %s in %s failed: %s", wo_id, req.language, e)
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not make the spoken alert")
        path = f"work_orders/{wo_id}/alert_{req.language}.wav"
        try:
            upload_blob_bytes(path, audio, content_type="audio/wav")
            ref.update({f"spoken.{req.language}": {"text": text, "path": path}})
        except Exception as e:
            logger.warning("Could not cache alert audio for %s: %s", wo_id, e)

    return Response(
        content=audio,
        media_type="audio/wav",
        headers={
            "X-Spoken-Text-B64": base64.b64encode((text or "").encode("utf-8")).decode("ascii"),
            "X-Spoken-Language": LANGUAGE_NAMES[req.language],
            "Cache-Control": "no-store",
        },
    )
