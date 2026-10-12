import { describe, expect, it } from 'vitest';
import { buildBenchSchedule, formatRunClock, phaseAt } from './benchSchedule';

describe('benchSchedule', () => {
  it('is deterministic per seed and slot, and differs between slots', () => {
    const a = buildBenchSchedule(42, 1, 8 * 3600, 'realistic');
    expect(buildBenchSchedule(42, 1, 8 * 3600, 'realistic')).toEqual(a);
    expect(buildBenchSchedule(42, 2, 8 * 3600, 'realistic')).not.toEqual(a);
  });

  it('follows the realistic timing rules', () => {
    const phases = buildBenchSchedule(7, 1, 8 * 3600, 'realistic');
    expect(phases[0]).toEqual({ t: 0, state: 'running', alarm: null });
    for (let i = 1; i < phases.length; i++) {
      const prev = phases[i - 1];
      const gap = phases[i].t - prev.t;
      expect(phases[i].t).toBeLessThan(8 * 3600);
      if (phases[i].state === 'stopped') {
        expect(prev.state).toBe('running');
        expect(gap).toBeGreaterThanOrEqual(10 * 60 - 1);
        expect(gap).toBeLessThanOrEqual(40 * 60 + 1);
        expect(phases[i].alarm).toBeTruthy();
      }
      if (prev.state === 'stopped') {
        expect(gap).toBeGreaterThanOrEqual(59);
        expect(gap).toBeLessThanOrEqual(8 * 60 + 1);
      }
    }
    expect(phases.filter((p) => p.state === 'stopped').length).toBeGreaterThan(5);
  });

  it('fast pace still produces several stops in 15 minutes', () => {
    const phases = buildBenchSchedule(42, 1, 15 * 60, 'fast');
    expect(phases.filter((p) => p.state === 'stopped').length).toBeGreaterThanOrEqual(3);
  });

  it('finds the phase in force and formats the clock', () => {
    const phases = buildBenchSchedule(42, 1, 3600, 'fast');
    expect(phaseAt(phases, 0).state).toBe('running');
    expect(phaseAt(phases, phases[1].t).state).toBe(phases[1].state);
    expect(formatRunClock(3725)).toBe('01:02:05');
  });
});
