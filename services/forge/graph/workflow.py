"""Standard Work Studio pipeline as a Google ADK 2 graph workflow.

Each Studio step is a FunctionNode in an ADK `Workflow`; the graph edges define the order and the
parallel media branch, and an ADK Runner executes it:

START -> load_capture -> segmenter -> why_extractor -> spatial_annotator -> verifier -> localizer
      -> [illustrator, mistake_simulator] -> media_done (join) -> publisher

The steps keep their own Gemini calls (google-genai) and share one ForgeState for the run. A failing
step stops the graph and the error is raised to the caller.
"""

import logging
import time
from collections.abc import Awaitable, Callable

from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.workflow import START, FunctionNode, JoinNode, Workflow
from google.genai import types

from services.forge.events import emit
from services.forge.graph.nodes import (
    run_illustrator,
    run_load_capture,
    run_localizer,
    run_mistake_simulator,
    run_publisher,
    run_segmenter,
    run_spatial_annotator,
    run_verifier,
    run_why_extractor,
)
from services.forge.models.state import ForgeState

logger = logging.getLogger("forge.workflow")

APP_NAME = "takumi_standard_work_studio"

NodeFn = Callable[[ForgeState], Awaitable[ForgeState]]


class StateBox:
    """Holds the ForgeState for one run; every step of that run reads and replaces it."""

    def __init__(self, state: ForgeState):
        self.state = state


def _step(name: str, node: NodeFn, box: StateBox) -> FunctionNode:
    """Wraps one Studio step as an ADK FunctionNode over the shared state."""

    async def run_step() -> dict:
        t0 = time.perf_counter()
        result = await node(box.state)
        if result is not None:
            box.state = result
        return {"step": name, "ms": int((time.perf_counter() - t0) * 1000)}

    run_step.__name__ = name
    return FunctionNode(func=run_step, name=name)


def build_studio_workflow(box: StateBox) -> Workflow:
    """Builds the ADK graph for one Studio run."""
    media = [_step("illustrator", run_illustrator, box), _step("mistake_simulator", run_mistake_simulator, box)]
    return Workflow(
        name="standard_work_studio",
        description="Turns one master capture into a reviewed, multilingual standard work instruction.",
        edges=[(
            START,
            _step("load_capture", run_load_capture, box),
            _step("segmenter", run_segmenter, box),
            _step("why_extractor", run_why_extractor, box),
            _step("spatial_annotator", run_spatial_annotator, box),
            _step("verifier", run_verifier, box),
            _step("localizer", run_localizer, box),
            media,
            JoinNode(name="media_done"),
            _step("publisher", run_publisher, box),
        )],
    )


class ForgePipeline:
    """Runs the Studio graph for one capture with an ADK Runner."""

    async def execute(self, state: ForgeState) -> ForgeState:
        t_start = time.time()
        logger.info("Starting Studio workflow for job %s, capture %s", state.job_id, state.capture_id)
        box = StateBox(state)
        sessions = InMemorySessionService()
        runner = Runner(app_name=APP_NAME, node=build_studio_workflow(box), session_service=sessions)
        try:
            session = await sessions.create_session(app_name=APP_NAME, user_id="forge")
            message = types.Content(role="user", parts=[types.Part(text=f"Process capture {state.capture_id}")])
            async for _event in runner.run_async(user_id="forge", session_id=session.id, new_message=message):
                pass
            logger.info("Studio workflow completed in %s ms", int((time.time() - t_start) * 1000))
            return box.state
        except Exception as e:
            total_ms = int((time.time() - t_start) * 1000)
            logger.exception("Studio workflow failed: %s", e)
            emit(state.job_id, "publisher", f"Pipeline execution failed: {e}", level="error", ms=total_ms)
            box.state.errors.append(str(e))
            raise
