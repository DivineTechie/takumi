import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MachinesNow } from './MachinesNow';
import * as apiModule from '../../lib/api';

vi.mock('../../lib/api', () => ({ fetchMachines: vi.fn() }));

describe('MachinesNow', () => {
  it('shows stopped machines in red with their alarm and the source label', async () => {
    vi.mocked(apiModule.fetchMachines).mockResolvedValue([
      { id: 'm1', name: 'Press 2', state: 'stopped', last_alarm: 'E-221 COOLANT LOW', source: 'VIRTUAL', last_seen_at: new Date().toISOString() },
      { id: 'm2', name: 'CNC Mill 1', state: 'running', last_alarm: null, source: 'LIVE', last_seen_at: null },
    ] as unknown as apiModule.Machine[]);
    render(<MachinesNow />);
    expect(await screen.findByText('· 1 stopped')).toBeInTheDocument();
    expect(screen.getByText('E-221 COOLANT LOW')).toBeInTheDocument();
    expect(screen.getByTestId('machine-now-m1').className).toContain('bg-red-600');
    expect(screen.getByText(/HOME RIG/)).toBeInTheDocument();
    expect(screen.getByText('Turn on stop alerts')).toBeInTheDocument();
  });

  it('treats a machine with no recent reading as off camera, not stopped', async () => {
    vi.mocked(apiModule.fetchMachines).mockResolvedValue([
      { id: 'm1', name: 'Press 2', state: 'stopped', last_alarm: 'E-221', source: 'VIRTUAL', last_seen_at: new Date(Date.now() - 20 * 60_000).toISOString() },
    ] as unknown as apiModule.Machine[]);
    render(<MachinesNow />);
    expect(await screen.findByText('no camera (last: stopped)')).toBeInTheDocument();
    expect(screen.queryByText(/stopped$/)).toBeNull();
    expect(screen.getByTestId('machine-now-m1').className).not.toContain('bg-red-600');
  });
});
