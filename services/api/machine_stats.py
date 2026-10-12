"""Daily Machine Watch statistics computed from machine_events.

Pure functions only, so the dashboard numbers can be unit-tested without Firestore.
"""

from collections import Counter
from datetime import datetime
from typing import Any

STATES = ("running", "idle", "stopped")


def _parse_ts(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def compute_machine_day(
    events: list[dict[str, Any]],
    ideal_cycle_s: float,
    window_start: datetime,
    window_end: datetime,
) -> dict[str, Any]:
    """Summarises one machine's events inside [window_start, window_end).

    Time before the first state_change in the window is "unknown" and is not counted in availability.
    Availability = running / (running + idle + stopped). Performance = counted parts x ideal cycle / running time.
    """
    rows = []
    for ev in events:
        ts = _parse_ts(ev.get("ts"))
        if ts is not None and window_start <= ts < window_end:
            rows.append((ts, ev))
    rows.sort(key=lambda r: r[0])

    segments: list[dict[str, Any]] = []
    seconds = {s: 0.0 for s in STATES}
    stops = 0
    current_state: str | None = None
    current_start: datetime | None = None
    alarms: Counter[str] = Counter()
    counts: list[int] = []
    sources: Counter[str] = Counter()

    def close_segment(end: datetime) -> None:
        if current_state is None or current_start is None or end <= current_start:
            return
        segments.append({"state": current_state, "start": current_start.isoformat(), "end": end.isoformat()})
        if current_state in seconds:
            seconds[current_state] += (end - current_start).total_seconds()

    for ts, ev in rows:
        if ev.get("source"):
            sources[str(ev["source"])] += 1
        etype = ev.get("event_type")
        if etype == "state_change":
            to_state = ev.get("to_state") or ev.get("state")
            if not to_state or to_state == current_state:
                continue
            close_segment(ts)
            if to_state == "stopped":
                stops += 1
            current_state, current_start = to_state, ts
        elif etype == "alarm" and ev.get("alarm_text"):
            alarms[str(ev["alarm_text"])] += 1
        elif etype == "count" and not ev.get("flag") and ev.get("count") is not None:
            counts.append(int(ev["count"]))

    close_segment(window_end)

    observed = sum(seconds.values())
    availability = seconds["running"] / observed if observed > 0 else None
    parts = (max(counts) - min(counts)) if len(counts) >= 2 else 0
    performance = None
    if seconds["running"] > 0 and parts > 0:
        performance = min(1.0, parts * ideal_cycle_s / seconds["running"])

    return {
        "segments": segments,
        "running_s": round(seconds["running"], 1),
        "idle_s": round(seconds["idle"], 1),
        "stopped_s": round(seconds["stopped"], 1),
        "availability": round(availability, 4) if availability is not None else None,
        "performance": round(performance, 4) if performance is not None else None,
        "stops": stops,
        "parts": parts,
        "top_alarms": [{"alarm_text": text, "count": n} for text, n in alarms.most_common(3)],
        "source": sources.most_common(1)[0][0] if sources else None,
        "events": len(rows),
    }
