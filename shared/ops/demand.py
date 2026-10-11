"""Order projection for the demand agent (shared by takumi-api and takumi-forge).

Pure arithmetic, so the agent never does the maths itself: parts made since the order was placed,
the recent production rate, the time left and the inspection yield give a projected total and the
shortfall at the due time.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any


def _ts(v: Any) -> datetime | None:
    if isinstance(v, datetime):
        return v
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


def machine_output(count_events: list[dict[str, Any]], since: datetime, now: datetime, rate_window_s: float = 1800.0) -> dict[str, Any]:
    """Parts made since `since` and the parts/hour over the last `rate_window_s` (accepted counter reads only)."""
    pts = sorted(
        (t, int(e["count"]))
        for e in count_events
        if e.get("event_type") == "count" and not e.get("flag") and e.get("count") is not None
        and (t := _ts(e.get("ts"))) is not None and since <= t <= now
    )
    if len(pts) < 2:
        return {"made": 0, "rate_per_hour": None, "reads": len(pts)}
    made = max(0, pts[-1][1] - pts[0][1])
    window = [(t, c) for t, c in pts if (now - t).total_seconds() <= rate_window_s]
    rate = None
    if len(window) >= 2 and window[-1][0] > window[0][0]:
        hours = (window[-1][0] - window[0][0]).total_seconds() / 3600
        rate = max(0.0, (window[-1][1] - window[0][1]) / hours)
    return {"made": made, "rate_per_hour": rate, "reads": len(pts)}


def project_order(
    quantity: int,
    made: int,
    rate_per_hour: float | None,
    now: datetime,
    due: datetime,
    first_pass_rate: float | None = None,
) -> dict[str, Any]:
    """Projects good parts at the due time and the shortfall; rate None means not enough data."""
    hours_left = max(0.0, (due - now).total_seconds() / 3600)
    yield_ = first_pass_rate if first_pass_rate is not None else 1.0
    good_made = made * yield_
    if rate_per_hour is None:
        return {
            "hours_left": round(hours_left, 2), "good_made": round(good_made), "projected_good": None,
            "shortfall": None, "on_track": None, "rate_needed_per_hour": _needed(quantity, good_made, hours_left, yield_),
        }
    projected = good_made + rate_per_hour * hours_left * yield_
    shortfall = max(0, round(quantity - projected))
    return {
        "hours_left": round(hours_left, 2),
        "good_made": round(good_made),
        "projected_good": round(projected),
        "shortfall": shortfall,
        "on_track": shortfall == 0,
        "rate_needed_per_hour": _needed(quantity, good_made, hours_left, yield_),
    }


def _needed(quantity: int, good_made: float, hours_left: float, yield_: float) -> float | None:
    if hours_left <= 0 or yield_ <= 0:
        return None
    return round(max(0.0, (quantity - good_made) / (hours_left * yield_)), 1)


def order_status(db: Any, order: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Live status of one order from Firestore: per-machine output, yield and the projection.

    Works with any Firestore-like client (takumi-api and takumi-forge both call it).
    """
    created = _ts(order.get("created_at")) or now
    due = _ts(order.get("due_at")) or now
    machine_ids = list(order.get("machine_ids") or [])

    events_by_machine: dict[str, list[dict[str, Any]]] = {m: [] for m in machine_ids}
    for snap in db.collection("machine_events").where("ts", ">=", created.isoformat()).stream():
        e = snap.to_dict() or {}
        if e.get("machine_id") in events_by_machine:
            events_by_machine[e["machine_id"]].append(e)

    machines, made, rates, sources = [], 0, [], set()
    for mid in machine_ids:
        m_snap = db.collection("machines").document(mid).get()
        m = (m_snap.to_dict() or {}) if m_snap.exists else {}
        out = machine_output(events_by_machine[mid], since=created, now=now)
        made += out["made"]
        if out["rate_per_hour"] is not None:
            rates.append(out["rate_per_hour"])
        sources.add("HOME RIG" if str(m.get("source", "")).upper() == "VIRTUAL" else "LIVE")
        ideal = float(m.get("ideal_cycle_s") or 0) or None
        machines.append({
            "machine_id": mid,
            "name": m.get("name", mid),
            "state": m.get("state"),
            "last_alarm": m.get("last_alarm"),
            "made": out["made"],
            "rate_per_hour": None if out["rate_per_hour"] is None else round(out["rate_per_hour"], 1),
            "ideal_rate_per_hour": round(3600 / ideal, 1) if ideal else None,
        })

    first_pass = None
    if order.get("product_id"):
        insp = [
            s.to_dict() or {}
            for s in db.collection("inspections").where("product_id", "==", order["product_id"]).stream()
        ]
        insp = [
            i for i in insp
            if (t := _ts(i.get("created_at"))) is not None and t >= created
            and i.get("ai_verdict") in ("ok", "defective")
            and not str(i.get("source") or "").upper().startswith("PUBLIC DATA")  # gallery tries never count
        ]
        if insp:
            first_pass = sum(1 for i in insp if i["ai_verdict"] == "ok") / len(insp)

    rate = sum(rates) if rates else None
    projection = project_order(int(order.get("quantity") or 0), made, rate, now, due, first_pass)
    return {
        "order_id": order.get("id"),
        "name": order.get("name"),
        "quantity": order.get("quantity"),
        "due_at": order.get("due_at"),
        "made": made,
        "rate_per_hour": None if rate is None else round(rate, 1),
        "first_pass_rate": None if first_pass is None else round(first_pass, 3),
        "machines": machines,
        "source": " + ".join(sorted(sources)) if sources else "LIVE",
        **projection,
    }
