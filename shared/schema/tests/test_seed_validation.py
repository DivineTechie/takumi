import json
from pathlib import Path
import jsonschema
from shared.schema.py.skills import Skill

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_FILE = REPO_ROOT / "shared" / "schema" / "skills.json"
SEED_FILE = REPO_ROOT / "shared" / "seed" / "skill_terminal_wiring_v1.json"


def test_seed_validates_against_json_schema():
    with open(SCHEMA_FILE, "r", encoding="utf-8") as f:
        schema = json.load(f)
    with open(SEED_FILE, "r", encoding="utf-8") as f:
        seed = json.load(f)

    validator = jsonschema.Draft202012Validator(schema)
    errors = list(validator.iter_errors(seed))
    assert not errors, f"JSON Schema validation errors: {[e.message for e in errors]}"


def test_seed_loads_into_pydantic_model():
    with open(SEED_FILE, "r", encoding="utf-8") as f:
        seed_data = json.load(f)

    skill = Skill.model_validate(seed_data)
    assert skill.id == "skill_terminal_wiring_v1"
    assert skill.status.value == "published"
    assert len(skill.steps) == 4
    assert skill.safety_rules == [
        "No bare copper visible outside a terminal",
        "Panel power must be off",
    ]

    for step in skill.steps:
        assert step.instruction
        assert step.success_criteria
        assert step.why
        assert "vi" in step.translations
        assert "hi" in step.translations
        assert len(step.common_mistakes) >= 1
