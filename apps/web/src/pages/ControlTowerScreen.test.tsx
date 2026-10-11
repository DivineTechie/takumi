import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ControlTowerScreen } from './ControlTowerScreen';
import { describe as describeEvent } from '../lib/controlEvents';
import * as apiModule from '../lib/api';

vi.mock('../lib/api', () => ({
  fetchControlSummary: vi.fn(),
  fetchOrders: vi.fn().mockResolvedValue([]),
  fetchMachines: vi.fn().mockResolvedValue([]),
  createOrder: vi.fn(),
  closeOrder: vi.fn(),
  runDemandAgent: vi.fn(),
  ApiError: class extends Error {},
}));

const kpis = (over: Partial<apiModule.ControlSourceKpis>): apiModule.ControlSourceKpis => ({
  inspected: 0, ok: 0, defective: 0, needs_review: 0, first_pass_rate: null, confirmed_defects: 0, overridden: 0,
  stations_completed: 0, steps_verified: 0, mistakes: 0, safety_stops: 0, machine_stops: 0, machine_alarms: 0,
  units_held: 0, events: 0, ...over,
});

describe('ControlTowerScreen', () => {
  it('shows KPIs per source with LIVE first and a feed linking units', async () => {
    vi.mocked(apiModule.fetchControlSummary).mockResolvedValue({
      hours: 24,
      last_event_at: new Date().toISOString(),
      by_source: {
        'PUBLIC DATA: VisA (CC BY 4.0)': kpis({ inspected: 5, ok: 4, first_pass_rate: 0.8, events: 5 }),
        LIVE: kpis({ inspected: 10, ok: 9, first_pass_rate: 0.9, mistakes: 2, events: 14 }),
      },
      feed: [
        { ts: new Date().toISOString(), kind: 'station', event_type: 'mistake', source: 'LIVE', unit_id: 'SN-1', machine_id: null,
          product_id: null, station: 'skill_cable', step: 2, status: null, detail: { reason: 'adapter reversed' } },
      ],
    });
    render(
      <MemoryRouter>
        <ControlTowerScreen />
      </MemoryRouter>
    );
    const blocks = await screen.findAllByTestId(/^source-/);
    expect(blocks[0]).toHaveAttribute('data-testid', 'source-LIVE');
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getByText('Mistake at step 2: adapter reversed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'SN-1' })).toHaveAttribute('href', '/units/SN-1');
  });

  it('describes machine and unit events in plain words', () => {
    const base = { ts: '', source: 'HOME RIG', unit_id: null, machine_id: 'm', product_id: null, station: null, step: null };
    expect(describeEvent({ ...base, kind: 'machine', event_type: 'alarm', status: 'stopped', detail: { alarm_text: 'E-104 SPINDLE OVERLOAD' } })).toBe('Alarm: E-104 SPINDLE OVERLOAD');
    expect(describeEvent({ ...base, kind: 'unit', event_type: 'hold', status: 'on_hold', detail: { reason: 'step 2' } })).toBe('Put on hold: step 2');
  });
});
