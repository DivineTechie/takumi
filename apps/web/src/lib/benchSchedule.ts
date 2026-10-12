/**
 * HOME RIG test bench fault schedule: a deterministic, seeded timeline of running / idle /
 * stopped periods with alarms for each simulated machine, so a soak run can be replayed and scored.
 */

export const BENCH_ALARMS = [
  'E-104 SPINDLE OVERLOAD',
  'E-221 COOLANT LOW',
  'E-310 DOOR OPEN',
  'E-415 AIR PRESSURE LOW',
  'E-502 FEED JAM',
  'E-618 HYDRAULIC TEMP HIGH',
];

export type BenchState = 'running' | 'idle' | 'stopped';

export interface BenchPhase {
  /** Seconds since the run started. */
  t: number;
  state: BenchState;
  /** Alarm shown while stopped. */
  alarm: string | null;
}

export type BenchPace = 'realistic' | 'fast';

/** mulberry32: small, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds one machine's schedule. Realistic pace: a stop every 10-40 min lasting 1-8 min, and an idle
 * spell of 1-4 min before about a third of the restarts. Fast pace divides every duration by 10 so a
 * 15-minute run still contains several stops.
 */
export function buildBenchSchedule(seed: number, slot: number, durationS: number, pace: BenchPace): BenchPhase[] {
  const rand = mulberry32(seed * 1000 + slot);
  const k = pace === 'fast' ? 0.1 : 1;
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);

  const phases: BenchPhase[] = [{ t: 0, state: 'running', alarm: null }];
  let t = 0;
  while (true) {
    t += between(10 * 60, 40 * 60) * k;
    if (t >= durationS) break;
    const alarm = BENCH_ALARMS[Math.floor(rand() * BENCH_ALARMS.length)];
    phases.push({ t: Math.round(t), state: 'stopped', alarm });
    t += between(60, 8 * 60) * k;
    if (t >= durationS) break;
    if (rand() < 0.35) {
      phases.push({ t: Math.round(t), state: 'idle', alarm: null });
      t += between(60, 4 * 60) * k;
      if (t >= durationS) break;
    }
    phases.push({ t: Math.round(t), state: 'running', alarm: null });
  }
  return phases;
}

/** The phase in force at run second `s`. */
export function phaseAt(phases: BenchPhase[], s: number): BenchPhase {
  let current = phases[0];
  for (const p of phases) {
    if (p.t <= s) current = p;
    else break;
  }
  return current;
}

/** Formats seconds as HH:MM:SS. */
export function formatRunClock(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
