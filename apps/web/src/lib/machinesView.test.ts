import { describe, it, expect } from 'vitest';
import { latestPerMachine, visibleMachines } from './machinesView';
import type { Machine } from './api';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const m = (id: string, name: string, hoursAgo: number | null, slot: number | null = 1, source = 'VIRTUAL') =>
  ({ id, name, source, bench_slot: slot, last_seen_at: hoursAgo === null ? null : new Date(NOW - hoursAgo * 3600_000).toISOString() }) as unknown as Machine;

describe('visibleMachines', () => {
  it('keeps the latest setup of each machine and folds long-silent ones away', () => {
    const { shown, offline } = visibleMachines([m('a', 'Press 2', 3), m('b', 'Press 2', 1), m('c', 'press 2 ', 2), m('d', 'Lathe', 30, null, 'LIVE'), m('e', 'Mill', null, 2)], NOW);
    expect(shown.map((x) => x.id)).toEqual(['b']);
    expect(offline.map((x) => x.id).sort()).toEqual(['d', 'e']);
  });

  it('treats the same name on another bench slot or source as a different machine', () => {
    const { shown } = visibleMachines([m('a', 'Press 2', 1, 1), m('b', 'Press 2', 1, 2), m('c', 'Press 2', 1, null, 'LIVE')], NOW);
    expect(shown).toHaveLength(3);
  });
});

describe('latestPerMachine', () => {
  it('lists the newest setup of each machine first and keeps repeats as older setups', () => {
    const made = (id: string, name: string, createdHoursAgo: number) =>
      ({ id, name, source: 'VIRTUAL', bench_slot: 1, last_seen_at: null, created_at: new Date(NOW - createdHoursAgo * 3600_000).toISOString() }) as unknown as Machine;
    const { latest, older } = latestPerMachine([made('a', 'Press 2', 48), made('b', 'Press 2', 2), made('c', 'Lathe', 5)]);
    expect(latest.map((x) => x.id).sort()).toEqual(['b', 'c']);
    expect(older.map((x) => x.id)).toEqual(['a']);
  });
});
