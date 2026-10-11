import type { Machine } from './api';

/**
 * Detection stopwatch for the test bench: how long after a bench machine really changed state did
 * TAKUMI's watched copy of it report the same state? Measured on the bench screen's own clock, so
 * clock differences between devices do not matter; the polling interval is the only added delay.
 */

/** A watched machine is only trusted if the camera reported within this window. */
export const WATCH_FRESH_MS = 15 * 60_000;
/** Changes not seen within this time are reported as missed. */
export const DETECTION_GIVE_UP_MS = 90_000;
export const DETECTION_POLL_MS = 500;

export type BenchMachineState = 'running' | 'idle' | 'stopped';

export interface PendingChange {
  target: BenchMachineState;
  since: number;
}

export type DetectionResult = { kind: 'seen'; afterS: number; at: number } | { kind: 'missed'; at: number } | { kind: 'no_camera'; at: number };

/** The machine record watching this bench slot: the most recently seen one, if it is fresh. */
export function watchedFor(machines: Machine[], slot: number, now: number): Machine | null {
  const candidates = machines
    .filter((m) => (m as Machine & { bench_slot?: number | null }).bench_slot === slot && m.source === 'VIRTUAL' && m.last_seen_at)
    .sort((a, b) => Date.parse(b.last_seen_at as string) - Date.parse(a.last_seen_at as string));
  const best = candidates[0];
  if (!best || now - Date.parse(best.last_seen_at as string) > WATCH_FRESH_MS) return null;
  return best;
}

/** Decides what a poll means for one pending change; null means keep waiting. */
export function resolvePending(pending: PendingChange, watched: Machine | null, now: number): DetectionResult | null {
  if (!watched) return { kind: 'no_camera', at: now };
  if (watched.state === pending.target) return { kind: 'seen', afterS: Math.round((now - pending.since) / 100) / 10, at: now };
  if (now - pending.since > DETECTION_GIVE_UP_MS) return { kind: 'missed', at: now };
  return null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
}
