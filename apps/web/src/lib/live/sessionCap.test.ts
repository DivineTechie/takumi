import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionCapTimer } from './sessionCap';

describe('SessionCapTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers warning at 9m 30s and timeout at 10m', () => {
    const onWarning = vi.fn();
    const onTimeout = vi.fn();
    const onTick = vi.fn();

    const timer = new SessionCapTimer({ onWarning, onTimeout, onTick });
    timer.start();

    // Advance to 9 minutes (540s)
    vi.advanceTimersByTime(9 * 60 * 1000);
    expect(onWarning).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();

    // Advance to 9 minutes 30 seconds (570s)
    vi.advanceTimersByTime(30 * 1000);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(timer.isWarningActive()).toBe(true);

    // Advance to 10 minutes (600s)
    vi.advanceTimersByTime(30 * 1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    timer.stop();
  });

  it('preserves initial start time across reconnects and does not reset the 10-minute cap', () => {
    const onWarning = vi.fn();
    const onTimeout = vi.fn();

    const initialStartTime = Date.now();
    const timer = new SessionCapTimer({ onWarning, onTimeout });
    timer.start(initialStartTime);

    // Advance 5 minutes (300s)
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(timer.getRemainingSeconds()).toBe(300);

    // Simulate reconnect: stop timer and re-start passing initialStartTime
    timer.stop();
    timer.start(initialStartTime);

    // Remaining time must still be 300 seconds, not reset to 600!
    expect(timer.getRemainingSeconds()).toBe(300);

    // Advance remaining 5 minutes
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    timer.stop();
  });
});
