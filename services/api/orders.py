"""Orders for the demand agent: a supervisor enters today's orders; status is projected live.

The projection (parts made, recent rate, yield, shortfall) is computed by shared.ops.demand from real
Machine Watch counts and inspections, so the API and the agent always show the same numbers.
"""

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from services.api.auth import AuthUser, get_firestore_client, require_role
from shared.ops.demand import order_status

router = APIRouter(tags=["orders"])


class OrderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(..., min_length=1, max_length=100)
    quantity: int = Field(..., ge=1, le=1_000_000)
    due_at: datetime
    machine_ids: list[str] = Field(..., min_length=1, max_length=6)
    product_id: str | None = Field(default=None, max_length=64)


@router.post("/orders", status_code=status.HTTP_201_CREATED)
def create_order(req: OrderCreate, user: AuthUser = Depends(require_role("supervisor"))) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    due = req.due_at if req.due_at.tzinfo else req.due_at.replace(tzinfo=timezone.utc)
    if due <= now:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Due time must be in the future")
    db = get_firestore_client()
    for mid in dict.fromkeys(req.machine_ids):
        if not db.collection("machines").document(mid).get().exists:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Machine {mid} not found")
    order_id = f"ord_{uuid.uuid4().hex[:12]}"
    data = {
        "id": order_id,
        "name": req.name,
        "quantity": req.quantity,
        "due_at": due.isoformat(),
        "machine_ids": list(dict.fromkeys(req.machine_ids)),
        "product_id": req.product_id,
        "status": "open",
        "created_at": now.isoformat(),
        "created_by": user.uid,
    }
    db.collection("orders").document(order_id).set(data)
    return data


@router.get("/orders")
def list_orders(user: AuthUser = Depends(require_role("supervisor"))) -> list[dict[str, Any]]:
    """Open orders with their live projection, soonest due first."""
    db = get_firestore_client()
    now = datetime.now(timezone.utc)
    orders = [d.to_dict() or {} for d in db.collection("orders").where("status", "==", "open").stream()]
    orders.sort(key=lambda o: str(o.get("due_at") or ""))
    return [order_status(db, o, now) for o in orders]


@router.post("/orders/{order_id}/close")
def close_order(order_id: str, user: AuthUser = Depends(require_role("supervisor"))) -> dict[str, Any]:
    db = get_firestore_client()
    ref = db.collection("orders").document(order_id)
    if not ref.get().exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found")
    ref.update({"status": "closed", "closed_at": datetime.now(timezone.utc).isoformat()})
    return {"id": order_id, "status": "closed"}
