"""Order projection maths (shared by the API and the demand agent)."""

from datetime import datetime, timedelta, timezone

from shared.ops.demand import machine_output, project_order

T0 = datetime(2026, 10, 11, 8, 0, tzinfo=timezone.utc)


def _c(minutes, count, flag=None):
    return {"event_type": "count", "ts": (T0 + timedelta(minutes=minutes)).isoformat(), "count": count, "flag": flag}


def test_machine_output_made_and_recent_rate_ignore_misreads_and_old_reads():
    events = [_c(-30, 10), _c(0, 100), _c(60, 220), _c(70, 9999, flag="rejected_misread"), _c(90, 280), _c(120, 340)]
    out = machine_output(events, since=T0, now=T0 + timedelta(minutes=120))
    assert out["made"] == 240
    assert out["rate_per_hour"] == 120.0  # 280 -> 340 over the last 30 min
    assert machine_output([_c(0, 5)], since=T0, now=T0 + timedelta(hours=1))["rate_per_hour"] is None


def test_project_order_on_track_and_shortfall_with_yield():
    now, due = T0 + timedelta(hours=2), T0 + timedelta(hours=6)
    ok = project_order(quantity=500, made=240, rate_per_hour=120, now=now, due=due)
    assert ok["projected_good"] == 720 and ok["shortfall"] == 0 and ok["on_track"] is True
    short = project_order(quantity=800, made=240, rate_per_hour=60, now=now, due=due, first_pass_rate=0.9)
    assert short["projected_good"] == round(240 * 0.9 + 60 * 4 * 0.9)
    assert short["shortfall"] == 800 - short["projected_good"] and short["on_track"] is False
    assert short["rate_needed_per_hour"] == round((800 - 216) / (4 * 0.9), 1)


def test_unknown_rate_and_past_due():
    r = project_order(quantity=100, made=10, rate_per_hour=None, now=T0, due=T0 + timedelta(hours=1))
    assert r["projected_good"] is None and r["on_track"] is None and r["rate_needed_per_hour"] == 90.0
    late = project_order(quantity=100, made=10, rate_per_hour=50, now=T0, due=T0 - timedelta(hours=1))
    assert late["hours_left"] == 0 and late["shortfall"] == 90 and late["rate_needed_per_hour"] is None
