import type { Machine } from './api';

/** Machines not seen for longer than this are folded into a count instead of a card. */
export const OFFLINE_AFTER_MS = 24 * 3600_000;

function seenAt(m: Machine): number {
  return m.last_seen_at ? Date.parse(m.last_seen_at) : 0;
}

/**
 * One entry per physical machine: repeated setups of the same machine (same name, source and bench
 * slot) keep only the most recently seen one. Machines silent for over a day are returned separately.
 */
export function visibleMachines(machines: Machine[], now = Date.now()): { shown: Machine[]; offline: Machine[] } {
  const latest = new Map<string, Machine>();
  for (const m of machines) {
    const slot = (m as Machine & { bench_slot?: number | null }).bench_slot ?? '';
    const key = `${m.source}|${m.name.trim().toLowerCase()}|${slot}`;
    const prev = latest.get(key);
    if (!prev || seenAt(m) > seenAt(prev)) latest.set(key, m);
  }
  const unique = [...latest.values()];
  return {
    shown: unique.filter((m) => seenAt(m) && now - seenAt(m) <= OFFLINE_AFTER_MS),
    offline: unique.filter((m) => !seenAt(m) || now - seenAt(m) > OFFLINE_AFTER_MS),
  };
}
