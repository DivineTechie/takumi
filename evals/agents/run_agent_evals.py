"""Agent evaluation on scripted scenarios (TEST FIXTURES, not factory data).

Runs the real Google ADK agents (real Gemini calls) against in-memory records whose right answer is known:
- Maintenance agent: each of the 6 bench alarm codes, once as a first stop and once as a repeat stop
  (same alarm twice in the last days plus an earlier work order). Checked: the most likely cause is one of
  the alarm guide's causes (judged by gemini-3.5-flash-lite), the repair time is the guide's upper bound,
  the repeat flag is right, and safety steps are present.
- Trace-back agent: 4 charger-kit units with a known root-cause step and known units at risk. Checked:
  the step, the exact hold list, and no hold the records do not support.

Usage (repo root): python -m evals.agents.run_agent_evals
Writes apps/web/src/evals/agentResults.json. Needs GEMINI_API_KEY or ADC that can read it from Secret Manager.
"""

from __future__ import annotations

import asyncio
import json
import os
import statistics
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "apps" / "web" / "src" / "evals" / "agentResults.json"


def ensure_key() -> None:
    if os.environ.get("GEMINI_API_KEY", "").strip():
        return
    from google.cloud import secretmanager

    name = f"projects/{os.environ.get('GOOGLE_CLOUD_PROJECT', 'takumi-cup-2026')}/secrets/GEMINI_API_KEY/versions/latest"
    os.environ["GEMINI_API_KEY"] = secretmanager.SecretManagerServiceClient().access_secret_version(request={"name": name}).payload.data.decode().strip()


ensure_key()
os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "0")

from google import genai  # noqa: E402
from google.genai import types  # noqa: E402

from services.forge.agents.maintenance import run_maintenance  # noqa: E402
from services.forge.agents.traceback import run_traceback  # noqa: E402
from services.forge.tests.test_demand import FakeDB  # noqa: E402
from shared.ops.alarm_guide import ALARM_GUIDE  # noqa: E402

NOW = datetime.now(timezone.utc)
JUDGE_MODEL = "gemini-3.5-flash-lite"
NAMES = {"E-104": "SPINDLE OVERLOAD", "E-221": "COOLANT LOW", "E-310": "DOOR OPEN", "E-415": "AIR PRESSURE LOW", "E-502": "FEED JAM", "E-618": "HYDRAULIC TEMP HIGH"}


def ago(**kw) -> str:
    return (NOW - timedelta(**kw)).isoformat()


def maintenance_store(code: str, repeat: bool) -> dict:
    alarm = f"{code} {NAMES[code]}"
    store = {
        "machines/m1": {"id": "m1", "name": "Press 2", "source": "VIRTUAL", "state": "stopped", "last_alarm": alarm, "last_count": 412},
        "machine_events/s1": {"machine_id": "m1", "event_type": "state_change", "to_state": "stopped", "ts": ago(minutes=4)},
        "machine_events/a1": {"machine_id": "m1", "event_type": "alarm", "alarm_text": alarm, "ts": ago(minutes=4)},
        "machine_events/r0": {"machine_id": "m1", "event_type": "state_change", "to_state": "running", "ts": ago(hours=3)},
    }
    if repeat:
        for i, days in enumerate((1, 3)):
            store[f"machine_events/rs{i}"] = {"machine_id": "m1", "event_type": "state_change", "to_state": "stopped", "ts": ago(days=days)}
            store[f"machine_events/ra{i}"] = {"machine_id": "m1", "event_type": "alarm", "alarm_text": alarm, "ts": ago(days=days)}
            store[f"machine_events/rr{i}"] = {"machine_id": "m1", "event_type": "state_change", "to_state": "running", "ts": ago(days=days, minutes=-25)}
        store["work_orders/w0"] = {"machine_id": "m1", "alarm_text": alarm, "status": "approved", "created_at": ago(days=3),
                                   "draft": {"title": f"Press 2: {NAMES[code].lower()}"}, "decision_note": "fixed, back running"}
    return store


def judge_cause(client: genai.Client, cause: str, guide_causes: list[str]) -> bool:
    prompt = (
        "Is the proposed cause the same as, or a more specific version of, one of the listed causes? Answer only yes or no.\n"
        f"Proposed cause: {cause}\nListed causes:\n- " + "\n- ".join(guide_causes)
    )
    r = client.models.generate_content(model=JUDGE_MODEL, contents=prompt, config=types.GenerateContentConfig(max_output_tokens=5))
    return (r.text or "").strip().lower().startswith("yes")


async def eval_maintenance(client: genai.Client) -> dict:
    cases = []
    for code, entry in ALARM_GUIDE.items():
        upper = int(str(entry["typical_minutes"]).split("-")[-1])
        for repeat in (False, True):
            db = FakeDB(maintenance_store(code, repeat))
            t0 = time.time()
            try:
                res = await run_maintenance(db, "m1", "eval")
                d = res["draft"]
                secs = round(time.time() - t0, 1)
                top = d["likely_causes"][0]["cause"] if d["likely_causes"] else ""
                case = {
                    "alarm": code, "repeat": repeat, "seconds": secs,
                    "cause_in_guide": bool(top) and judge_cause(client, top, list(entry["likely_causes"])),
                    "minutes_from_guide": d.get("estimated_minutes") == upper,
                    "repeat_flag_right": bool(d.get("repeat_issue")) == repeat,
                    "safety_present": len(d.get("safety") or []) > 0,
                    "top_cause": top, "priority": d.get("priority"),
                }
            except Exception as e:  # a failed run counts as a fail on every check
                case = {"alarm": code, "repeat": repeat, "seconds": round(time.time() - t0, 1), "error": type(e).__name__,
                        "cause_in_guide": False, "minutes_from_guide": False, "repeat_flag_right": False, "safety_present": False}
            print(json.dumps(case))
            cases.append(case)
    checks = ["cause_in_guide", "minutes_from_guide", "repeat_flag_right", "safety_present"]
    return {
        "cases": cases,
        "n": len(cases),
        "pass": {c: sum(1 for x in cases if x[c]) for c in checks},
        "all_checks": sum(1 for x in cases if all(x[c] for c in checks)),
        "median_s": statistics.median(x["seconds"] for x in cases),
    }


CHARGER_SKILL = json.loads((Path(__file__).resolve().parents[2] / "shared" / "seed" / "skill_charger_kit_v1.json").read_text(encoding="utf-8"))


def record(issues=(), incomplete=()) -> dict:
    return {"session_id": "s", "station": "Pack a phone charger kit", "skill_id": CHARGER_SKILL["id"], "ended_at": ago(hours=2),
            "steps_total": 3, "steps_done": 3 - len(incomplete), "incomplete_steps": list(incomplete),
            "issues": [{"step": s, "type": "mistake", "reason": r, "step_title": CHARGER_SKILL["steps"][s - 1]["instruction"]} for s, r in issues]}


def unit(uid: str, status: str, rec: dict, inspection: str | None = None) -> dict:
    return {"id": uid, "product_id": "charger_kit", "status": status, "station_records": [rec], "inspections": [inspection] if inspection else []}


TRACE_CASES = [
    {   # mistake recorded at step 3 explains a label defect; one other unit had the same mistake
        "name": "label on cable, mistake recorded at step 3", "failed": "T1-0004", "defect": "label stuck on the cable", "expect_step": 3,
        "expect_holds": {"T1-0002"},
        "units": [unit("T1-0004", "failed", record([(3, "label on the cable")]), "i1"), unit("T1-0002", "passed", record([(3, "label on the cable")])),
                  unit("T1-0001", "passed", record()), unit("T1-0003", "passed", record([(2, "cable not banded")]))],
    },
    {   # step 2 never verified explains a loose cable; another unit also skipped step 2
        "name": "loose cable, step 2 not verified", "failed": "T2-0010", "defect": "cable loose, no rubber band", "expect_step": 2,
        "expect_holds": {"T2-0011"},
        "units": [unit("T2-0010", "failed", record(incomplete=[2]), "i1"), unit("T2-0011", "passed", record(incomplete=[2])),
                  unit("T2-0012", "passed", record())],
    },
    {   # nothing in the records explains the defect: the agent must not guess or hold anything
        "name": "no recorded cause", "failed": "T3-0020", "defect": "plug not fully inserted", "expect_step": None,
        "expect_holds": set(),
        "units": [unit("T3-0020", "failed", record(), "i1"), unit("T3-0021", "passed", record()), unit("T3-0022", "passed", record([(3, "label crooked")]))],
    },
    {   # two recorded mistakes; only step 3 matches a missing label
        "name": "two mistakes, only one explains the defect", "failed": "T4-0030", "defect": "label missing", "expect_step": 3,
        "expect_holds": {"T4-0032"},
        "units": [unit("T4-0030", "failed", record([(1, "plug half inserted"), (3, "label not applied")]), "i1"),
                  unit("T4-0031", "passed", record([(1, "plug half inserted")])), unit("T4-0032", "passed", record([(3, "label not applied")]))],
    },
]


async def eval_traceback() -> dict:
    cases = []
    for c in TRACE_CASES:
        store = {f"units/{u['id']}": u for u in c["units"]}
        store["inspections/i1"] = {"ai_verdict": "defective", "confirm": {"defect": c["defect"], "where": "unit"}, "human_decision": "confirmed_defect", "created_at": ago(hours=1)}
        store[f"skills/{CHARGER_SKILL['id']}"] = CHARGER_SKILL
        t0 = time.time()
        try:
            r = (await run_traceback(FakeDB(store), c["failed"], "eval"))["report"]
            holds = set(r["hold_unit_ids"])
            step = r["root_cause_step"]
            case = {"name": c["name"], "seconds": round(time.time() - t0, 1), "step": step, "holds": sorted(holds), "confidence": r["confidence"],
                    "step_right": step == c["expect_step"] or (c["expect_step"] is None and (step is None or r["confidence"] == "low")),
                    "holds_exact": holds == c["expect_holds"],
                    "no_unsupported_hold": holds <= c["expect_holds"]}
        except Exception as e:
            case = {"name": c["name"], "seconds": round(time.time() - t0, 1), "error": type(e).__name__, "step_right": False, "holds_exact": False, "no_unsupported_hold": False}
        print(json.dumps(case))
        cases.append(case)
    checks = ["step_right", "holds_exact", "no_unsupported_hold"]
    return {"cases": cases, "n": len(cases), "pass": {k: sum(1 for x in cases if x[k]) for k in checks},
            "median_s": statistics.median(x["seconds"] for x in cases)}


async def main() -> None:
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"], http_options={"api_version": "v1beta"})
    previous = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    only = os.environ.get("ONLY", "")
    maintenance = previous["maintenance"] if only == "traceback" and "maintenance" in previous else await eval_maintenance(client)
    traceback = previous["traceback"] if only == "maintenance" and "traceback" in previous else await eval_traceback()
    out = {
        "label": "TEST FIXTURES",
        "generated": NOW.date().isoformat(),
        "note": "Scripted scenarios with a known right answer, run through the deployed agent code and real Gemini calls. Not factory data.",
        "maintenance": {k: v for k, v in maintenance.items() if k != "cases"} | {"cases": maintenance["cases"]},
        "traceback": traceback,
        "judge_model": JUDGE_MODEL,
    }
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print("maintenance", maintenance["pass"], "all", maintenance["all_checks"], "/", maintenance["n"], "median", maintenance["median_s"], "s")
    print("traceback", traceback["pass"], "/", traceback["n"], "median", traceback["median_s"], "s")


if __name__ == "__main__":
    asyncio.run(main())
