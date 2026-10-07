"""Unit tests for cost_guard module."""

import pytest
from infra.loadtest.cost_guard import enforce_cost_guard


def test_cost_guard_allows_within_limits():
    # Should not raise
    enforce_cost_guard(total_calls=20, max_calls=50)
    enforce_cost_guard(total_calls=20, max_calls=50, is_default_thinking_verify=True, i_know_this_costs=False)
    enforce_cost_guard(total_calls=30, max_calls=50, is_default_thinking_verify=True, i_know_this_costs=True)


def test_cost_guard_refuses_exceeding_max_calls():
    with pytest.raises(SystemExit) as exc_info:
        enforce_cost_guard(total_calls=51, max_calls=50)
    assert exc_info.value.code == 2


def test_cost_guard_refuses_default_thinking_verify_above_20_without_flag():
    with pytest.raises(SystemExit) as exc_info:
        enforce_cost_guard(total_calls=25, max_calls=50, is_default_thinking_verify=True, i_know_this_costs=False)
    assert exc_info.value.code == 2
