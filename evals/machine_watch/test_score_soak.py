"""Tests for the soak-run scorer with a synthetic fixture (no Firestore, no fake results files)."""

from datetime import datetime, timezone

from evals.machine_watch.score_soak import retime
from evals.machine_watch.score_soak import Event, cost, detection_events, score, truth_events, watch_start, while_watched, in_window


def test_truth_skips_starting_state_and_keeps_changes():
    rows = [
        {"machine_id": "bench_1", "event_type": "state_change", "state": "running", "run_s": 0.5},
        {"machine_id": "bench_1", "event_type": "count", "count": 1, "run_s": 12},
        {"machine_id": "bench_1", "event_type": "state_change", "state": "stopped", "run_s": 600},
        {"machine_id": "bench_1", "event_type": "alarm", "alarm_code": "E-104", "run_s": 600},
        {"machine_id": "bench_1", "event_type": "alarm_cleared", "run_s": 900},
    ]
    assert truth_events(rows) == [
        Event("bench_1", "stopped", 600),
        Event("bench_1", "alarm", 600),
        Event("bench_1", "alarm_cleared", 900),
    ]


def test_detections_map_to_bench_slots_and_skip_warmup():
    rows = [
        {"machine_id": "mach_a", "event_type": "state_change", "to_state": "running", "run_s": 3},
        {"machine_id": "mach_a", "event_type": "state_change", "to_state": "stopped", "run_s": 604},
        {"machine_id": "mach_unknown", "event_type": "alarm", "run_s": 605},
        {"machine_id": "mach_a", "event_type": "count", "count": 50, "run_s": 610},
    ]
    assert detection_events(rows, {"mach_a": 1}) == [Event("bench_1", "stopped", 604)]


def test_score_rates_delays_and_false_alarms():
    truth = [
        Event("bench_1", "stopped", 600),
        Event("bench_1", "alarm", 600),
        Event("bench_1", "running", 900),
        Event("bench_2", "stopped", 1200),  # missed
    ]
    detections = [
        Event("bench_1", "stopped", 604),
        Event("bench_1", "alarm", 607),
        Event("bench_1", "running", 1100),  # too late (window 120 s) -> miss + false alarm
        Event("bench_2", "idle", 1500),  # no truth -> false alarm
    ]
    r = score(truth, detections, window_s=120)
    assert r["kinds"]["stopped"]["truth"] == 2
    assert r["kinds"]["stopped"]["detected"] == 1
    assert r["kinds"]["stopped"]["median_delay_s"] == 4
    assert r["kinds"]["alarm"]["median_delay_s"] == 7
    assert r["kinds"]["running"]["detected"] == 0
    assert r["kinds"]["running"]["false_alarms"] == 1
    assert r["kinds"]["idle"]["false_alarms"] == 1
    assert r["overall"]["truth"] == 4
    assert r["overall"]["detected"] == 2
    assert r["overall"]["rate"] == 0.5
    assert r["overall"]["false_alarms"] == 2


def test_each_detection_matches_one_truth_only():
    truth = [Event("bench_1", "stopped", 600), Event("bench_1", "stopped", 650)]
    detections = [Event("bench_1", "stopped", 605)]
    r = score(truth, detections)
    assert r["overall"]["detected"] == 1
    assert r["overall"]["false_alarms"] == 0


def test_cost_per_machine_month():
    c = cost({"m1": 60, "m2": 60}, tokens_in=120 * 1000, tokens_out=120 * 30, hours=1.0, machines=2)
    assert c["reads_per_machine_hour"] == 60
    per_read = (1000 * 0.30 + 30 * 1.50) / 1e6
    assert abs(c["usd_per_read"] - per_read) < 1e-12
    assert abs(c["usd_per_machine_month"] - 60 * 24 * 30 * per_read) < 1e-9
    assert cost({}, 0, 0, 1.0, 1)["usd_per_machine_month"] is None


def test_truth_before_the_machine_was_watched_is_not_counted():
    rows = [{"machine_id": "mach_a", "event_type": "state_change", "to_state": "running", "run_s": 300},
            {"machine_id": "mach_a", "event_type": "count", "count": 5, "run_s": 900}]
    starts = watch_start(rows, {"mach_a": 1})
    assert starts == {"bench_1": 300}
    truth = [Event("bench_1", "stopped", 120), Event("bench_1", "stopped", 320), Event("bench_1", "stopped", 600),
             Event("bench_2", "stopped", 600)]
    assert while_watched(truth, starts) == [Event("bench_1", "stopped", 600)]  # 320 is inside the 30 s warm-up


def test_window_drops_starting_readings_and_events_after_the_run():
    starts = {"bench_1": 49.0}
    events = [Event("bench_1", "running", 50), Event("bench_1", "stopped", 300), Event("bench_1", "stopped", 912)]
    assert in_window(events, starts, end_s=900) == [Event("bench_1", "stopped", 300)]


def test_retime_untagged_bench_readings_by_server_clock():
    started = datetime(2026, 10, 11, 15, 42, 41, tzinfo=timezone.utc)
    rows = [
        {"machine_id": "m1", "ts": "2026-10-11T15:41:52+00:00", "event_type": "state_change"},   # before the run
        {"machine_id": "m1", "ts": "2026-10-11T15:44:41+00:00", "event_type": "state_change"},   # 120 s in
        {"machine_id": "m1", "ts": "2026-10-11T15:45:00+00:00", "soak_run_id": "other"},         # tagged: skipped
        {"machine_id": "x9", "ts": "2026-10-11T15:45:00+00:00", "event_type": "alarm"},          # not a bench machine
    ]
    out = retime(rows, {"m1": 1}, started, 900)
    assert len(out) == 1 and out[0]["run_s"] == 120.0
