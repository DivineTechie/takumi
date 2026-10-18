"""Quality trace-back agent (Google ADK).

Given a failed unit, an investigator agent uses tools over the unit records to find the station and
step where the defect most likely started, the other units that went through the same step with the
same kind of problem, and the work instruction for that step. A reporter agent then writes a
structured proposal. Nothing is changed: holds and work-instruction edits are applied only after a
supervisor approves them in the app. Operator identities are never given to the agent, so it reasons
about stations and steps, not people.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from google.adk.agents import LlmAgent, SequentialAgent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import BaseModel, Field

from services.forge.config import MODEL_FLASH

logger = logging.getLogger("forge.agents.traceback")

APP_NAME = "takumi_quality_traceback"
# A supervisor waits on screen: low thinking and parallel tool calls keep the run short.
FAST = types.GenerateContentConfig(thinking_config=types.ThinkingConfig(thinking_level="low"))
MAX_SIMILAR = 50


class TracebackReport(BaseModel):
    """Structured proposal returned to the supervisor (also the reporter's response schema)."""

    summary: str = Field(description="Two or three plain sentences for a supervisor.")
    root_cause_station: str | None = Field(default=None, description="Station name where the defect most likely started.")
    root_cause_skill_id: str | None = None
    root_cause_step: int | None = None
    evidence: list[str] = Field(default_factory=list, description="Short facts from the records that support the root cause.")
    confidence: Literal["low", "medium", "high"] = "low"
    hold_unit_ids: list[str] = Field(default_factory=list, description="Other units to put on hold for re-inspection.")
    already_on_hold_unit_ids: list[str] = Field(
        default_factory=list, description="Units at risk that find_similar_units shows are already on hold."
    )
    hold_reason: str = ""
    work_instruction_fix: str | None = Field(
        default=None, description="The new instruction text for the step, written as the instruction itself (no labels)."
    )
    success_criteria_fix: str | None = Field(
        default=None, description="New camera success criteria for the step (visible facts only), if they should change."
    )


class TracebackTools:
    """Read-only tools over Firestore. Records which unit ids the tools actually returned."""

    def __init__(self, db: Any):
        self.db = db
        self.seen_candidates: set[str] = set()
        self.held_candidates: set[str] = set()
        self.seen_steps: set[tuple[str, int]] = set()

    def get_unit_history(self, unit_id: str) -> dict:
        """Returns a unit's status, inspection results and station records (steps, mistakes, safety stops).

        Args:
            unit_id: The unit serial, for example "SN-0042".
        """
        snap = self.db.collection("units").document(unit_id).get()
        if not snap.exists:
            return {"error": f"unit {unit_id} not found"}
        unit = snap.to_dict() or {}
        inspections = []
        for insp_id in unit.get("inspections") or []:
            i = self.db.collection("inspections").document(insp_id).get()
            if i.exists:
                d = i.to_dict() or {}
                c, s = d.get("confirm") or {}, d.get("screen") or {}
                inspections.append({
                    "ai_verdict": d.get("ai_verdict"),
                    "defect": c.get("defect") or s.get("defect"),
                    "where": c.get("where") or s.get("where"),
                    "human_decision": d.get("human_decision"),
                    "at": d.get("created_at"),
                })
        stations = []
        for r in unit.get("station_records") or []:
            for issue in r.get("issues") or []:
                if r.get("skill_id") and issue.get("step"):
                    self.seen_steps.add((r["skill_id"], int(issue["step"])))
            for n in r.get("incomplete_steps") or []:
                if r.get("skill_id") and n:
                    self.seen_steps.add((r["skill_id"], int(n)))
            stations.append({
                "station": r.get("station"),
                "skill_id": r.get("skill_id"),
                "ended_at": r.get("ended_at"),
                "steps_total": r.get("steps_total"),
                "steps_done": r.get("steps_done"),
                "incomplete_steps": r.get("incomplete_steps") or [],
                "issues": [
                    {k: i.get(k) for k in ("step", "step_title", "type", "reason", "t")} for i in (r.get("issues") or [])
                ],
            })
        return {
            "unit_id": unit_id,
            "product_id": unit.get("product_id"),
            "status": unit.get("status"),
            "inspections": inspections,
            "stations": stations,
        }

    def find_similar_units(self, skill_id: str, step: int, exclude_unit_id: str) -> dict:
        """Finds other units whose record at this station shows a mistake, safety stop or unfinished check at this step.

        Units already failed are left out; units already on hold are listed with status "on_hold" so the
        supervisor sees every unit at risk. Use this to decide which units to hold for re-inspection.

        Args:
            skill_id: The station's skill id from the unit history.
            step: The step number suspected as the root cause.
            exclude_unit_id: The failed unit itself.
        """
        matches = []
        for snap in self.db.collection("units").stream():
            u = snap.to_dict() or {}
            uid = u.get("id")
            if not uid or uid == exclude_unit_id or u.get("status") == "failed":
                continue
            for r in u.get("station_records") or []:
                if r.get("skill_id") != skill_id:
                    continue
                issues = [i for i in (r.get("issues") or []) if i.get("step") == step]
                unfinished = step in (r.get("incomplete_steps") or [])
                if issues or unfinished:
                    matches.append({
                        "unit_id": uid,
                        "status": u.get("status"),
                        "station_ended_at": r.get("ended_at"),
                        "issue_types": sorted({i.get("type") for i in issues}) + (["step_not_verified"] if unfinished else []),
                        "reasons": [i.get("reason") for i in issues if i.get("reason")][:3],
                    })
                    break
            if len(matches) >= MAX_SIMILAR:
                break
        self.seen_candidates.update(m["unit_id"] for m in matches)
        self.held_candidates.update(m["unit_id"] for m in matches if m["status"] == "on_hold")
        return {"skill_id": skill_id, "step": step, "count": len(matches), "units": matches}

    def get_work_instruction(self, skill_id: str, step: int) -> dict:
        """Returns the current work instruction, success criteria and known common mistakes for one step.

        Args:
            skill_id: The station's skill id.
            step: The step number.
        """
        snap = self.db.collection("skills").document(skill_id).get()
        if not snap.exists:
            return {"error": f"skill {skill_id} not found"}
        skill = snap.to_dict() or {}
        for s in skill.get("steps") or []:
            if s.get("n") == step:
                return {
                    "skill_title": skill.get("title"),
                    "step": step,
                    "instruction": s.get("instruction"),
                    "success_criteria": s.get("success_criteria"),
                    "common_mistakes": s.get("common_mistakes") or [],
                }
        return {"error": f"step {step} not found in {skill_id}"}


INVESTIGATOR_INSTRUCTION = """You are a quality engineer in a small factory. A unit failed end-of-line inspection.
Find where the defect most likely started, using only the tools:
1. Call get_unit_history for the failed unit. Read the inspection defect and every station record.
2. Pick the station and step whose recorded mistake, safety stop or unverified step best explains the defect.
   If nothing in the records explains it, say so; do not guess.
3. Call get_work_instruction and find_similar_units for that station and step together, in parallel.
Write your findings as plain notes: the root cause (station, skill id, step) with the facts that support it,
how sure you are, the unit ids at risk exactly as returned by find_similar_units, and a concrete change to the
step's instruction or success criteria that would prevent this. Never mention or guess who the operator was."""

REPORTER_INSTRUCTION = """Turn the investigator's notes into the report. Use only facts in the notes:
{findings}
List in hold_unit_ids only unit ids that the notes say find_similar_units returned and that are not already on
hold; list the ones already on hold in already_on_hold_unit_ids. If the root cause is unknown, leave the root cause
fields empty, set confidence to low and leave both unit lists empty.
Put only the new instruction text in work_instruction_fix and any new success criteria in success_criteria_fix,
without labels such as "Instruction:"."""


def build_traceback_agent(tools: TracebackTools) -> SequentialAgent:
    investigator = LlmAgent(
        name="investigator",
        model=MODEL_FLASH,
        description="Investigates a failed unit with read-only tools over unit records.",
        instruction=INVESTIGATOR_INSTRUCTION,
        tools=[tools.get_unit_history, tools.find_similar_units, tools.get_work_instruction],
        output_key="findings",
        generate_content_config=FAST,
    )
    reporter = LlmAgent(
        name="reporter",
        model=MODEL_FLASH,
        description="Writes the structured trace-back proposal.",
        instruction=REPORTER_INSTRUCTION,
        output_schema=TracebackReport,
        output_key="report",
        generate_content_config=FAST,
    )
    return SequentialAgent(name="quality_traceback", sub_agents=[investigator, reporter])


def sanitise(report: TracebackReport, tools: TracebackTools, failed_unit_id: str) -> TracebackReport:
    """Keeps only claims the tools can back: hold candidates the tools returned, a step seen in the history.
    Candidates are split by their status as the tools saw it: units to hold now, and units already on hold."""
    at_risk = dict.fromkeys(report.hold_unit_ids + report.already_on_hold_unit_ids)
    backed = [u for u in at_risk if u in tools.seen_candidates and u != failed_unit_id]
    report.hold_unit_ids = [u for u in backed if u not in tools.held_candidates]
    report.already_on_hold_unit_ids = [u for u in backed if u in tools.held_candidates]
    if report.root_cause_skill_id and report.root_cause_step is not None:
        if (report.root_cause_skill_id, report.root_cause_step) not in tools.seen_steps:
            report.confidence = "low"
            report.evidence = ["The proposed step has no recorded issue on this unit."] + report.evidence
    return report


async def run_traceback(db: Any, unit_id: str, user_id: str) -> dict:
    """Runs the agent pipeline once and returns the sanitised report plus the tool calls it made."""
    tools = TracebackTools(db)
    agent = build_traceback_agent(tools)
    sessions = InMemorySessionService()
    runner = Runner(app_name=APP_NAME, agent=agent, session_service=sessions)
    session = await sessions.create_session(app_name=APP_NAME, user_id=user_id)

    steps: list[dict] = []
    message = types.Content(role="user", parts=[types.Part(text=f"Trace back failed unit {unit_id}.")])
    async for event in runner.run_async(user_id=user_id, session_id=session.id, new_message=message):
        for call in event.get_function_calls() or []:
            steps.append({"agent": event.author, "tool": call.name, "args": dict(call.args or {})})

    final = await sessions.get_session(app_name=APP_NAME, user_id=user_id, session_id=session.id)
    raw = (final.state if final else {}).get("report")
    if raw is None:
        raise RuntimeError("trace-back agent returned no report")
    report = raw if isinstance(raw, TracebackReport) else TracebackReport.model_validate(raw)
    report = sanitise(report, tools, unit_id)
    return {"unit_id": unit_id, "report": report.model_dump(), "agent_steps": steps}
