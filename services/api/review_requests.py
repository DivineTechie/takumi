"""Review requests: a supervisor sends a suggested work-instruction change to the Standard Work Studio.

Typically the suggestion comes from the quality trace-back agent and the supervisor approves sending
it. Masters then apply or dismiss it in the Studio (Firestore rules let them change only the status).
"""

from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from services.api.auth import AuthUser, get_firestore_client, require_role

router = APIRouter(tags=["review_requests"])


class ReviewRequestCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skill_id: str = Field(..., min_length=1, max_length=128)
    step: int = Field(..., ge=1)
    reason: str = Field(..., min_length=3, max_length=1000)
    suggested_instruction: str = Field(..., min_length=3, max_length=1000)
    suggested_success_criteria: str | None = Field(default=None, max_length=1000)
    source: Literal["traceback", "supervisor"] = "supervisor"
    unit_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9._-]{1,64}$")


@router.post("/review-requests", status_code=status.HTTP_201_CREATED)
def create_review_request(req: ReviewRequestCreate, user: AuthUser = Depends(require_role("supervisor"))) -> dict[str, Any]:
    """Creates an open review request for one step of an existing skill."""
    db = get_firestore_client()
    skill = db.collection("skills").document(req.skill_id).get()
    if not skill.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill not found")
    steps = (skill.to_dict() or {}).get("steps") or []
    if not any(s.get("n") == req.step for s in steps):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Step {req.step} not found in this skill")

    data: dict[str, Any] = {
        "skill_id": req.skill_id,
        "step": req.step,
        "reason": req.reason,
        "suggested_instruction": req.suggested_instruction,
        "status": "open",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": req.source,
        "unit_id": req.unit_id,
        "created_by_uid": user.uid,
    }
    if req.suggested_success_criteria:
        data["suggested_success_criteria"] = req.suggested_success_criteria
    ref = db.collection("review_requests").document()
    ref.set(data)
    return {"id": ref.id, **data}
