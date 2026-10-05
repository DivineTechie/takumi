"""Unit tests asserting prompts.py contains exact required watcher rules."""

from services.api.prompts import (
    POINTER_PROMPT_TEMPLATE,
    VERIFIER_PROMPT_TEMPLATE,
    WATCHER_PROMPT_TEMPLATE,
)


def test_watcher_rules_word_for_word():
    """Assert the four watcher rules are present word for word in WATCHER_PROMPT_TEMPLATE."""
    rule_1 = "judge success_criteria word for word, from what is visible in this frame only;"
    rule_2 = '"mistake" only when a listed common_mistake\'s visual_cue is visible;'
    rule_3 = (
        '"hazard" only when a safety_rule is clearly and visibly violated in this frame; '
        "never infer invisible states (for example, power being on);"
    )
    rule_4 = '"not_visible" when hands, blur or framing hide the relevant area.'

    assert rule_1 in WATCHER_PROMPT_TEMPLATE, f"Rule 1 missing: {rule_1}"
    assert rule_2 in WATCHER_PROMPT_TEMPLATE, f"Rule 2 missing: {rule_2}"
    assert rule_3 in WATCHER_PROMPT_TEMPLATE, f"Rule 3 missing: {rule_3}"
    assert rule_4 in WATCHER_PROMPT_TEMPLATE, f"Rule 4 missing: {rule_4}"


def test_verifier_and_pointer_templates():
    assert "strict verification inspector" in VERIFIER_PROMPT_TEMPLATE
    assert "spatial pointing system" in POINTER_PROMPT_TEMPLATE
