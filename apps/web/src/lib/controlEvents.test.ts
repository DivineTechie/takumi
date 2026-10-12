import { describe as suite, it, expect } from 'vitest';
import { describe } from './controlEvents';
import type { ControlFeedItem } from './api';

const ev = (over: Partial<ControlFeedItem>) =>
  ({ ts: '2026-10-12T10:00:00Z', kind: 'machine', event_type: 'state_change', source: 'HOME RIG', unit_id: null, machine_id: 'm2', status: 'stopped', detail: {}, ...over }) as ControlFeedItem;

suite('control feed lines', () => {
  it('names the machine and its state change', () => {
    expect(describe(ev({ detail: { from_state: 'running', to_state: 'stopped' } }), undefined, { m2: 'Press 2' })).toBe('Press 2 · running → stopped');
  });

  it('describes the first reading of a newly watched machine instead of an unknown state', () => {
    expect(describe(ev({ status: 'running', detail: { from_state: null, to_state: 'running' } }))).toBe('Now watched: running');
  });

  it('leaves non-machine events unnamed', () => {
    expect(describe(ev({ kind: 'unit', event_type: 'release', machine_id: 'm2' }), undefined, { m2: 'Press 2' })).toBe('Released from hold');
  });
});
