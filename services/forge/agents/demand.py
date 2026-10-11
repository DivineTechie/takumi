"""Demand agent (Google ADK): "Will we make today's orders?"

An investigator agent reads today's open orders with their projections (computed in code by
shared.ops.demand from real Machine Watch counts and inspections) and the history of the machines
behind any order at risk. A reporter agent writes a structured answer: which orders are at risk, the
main constraint, and actions for a supervisor to approve. The agent never does the arithmetic; the
numbers returned to the app come from the tools, not from the model.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from google.adk.agents import LlmAgent, SequentialAgent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import BaseModel, Field

from services.forge.config import MODEL_FLASH
from shared.ops.demand import order_status

logger = logging.getLogger("forge.agents.demand")

APP_NAME = "takumi_demand"


class OrderVerdict(BaseModel):
    order_id: str
    verdict: str = Field(description="One short sentence: on track, at risk, or unknown, and why.")
    main_constraint: str | None = Field(default=None, description="The machine or factor that limits output, if any.")


class SuggestedAction(BaseModel):
    action: str = Field(description="A concrete step a supervisor can approve, e.g. move an order to another machine.")
    reason: str
    expected_extra_units: int | None = Field(default=None, description="Only if it follows from the tool numbers.")


class DemandReport(BaseModel):
    summary: str = Field(description="Two or three plain sentences answering: will we make today's orders?")
    orders: list[OrderVerdict] = Field(default_factory=list)
    actions: list[SuggestedAction] = Field(default_factory=list)
    confidence: str = Field(default="low", description="low, medium or high")


class DemandTools:
    """Read-only tools over Firestore; remembers which orders the tools returned."""

    def __init__(self, db: Any, now: datetime | None = None):
        self.db = db
        self.now = now or datetime.now(timezone.utc)
        self.orders: dict[str, dict[str, Any]] = {}

    def list_open_orders(self) -> dict:
        """Returns today's open orders with parts made, current rate, yield, projected good parts at the due time and shortfall."""
        out = []
        for snap in self.db.collection("orders").where("status", "==", "open").stream():
            order = snap.to_dict() or {}
            status = order_status(self.db, order, self.now)
            self.orders[status["order_id"]] = status
            out.append(status)
        out.sort(key=lambda o: str(o.get("due_at") or ""))
        return {"now": self.now.isoformat(), "orders": out}

    def get_machine_history(self, machine_id: str) -> dict:
        """Returns a machine's state changes and alarms over the last 8 hours (stops, alarm texts, current state).

        Args:
            machine_id: A machine id from an order's machines list.
        """
        snap = self.db.collection("machines").document(machine_id).get()
        if not snap.exists:
            return {"error": f"machine {machine_id} not found"}
        m = snap.to_dict() or {}
        since = (self.now - timedelta(hours=8)).isoformat()
        events = [
            s.to_dict() or {}
            for s in self.db.collection("machine_events").where("ts", ">=", since).stream()
        ]
        events = sorted((e for e in events if e.get("machine_id") == machine_id and e.get("event_type") in ("state_change", "alarm", "alarm_cleared")),
                        key=lambda e: str(e.get("ts")))
        stops = [e for e in events if e.get("event_type") == "state_change" and e.get("to_state") == "stopped"]
        return {
            "machine_id": machine_id,
            "name": m.get("name"),
            "state": m.get("state"),
            "last_alarm": m.get("last_alarm"),
            "ideal_cycle_s": m.get("ideal_cycle_s"),
            "stops_last_8h": len(stops),
            "alarms_last_8h": [e.get("alarm_text") for e in events if e.get("event_type") == "alarm"][-5:],
            "recent_events": [{k: e.get(k) for k in ("ts", "event_type", "to_state", "alarm_text")} for e in events[-10:]],
        }


INVESTIGATOR_INSTRUCTION = """You are the production planner of a small factory. Answer: will we make today's orders?
1. Call list_open_orders. Use only its numbers (made, rate_per_hour, first_pass_rate, projected_good, shortfall,
   rate_needed_per_hour); never compute new totals yourself.
2. For every order that is at risk (on_track false) or unknown (on_track null), call get_machine_history for its
   machines to find the constraint (stopped machine, repeated alarms, slow rate against ideal_rate_per_hour).
3. Write notes: per order, on track or not and why; the main constraint; and up to three concrete actions a
   supervisor could approve (for example add a machine to the order, clear a recurring alarm, extend the shift).
   Only estimate extra units when it follows directly from the tool numbers. If there are no open orders, say so."""

REPORTER_INSTRUCTION = """Turn the planner's notes into the report. Use only facts from the notes:
{findings}
Use the exact order ids from the notes. Keep every sentence short and plain."""


def build_demand_agent(tools: DemandTools) -> SequentialAgent:
    investigator = LlmAgent(
        name="planner",
        model=MODEL_FLASH,
        description="Checks open orders against live machine output with read-only tools.",
        instruction=INVESTIGATOR_INSTRUCTION,
        tools=[tools.list_open_orders, tools.get_machine_history],
        output_key="findings",
    )
    reporter = LlmAgent(
        name="reporter",
        model=MODEL_FLASH,
        description="Writes the structured answer.",
        instruction=REPORTER_INSTRUCTION,
        output_schema=DemandReport,
        output_key="report",
    )
    return SequentialAgent(name="demand_planner", sub_agents=[investigator, reporter])


def sanitise(report: DemandReport, tools: DemandTools) -> DemandReport:
    """Keeps only verdicts for orders the tools returned."""
    report.orders = [o for o in report.orders if o.order_id in tools.orders]
    return report


async def run_demand(db: Any, user_id: str) -> dict:
    """Runs the agent once; returns the report, the tool-computed order numbers and the tool calls made."""
    tools = DemandTools(db)
    sessions = InMemorySessionService()
    runner = Runner(app_name=APP_NAME, agent=build_demand_agent(tools), session_service=sessions)
    session = await sessions.create_session(app_name=APP_NAME, user_id=user_id)

    steps: list[dict] = []
    message = types.Content(role="user", parts=[types.Part(text="Will we make today's orders?")])
    async for event in runner.run_async(user_id=user_id, session_id=session.id, new_message=message):
        for call in event.get_function_calls() or []:
            steps.append({"agent": event.author, "tool": call.name, "args": dict(call.args or {})})

    final = await sessions.get_session(app_name=APP_NAME, user_id=user_id, session_id=session.id)
    raw = (final.state if final else {}).get("report")
    if raw is None:
        raise RuntimeError("demand agent returned no report")
    report = raw if isinstance(raw, DemandReport) else DemandReport.model_validate(raw)
    report = sanitise(report, tools)
    return {"report": report.model_dump(), "orders": list(tools.orders.values()), "agent_steps": steps}
