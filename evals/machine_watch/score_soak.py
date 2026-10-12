"""Score a Machine Watch soak run (HOME RIG) against its ground truth.

Usage (from the repo root, with gcloud application-default credentials):
    python -m evals.machine_watch.score_soak <soak_run_id> [--out PATH] [--window 120]

Ground truth comes from soak_runs/{id}/truth (written by the test bench page, server clock). Detections
are machine_events with the same soak_run_id. Both carry run_s (seconds since the run started), so a
live run and a recorded video replayed later are scored the same way.

Matching: each truth event (state change to X, alarm, alarm cleared) is matched to the earliest unused
detection of the same kind on the same bench machine within [truth - 2 s, truth + window]. The first
truth event per machine is the starting state, not a change. Only events between a machine's first
reading plus a 30 s warm-up (when the watcher learns its starting state) and the end of the run are
scored, for both truth and detections.
"""

from __future__ import annotations

import argparse
import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

WARMUP_S = 30.0
EARLY_TOLERANCE_S = 2.0
KINDS = ("stopped", "idle", "running", "alarm", "alarm_cleared")

# gemini-3.5-flash-lite on the Gemini API, USD per 1M tokens. Output price is an assumption (reads
# produce ~30 output tokens, so it barely moves the total).
PRICE_IN = 0.30
PRICE_OUT = 1.50


@dataclass
class Event:
    machine: str
    kind: str
    run_s: float


def truth_events(rows: list[dict[str, Any]]) -> list[Event]:
    """Converts truth rows to scoreable events, dropping each machine's starting state."""
    out: list[Event] = []
    seen_start: set[str] = set()
    for r in sorted(rows, key=lambda r: r.get("run_s") or 0.0):
        machine = r.get("machine_id")
        run_s = r.get("run_s")
        if machine is None or run_s is None:
            continue
        etype = r.get("event_type")
        if etype == "state_change":
            if machine not in seen_start:
                seen_start.add(machine)
                continue
            if r.get("state") in KINDS:
                out.append(Event(machine, r["state"], float(run_s)))
        elif etype in ("alarm", "alarm_cleared"):
            out.append(Event(machine, etype, float(run_s)))
    return out


def retime(rows: list[dict[str, Any]], slot_by_machine: dict[str, int], started: datetime, duration_s: float) -> list[dict[str, Any]]:
    """Untagged bench-machine readings within the run, with run_s from the shared server clock."""
    out = []
    for r in rows:
        if r.get("soak_run_id") or r.get("machine_id") not in slot_by_machine:
            continue
        try:
            t = datetime.fromisoformat(str(r["ts"]).replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        run_s = (t - started).total_seconds()
        if 0 <= run_s <= duration_s + 5:
            out.append({**r, "run_s": run_s})
    return out


def detection_events(rows: list[dict[str, Any]], slot_by_machine: dict[str, int]) -> list[Event]:
    """Converts machine_events to scoreable events keyed by bench machine (bench_<slot>)."""
    out: list[Event] = []
    for r in rows:
        slot = slot_by_machine.get(r.get("machine_id", ""))
        run_s = r.get("run_s")
        if slot is None or run_s is None or float(run_s) < WARMUP_S:
            continue
        machine = f"bench_{slot}"
        etype = r.get("event_type")
        if etype == "state_change" and r.get("to_state") in KINDS:
            out.append(Event(machine, r["to_state"], float(run_s)))
        elif etype in ("alarm", "alarm_cleared"):
            out.append(Event(machine, etype, float(run_s)))
    return sorted(out, key=lambda e: e.run_s)


def watch_start(rows: list[dict[str, Any]], slot_by_machine: dict[str, int]) -> dict[str, float]:
    """run_s of each bench machine's first stored reading: before it, the watcher was not running yet."""
    starts: dict[str, float] = {}
    for r in rows:
        slot = slot_by_machine.get(r.get("machine_id", ""))
        if slot is None or r.get("run_s") is None:
            continue
        key = f"bench_{slot}"
        starts[key] = min(starts.get(key, float("inf")), float(r["run_s"]))
    return starts


def while_watched(truth: list[Event], starts: dict[str, float]) -> list[Event]:
    """Drops truth events on a machine before it was watched (they could not be detected)."""
    return [t for t in truth if t.machine in starts and t.run_s >= starts[t.machine] + WARMUP_S]


def in_window(events: list[Event], starts: dict[str, float], end_s: float | None) -> list[Event]:
    """Keeps events after each machine's warm-up (its first reading is its starting state, not a change)
    and before the run ended (the bench stops logging truth then)."""
    return [
        e for e in events
        if e.machine in starts and e.run_s >= starts[e.machine] + WARMUP_S and (end_s is None or e.run_s <= end_s)
    ]


def score(truth: list[Event], detections: list[Event], window_s: float = 120.0) -> dict[str, Any]:
    """Greedy chronological matching; returns per-kind and overall detection rate, delays and false alarms."""
    used = [False] * len(detections)
    per_kind: dict[str, dict[str, Any]] = defaultdict(lambda: {"truth": 0, "detected": 0, "delays": [], "false_alarms": 0})

    for t in sorted(truth, key=lambda e: e.run_s):
        if t.run_s < WARMUP_S:
            continue
        k = per_kind[t.kind]
        k["truth"] += 1
        for i, d in enumerate(detections):
            if used[i] or d.machine != t.machine or d.kind != t.kind:
                continue
            if t.run_s - EARLY_TOLERANCE_S <= d.run_s <= t.run_s + window_s:
                used[i] = True
                k["detected"] += 1
                k["delays"].append(max(0.0, d.run_s - t.run_s))
                break

    for i, d in enumerate(detections):
        if not used[i]:
            per_kind[d.kind]["false_alarms"] += 1

    def summarise(k: dict[str, Any]) -> dict[str, Any]:
        delays = sorted(k["delays"])
        return {
            "truth": k["truth"],
            "detected": k["detected"],
            "rate": k["detected"] / k["truth"] if k["truth"] else None,
            "median_delay_s": statistics.median(delays) if delays else None,
            "p90_delay_s": delays[min(len(delays) - 1, int(0.9 * len(delays)))] if delays else None,
            "false_alarms": k["false_alarms"],
        }

    kinds = {kind: summarise(per_kind[kind]) for kind in KINDS if kind in per_kind}
    total = {"truth": 0, "detected": 0, "delays": [], "false_alarms": 0}
    for k in per_kind.values():
        total["truth"] += k["truth"]
        total["detected"] += k["detected"]
        total["delays"] += k["delays"]
        total["false_alarms"] += k["false_alarms"]
    return {"kinds": kinds, "overall": summarise(total)}


def cost(reads: dict[str, int], tokens_in: int, tokens_out: int, hours: float, machines: int) -> dict[str, Any]:
    """Gemini reads per machine-hour and the resulting monthly cost per machine (24 h x 30 days)."""
    n_reads = sum(reads.values())
    if n_reads == 0 or hours <= 0 or machines == 0:
        return {"reads": n_reads, "reads_per_machine_hour": None, "usd_per_read": None, "usd_per_machine_month": None}
    usd = (tokens_in * PRICE_IN + tokens_out * PRICE_OUT) / 1e6
    per_read = usd / n_reads
    rate = n_reads / machines / hours
    return {
        "reads": n_reads,
        "reads_per_machine_hour": rate,
        "usd_per_read": per_read,
        "usd_per_machine_month": rate * 24 * 30 * per_read,
    }


def _fmt(v: Any, pct: bool = False, digits: int = 1) -> str:
    if v is None:
        return "—"
    return f"{100 * v:.{digits}f}%" if pct else f"{v:.{digits}f}"


def render(run: dict[str, Any], result: dict[str, Any], c: dict[str, Any], hours: float, window_s: float) -> str:
    lines = [
        f"# Machine Watch soak run {run.get('id')} (HOME RIG)",
        "",
        "HOME RIG: simulated machines on a computer screen (TAKUMI test bench), filmed by a real camera.",
        f"Started {run.get('started_at')}, scored {hours:.2f} h, seed {run.get('schedule_seed')}, "
        f"machines: {', '.join(run.get('machines') or [])}. Match window {window_s:.0f} s; first {WARMUP_S:.0f} s ignored.",
        "",
        "| Event | Truth | Detected | Rate | Median delay | p90 delay | False alarms |",
        "|---|---|---|---|---|---|---|",
    ]
    rows = list(result["kinds"].items()) + [("overall", result["overall"])]
    for kind, k in rows:
        lines.append(
            f"| {kind} | {k['truth']} | {k['detected']} | {_fmt(k['rate'], pct=True)} | "
            f"{_fmt(k['median_delay_s'])} s | {_fmt(k['p90_delay_s'])} s | {k['false_alarms']} |"
        )
    lines += [
        "",
        f"Gemini reads: {c['reads']} ({_fmt(c['reads_per_machine_hour'])} per machine-hour); "
        f"cost per read ${c['usd_per_read'] or 0:.6f}; "
        f"estimated ${_fmt(c['usd_per_machine_month'], digits=2)} per machine per month running 24/7 "
        f"(gemini-3.5-flash-lite, ${PRICE_IN}/1M input; output price assumed ${PRICE_OUT}/1M).",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("run_id")
    ap.add_argument("--out")
    ap.add_argument("--window", type=float, default=120.0)
    ap.add_argument("--project", default="takumi-cup-2026")
    ap.add_argument("--by-time", action="store_true",
                    help="also use bench-machine readings not tagged with the run, matched by server time "
                         "(for a phone that started watching before the run was started)")
    args = ap.parse_args()

    from google.cloud import firestore  # imported here so the scoring functions test without credentials

    db = firestore.Client(project=args.project)
    run_ref = db.collection("soak_runs").document(args.run_id)
    run = run_ref.get().to_dict()
    if not run:
        raise SystemExit(f"Soak run {args.run_id} not found")
    truth_rows = [d.to_dict() for d in run_ref.collection("truth").stream()]
    det_rows = [d.to_dict() for d in db.collection("machine_events").where("soak_run_id", "==", args.run_id).stream()]
    slot_by_machine = {
        m.get("id"): m.get("bench_slot") for m in (d.to_dict() for d in db.collection("machines").stream()) if m.get("bench_slot")
    }
    if args.by_time:
        started = datetime.fromisoformat(str(run["started_at"]).replace("Z", "+00:00"))
        untagged = [d.to_dict() for d in db.collection("machine_events").where("ts", ">=", run["started_at"]).stream()]
        det_rows += retime(untagged, slot_by_machine, started, float(run.get("duration_min") or 0) * 60)

    starts = watch_start(det_rows, slot_by_machine)
    end_s = float(run["duration_min"]) * 60 if run.get("duration_min") else None
    truth = in_window(truth_events(truth_rows), starts, end_s)
    detections = in_window(detection_events(det_rows, slot_by_machine), starts, end_s)
    result = score(truth, detections, args.window)

    last_s = max([e.run_s for e in truth] + [e.run_s for e in detections] + [0.0])
    started = datetime.fromisoformat(str(run["started_at"]).replace("Z", "+00:00"))
    if run.get("ended_at"):
        last_s = max(last_s, (datetime.fromisoformat(str(run["ended_at"]).replace("Z", "+00:00")) - started).total_seconds())
    hours = last_s / 3600
    c = cost(run.get("reads") or {}, int(run.get("tokens_in") or 0), int(run.get("tokens_out") or 0), hours, len(run.get("machines") or []))

    text = render(run, result, c, hours, args.window)
    out = Path(args.out) if args.out else Path(__file__).parent / f"RESULTS_{args.run_id}.md"
    out.write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
