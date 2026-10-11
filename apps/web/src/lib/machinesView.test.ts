import { describe, it, expect } from 'vitest';
import { visibleMachines } from './machinesView';
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
