import { describe, it, expect } from 'vitest';
import { median, resolvePending, watchedFor, DETECTION_GIVE_UP_MS } from './detectionTimer';
import type { Machine } from './api';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const m = (id: string, slot: number | null, state: string, seenMsAgo: number | null, source = 'VIRTUAL') =>
  ({ id, name: id, bench_slot: slot, state, source, last_seen_at: seenMsAgo === null ? null : iso(seenMsAgo) }) as unknown as Machine;

describe('detection stopwatch', () => {
  it('picks the freshest virtual machine on the slot and ignores stale ones', () => {
    const list = [m('old', 2, 'running', 60_000), m('new', 2, 'stopped', 2_000), m('live', 2, 'stopped', 1_000, 'LIVE'), m('other', 1, 'idle', 1_000)];
    expect(watchedFor(list, 2, NOW)?.id).toBe('new');
    expect(watchedFor([m('stale', 3, 'running', 20 * 60_000)], 3, NOW)).toBeNull();
    expect(watchedFor([m('never', 3, 'running', null)], 3, NOW)).toBeNull();
  });

  it('measures from the real change to the first poll that agrees', () => {
    const pending = { target: 'stopped' as const, since: NOW - 3_420 };
    expect(resolvePending(pending, m('a', 1, 'running', 500), NOW)).toBeNull();
    expect(resolvePending(pending, m('a', 1, 'stopped', 500), NOW)).toEqual({ kind: 'seen', afterS: 3.4, at: NOW });
    expect(resolvePending(pending, null, NOW)?.kind).toBe('no_camera');
    expect(resolvePending({ target: 'idle', since: NOW - DETECTION_GIVE_UP_MS - 1 }, m('a', 1, 'running', 500), NOW)?.kind).toBe('missed');
  });

  it('computes a median', () => {
    expect(median([])).toBeNull();
    expect(median([4.1, 3.2, 9])).toBe(4.1);
    expect(median([3, 4])).toBe(3.5);
  });
});
