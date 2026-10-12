"""Every Pydantic model passed to Gemini as response_schema must be accepted by the Gemini API.

The API rejects JSON schemas that contain additionalProperties, which Pydantic emits for
model_config = ConfigDict(extra="forbid"). This broke the ask-the-master answers once; keep it out.
"""

import pytest

from services.api.machines import MachineReadGeminiResponse, SetupBoxesGeminiResponse
from services.api.prompts import (
    AskResponse,
    InspectionStageResponse,
    PointerResponse,
    VerifierResponse,
    WatcherResponse,
)

GEMINI_SCHEMAS = [
    AskResponse,
    InspectionStageResponse,
    MachineReadGeminiResponse,
    PointerResponse,
    SetupBoxesGeminiResponse,
    VerifierResponse,
    WatcherResponse,
]


def _keys(node):
    if isinstance(node, dict):
        for k, v in node.items():
            yield k
            yield from _keys(v)
    elif isinstance(node, list):
        for v in node:
            yield from _keys(v)


@pytest.mark.parametrize("model", GEMINI_SCHEMAS, ids=lambda m: m.__name__)
def test_gemini_response_schema_has_no_additional_properties(model):
    assert "additionalProperties" not in set(_keys(model.model_json_schema()))
