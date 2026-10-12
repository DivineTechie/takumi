"""Standard Work Studio pipeline as a Google ADK 2 graph workflow.

Each Studio step is a FunctionNode in an ADK `Workflow`; the graph edges define the order and the
parallel branch, and an ADK Runner executes it:

START -> load_capture -> segmenter -> [spatial_annotator, verifier, localizer] -> annotated (join) -> publisher

The steps make their own Gemini calls (google-genai) and share one ForgeState for the run. A failing
step reports an error event under its own name and stops the graph; the whole run is also bounded by
STUDIO_RUN_TIMEOUT_S. The run's local video copy lives in a temp dir that is deleted at the end.
"""

import asyncio
import logging
import tempfile
import time
from collections.abc import Awaitable, Callable

from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.workflow import START, FunctionNode, JoinNode, Workflow
from google.genai import types

from services.forge.config import STUDIO_RUN_TIMEOUT_S
from services.forge.events import emit
from services.forge.graph.nodes import (
    run_load_capture,
    run_localizer,
    run_publisher,
    run_segmenter,
    run_spatial_annotator,
    run_verifier,
)
from services.forge.models.state import ForgeState

logger = logging.getLogger("forge.workflow")

APP_NAME = "takumi_standard_work_studio"

NodeFn = Callable[[ForgeState], Awaitable[ForgeState]]

# Event agent shown in the trace for each graph node.
EVENT_AGENT = {
    "load_capture": "segmenter",
    "segmenter": "segmenter",
    "spatial_annotator": "spatial",
    "verifier": "verifier",
    "localizer": "localizer",
    "publisher": "publisher",
}


class StateBox:
    """Holds the ForgeState for one run; every step of that run reads and replaces it."""

    def __init__(self, state: ForgeState):
        self.state = state


def _step(name: str, node: NodeFn, box: StateBox) -> FunctionNode:
    """Wraps one Studio step as an ADK FunctionNode over the shared state."""

    async def run_step() -> dict:
        t0 = time.perf_counter()
        try:
            result = await node(box.state)
        except Exception as e:
            ms = int((time.perf_counter() - t0) * 1000)
            emit(box.state.job_id, EVENT_AGENT[name], f"Stopped: {str(e)[:400] or type(e).__name__}", level="error", ms=ms)
            e.studio_reported = True
            raise
        if result is not None:
            box.state = result
        return {"step": name, "ms": int((time.perf_counter() - t0) * 1000)}

    run_step.__name__ = name
    return FunctionNode(func=run_step, name=name)


def build_studio_workflow(box: StateBox) -> Workflow:
    """Builds the ADK graph for one Studio run."""
    parallel = [
        _step("spatial_annotator", run_spatial_annotator, box),
        _step("verifier", run_verifier, box),
        _step("localizer", run_localizer, box),
    ]
    return Workflow(
        name="standard_work_studio",
        description="Turns one master capture into a checked, multilingual standard work instruction for review.",
        edges=[(
            START,
            _step("load_capture", run_load_capture, box),
            _step("segmenter", run_segmenter, box),
            parallel,
            JoinNode(name="annotated"),
            _step("publisher", run_publisher, box),
        )],
    )


class ForgePipeline:
    """Runs the Studio graph for one capture with an ADK Runner."""

    async def execute(self, state: ForgeState) -> ForgeState:
        t_start = time.perf_counter()
        logger.info("Starting Studio workflow for job %s, capture %s", state.job_id, state.capture_id)
        box = StateBox(state)
        sessions = InMemorySessionService()
        runner = Runner(app_name=APP_NAME, node=build_studio_workflow(box), session_service=sessions)
        deadline = asyncio.timeout(STUDIO_RUN_TIMEOUT_S)
        with tempfile.TemporaryDirectory(prefix="studio_") as work_dir:
            state.work_dir = work_dir
            try:
                async with deadline:
                    session = await sessions.create_session(app_name=APP_NAME, user_id="forge")
                    message = types.Content(role="user", parts=[types.Part(text=f"Process capture {state.capture_id}")])
                    async for _event in runner.run_async(user_id="forge", session_id=session.id, new_message=message):
                        pass
                logger.info("Studio workflow completed in %s ms", int((time.perf_counter() - t_start) * 1000))
                return box.state
            except Exception as e:
                ms = int((time.perf_counter() - t_start) * 1000)
                if isinstance(e, TimeoutError) and deadline.expired():
                    msg = f"The run took longer than {STUDIO_RUN_TIMEOUT_S / 60:.0f} minutes and was stopped"
                    emit(state.job_id, "publisher", msg, level="error", ms=ms)
                    box.state.errors.append(msg)
                    raise TimeoutError(msg) from None
                if not getattr(e, "studio_reported", False):
                    emit(state.job_id, "publisher", f"Stopped: {str(e)[:400] or type(e).__name__}", level="error", ms=ms)
                logger.exception("Studio workflow failed: %s", e)
                box.state.errors.append(str(e))
                raise
            finally:
                box.state.work_dir = None
                box.state.local_video_path = None
