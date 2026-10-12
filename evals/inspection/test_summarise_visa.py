"""Tests for the VisA summary maths with a tiny synthetic fixture (no real results)."""

from evals.inspection.summarise_visa import cost, score, summarise, verdicts


def _rec(img, label, lite, flash, cat="candle"):
    call = lambda d: {"result": {"defective": d}, "ms": 1000, "in": 1000, "out": 30, "think": 0}  # noqa: E731
    return {"image": img, "category": cat, "label": label, "lite_ref": call(lite), "flash_single": call(flash)}


def test_modes_and_scores():
    recs = [
        _rec("a", "anomaly", True, True),    # caught by all
        _rec("b", "anomaly", True, False),   # few_false_alarms misses
        _rec("c", "normal", False, True),    # flash false alarm
        _rec("d", "normal", False, False),
    ]
    assert verdicts(recs[1]) == {"lite_ref": True, "flash_single": False, "catch_everything": True, "few_false_alarms": False}
    ffa = score(recs, "few_false_alarms")
    assert ffa["defects_caught"] == 0.5 and ffa["false_alarms"] == 0.0 and ffa["accuracy"] == 0.75
    ce = score(recs, "catch_everything")
    assert ce["defects_caught"] == 1.0 and ce["false_alarms"] == 0.5


def test_default_mode_cost_counts_confirm_only_after_a_positive_screen():
    flagged, clean = _rec("a", "anomaly", True, True), _rec("d", "normal", False, False)
    assert cost(flagged, "few_false_alarms") == cost(flagged, "catch_everything")
    assert cost(clean, "few_false_alarms") == cost(clean, "lite_ref")


def test_failed_calls_are_excluded_and_counted():
    recs = {"a": _rec("a", "anomaly", True, True), "x": {"image": "x", "category": "candle", "label": "normal",
                                                         "lite_ref": {"error": "403"}, "flash_single": {"error": "403"}}}
    s = summarise(recs)
    assert s["images_total"] == 2 and s["images_scored"] == 1 and s["images_failed"] == 1
    assert s["by_category"]["candle"]["few_false_alarms"]["n"] == 1
