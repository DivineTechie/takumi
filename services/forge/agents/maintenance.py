"""Maintenance agent (Google ADK): a machine stopped, draft the work order.

An investigator agent reads the stopped machine's live status, its stops and alarms over the last
7 days, the alarm guide and past work orders for the same machine, and decides the likely causes in
order. A reporter agent writes a structured work-order draft. Nothing happens until a supervisor
approves the draft in the app; the agent never restarts or changes a machine.
"""

from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from google.adk.agents import LlmAgent, SequentialAgent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import BaseModel, Field

from services.forge.config import MODEL_FLASH, MODEL_FLASH_LITE
from shared.ops.alarm_guide import STATUS_WORDS, lookup

logger = logging.getLogger("forge.agents.maintenance")

APP_NAME = "takumi_maintenance"
HISTORY_DAYS = 7
# A supervisor is waiting on the floor: low thinking keeps the whole run to a few model turns.
FAST = types.GenerateContentConfig(thinking_config=types.ThinkingConfig(thinking_level="low"))
EVENT_TYPES = ("state_change", "alarm", "alarm_cleared")


class LikelyCause(BaseModel):
    cause: str
    evidence: str = Field(description="The fact from the tools that points to this cause.")


class WorkOrderDraft(BaseModel):
    """Structured work order returned to the supervisor (also the reporter's response schema)."""

    title: str = Field(description="Short title, e.g. 'Press 2: coolant low, refill and check for leaks'.")
    priority: Literal["low", "medium", "high", "urgent"] = "medium"
    summary: str = Field(description="Two plain sentences: what stopped, since when, and the most likely cause.")
    likely_causes: list[LikelyCause] = Field(default_factory=list, description="Most likely first.")
    steps: list[str] = Field(default_factory=list, description="Ordered steps for the technician.")
    safety: list[str] = Field(default_factory=list)
    parts: list[str] = Field(default_factory=list)
    estimated_minutes: int | None = Field(default=None, description="Only from the alarm guide's typical time.")
    repeat_issue: bool = Field(default=False, description="True if the same alarm happened before in the history.")
    operator_alert: str = Field(description="One or two short spoken sentences for the operator on the floor.")


def stopped_for_text(minutes: float | None) -> str | None:
    """'under a minute', '6 minutes', '1 h 20 min' (None when unknown)."""
    if minutes is None:
        return None
    if minutes < 1:
        return "under a minute"
    if minutes < 60:
        m = round(minutes)
        return f"{m} minute" if m == 1 else f"{m} minutes"
    h, m = divmod(round(minutes), 60)
    return f"{h} h {m} min" if m else f"{h} h"


class MaintenanceTools:
    """Read-only tools over Firestore for one stopped machine."""

    def __init__(self, db: Any, machine_id: str, now: datetime | None = None):
        self.db = db
        self.machine_id = machine_id
        self.now = now or datetime.now(timezone.utc)
        self.machine: dict[str, Any] = {}
        self._events: list[dict[str, Any]] | None = None

    def _history(self) -> list[dict[str, Any]]:
        if self._events is None:
            since = (self.now - timedelta(days=HISTORY_DAYS)).isoformat()
            col = self.db.collection("machine_events").where("machine_id", "==", self.machine_id)
            try:
                docs = list(col.where("ts", ">=", since).stream())
            except Exception as e:  # composite index still building: filter in code
                logger.warning("machine_events index query failed, filtering in code: %s", e)
                docs = list(col.stream())
            events = [d.to_dict() or {} for d in docs]
            self._events = sorted(
                (e for e in events if e.get("event_type") in EVENT_TYPES and str(e.get("ts") or "") >= since),
                key=lambda e: str(e.get("ts")),
            )
        return self._events

    def get_machine_status(self) -> dict:
        """Returns the machine's name, current state, current alarm text, last count and how long it has been stopped."""
        snap = self.db.collection("machines").document(self.machine_id).get()
        if not snap.exists:
            return {"error": f"machine {self.machine_id} not found"}
        m = snap.to_dict() or {}
        self.machine = m
        stopped_since = None
        for e in reversed(self._history()):
            if e.get("event_type") == "state_change":
                if e.get("to_state") == "stopped":
                    stopped_since = e.get("ts")
                break
        minutes = None
        if stopped_since and m.get("state") == "stopped":
            try:
                minutes = round((self.now - datetime.fromisoformat(str(stopped_since).replace("Z", "+00:00"))).total_seconds() / 60, 1)
            except ValueError:
                minutes = None
        return {
            "name": m.get("name"),
            "state": m.get("state"),
            "alarm_text": m.get("last_alarm"),
            "last_count": m.get("last_count"),
            # Plain words, not a timestamp: the draft is read by people on the floor.
            "minutes_stopped": minutes,
            "stopped_for": stopped_for_text(minutes),
            "last_seen_at": m.get("last_seen_at"),
        }

    def get_machine_history(self) -> dict:
        """Returns the machine's stops and alarms over the last 7 days: counts per alarm text and the latest events."""
        events = self._history()
        stops = [e for e in events if e.get("event_type") == "state_change" and e.get("to_state") == "stopped"]
        # Older reads stored status words such as IDLE as alarms; they are not faults.
        alarms = Counter(
            str(e.get("alarm_text")) for e in events
            if e.get("event_type") == "alarm" and e.get("alarm_text") and str(e.get("alarm_text")).upper().strip() not in STATUS_WORDS
        )
        return {
            "days": HISTORY_DAYS,
            "stops": len(stops),
            "alarm_counts": dict(alarms.most_common(10)),
            "latest_events": [{k: e.get(k) for k in ("ts", "event_type", "to_state", "alarm_text")} for e in events[-12:]],
        }

    def lookup_alarm_guide(self, alarm_text: str) -> dict:
        """Returns the alarm guide entry (likely causes, checks, safety, parts, typical minutes) for an alarm text.

        Args:
            alarm_text: The alarm text exactly as read from the machine screen, e.g. "E-221 COOLANT LOW".
        """
        entry = lookup(alarm_text)
        return entry or {"error": f"no guide entry for '{alarm_text}'; reason from the history only"}

    def get_past_work_orders(self) -> dict:
        """Returns earlier work orders for this machine with their status and the technician's closing note."""
        out = []
        for snap in self.db.collection("work_orders").where("machine_id", "==", self.machine_id).stream():
            w = snap.to_dict() or {}
            out.append({
                "created_at": w.get("created_at"),
                "alarm_text": w.get("alarm_text"),
                "title": (w.get("draft") or {}).get("title"),
                "status": w.get("status"),
                "note": w.get("decision_note"),
            })
        out.sort(key=lambda w: str(w.get("created_at") or ""), reverse=True)
        return {"work_orders": out[:10]}


INVESTIGATOR_INSTRUCTION = """You are the maintenance lead of a small factory. A machine is stopped; prepare a work order.
1. In your first turn call get_machine_status, get_machine_history and get_past_work_orders together (in parallel).
2. Then call lookup_alarm_guide with the exact alarm text from the status. If the machine is not stopped, say so.
3. Rank the likely causes. Use the history: the same alarm repeating in the last days, many stops, or a past
   work order that did not fix it make a deeper cause more likely. Cite the fact behind each cause.
4. Write notes: what stopped and for how many minutes, ranked causes with evidence, ordered steps for the technician,
   safety points, parts, typical time from the guide, whether it is a repeat issue, and a priority
   (urgent for a safety hazard, high if it stopped production and repeats, medium otherwise).
   Typical time: use the upper number of the guide's typical_minutes.
The alarm guide is a team-written guide, not a vendor manual. Never invent alarm history or readings."""

REPORTER_INSTRUCTION = """Turn the maintenance lead's notes into the work order. Use only facts from the notes:
{findings}
Never write raw timestamps, ISO dates or "0 minutes"; use the stopped_for wording from the notes, for example
"stopped under a minute ago" or "stopped 6 minutes ago".
Steps are short imperative sentences. operator_alert is what a speaker on the floor says, for example:
"Press 2 has stopped: coolant low. Please top up the coolant tank and check for leaks under the machine."
No names of people."""


def build_maintenance_agent(tools: MaintenanceTools) -> SequentialAgent:
    investigator = LlmAgent(
        name="maintenance_lead",
        model=MODEL_FLASH,
        description="Investigates a stopped machine with read-only tools.",
        instruction=INVESTIGATOR_INSTRUCTION,
        tools=[tools.get_machine_status, tools.get_machine_history, tools.lookup_alarm_guide, tools.get_past_work_orders],
        output_key="findings",
        generate_content_config=FAST,
    )
    reporter = LlmAgent(
        name="reporter",
        model=MODEL_FLASH_LITE,
        generate_content_config=FAST,
        description="Writes the structured work-order draft.",
        instruction=REPORTER_INSTRUCTION,
        output_schema=WorkOrderDraft,
        output_key="report",
    )
    return SequentialAgent(name="maintenance_planner", sub_agents=[investigator, reporter])


async def run_maintenance(db: Any, machine_id: str, user_id: str) -> dict:
    """Runs the agent once; returns the draft, the machine status the tools saw and the tool calls made."""
    tools = MaintenanceTools(db, machine_id)
    sessions = InMemorySessionService()
    runner = Runner(app_name=APP_NAME, agent=build_maintenance_agent(tools), session_service=sessions)
    session = await sessions.create_session(app_name=APP_NAME, user_id=user_id)

    steps: list[dict] = []
    message = types.Content(role="user", parts=[types.Part(text=f"Machine {machine_id} has stopped. Draft the work order.")])
    async for event in runner.run_async(user_id=user_id, session_id=session.id, new_message=message):
        for call in event.get_function_calls() or []:
            steps.append({"agent": event.author, "tool": call.name, "args": dict(call.args or {})})

    final = await sessions.get_session(app_name=APP_NAME, user_id=user_id, session_id=session.id)
    raw = (final.state if final else {}).get("report")
    if raw is None:
        raise RuntimeError("maintenance agent returned no report")
    draft = raw if isinstance(raw, WorkOrderDraft) else WorkOrderDraft.model_validate(raw)
    return {"draft": draft.model_dump(), "machine": tools.machine, "agent_steps": steps}
