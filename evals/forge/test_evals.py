"""
Automated pytest tests for Forge evaluation harness.
"""

import os
import sys
from pathlib import Path
import pytest

repo_root = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(repo_root))

os.environ["MOCK_MODELS"] = "true"
os.environ["LOCAL_DEV"] = "true"

from evals.forge.evaluator import ForgeEvaluator


@pytest.fixture
def evaluator():
    return ForgeEvaluator()


def test_evaluator_fixtures_exist(evaluator):
    fixtures = list(evaluator.fixtures_dir.glob("*.json"))
    assert len(fixtures) >= 3, f"Expected at least 3 evaluation fixtures, found {len(fixtures)}"


def test_terminal_wiring_benchmark(evaluator):
    fixture = evaluator.load_fixture("terminal_wiring.json")
    results = evaluator.evaluate_fixture(fixture)
    assert results["recall"] >= 0.75
    assert results["precision"] >= 0.75
    assert results["self_check_passed"] is True


def test_run_all_benchmarks(evaluator):
    results = evaluator.run_all()
    assert len(results) == 3
    for r in results:
        assert r["recall"] > 0.6
        assert r["precision"] > 0.6
        assert r["self_check_passed"] is True
