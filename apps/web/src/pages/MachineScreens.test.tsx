import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { VirtualMachineScreen } from './VirtualMachineScreen';
import { MachineWatchScreen } from './MachineWatchScreen';
import { MachinesPanel } from '../components/dashboard/MachinesPanel';
import * as apiModule from '../lib/api';

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    startSoakRun: vi.fn(),
    endSoakRun: vi.fn(),
    postSoakTruth: vi.fn(),
    fetchMachines: vi.fn(),
    fetchMySoakRuns: vi.fn(),
    readMachine: vi.fn(),
    setupMachine: vi.fn(),
    createMachine: vi.fn(),
    fetchMachinesSummary: vi.fn(),
  };
});

describe('Machine test bench', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiModule.startSoakRun).mockResolvedValue({
      id: 'soak_abc123',
      created_by: 'u1',
      status: 'running',
      schedule_seed: 42,
      duration_min: 60,
      started_at: new Date().toISOString(),
      machines: ['bench_1', 'bench_2', 'bench_3'],
    } as unknown as apiModule.SoakRun);
    vi.mocked(apiModule.postSoakTruth).mockResolvedValue({ status: 'ok' });
  });

  it('shows three machines and the HOME RIG label', () => {
    render(
      <MemoryRouter>
        <VirtualMachineScreen />
      </MemoryRouter>
    );
    expect(screen.getByTestId('stack-light-1')).toBeInTheDocument();
    expect(screen.getByTestId('stack-light-3')).toBeInTheDocument();
    expect(screen.getByText('HOME RIG test bench, simulated machines')).toBeInTheDocument();
    expect(screen.getByTestId('run-clock')).toHaveTextContent('--:--:--');
  });

  it('starts a run for bench machines and logs their starting state as truth', async () => {
    render(
      <MemoryRouter>
        <VirtualMachineScreen />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByText('Start soak run'));
    await waitFor(() => expect(apiModule.startSoakRun).toHaveBeenCalled());
    expect(vi.mocked(apiModule.startSoakRun).mock.calls[0][0].machines).toEqual(['bench_1', 'bench_2', 'bench_3']);
    await waitFor(() => expect(apiModule.postSoakTruth).toHaveBeenCalledTimes(3));
    const firstTruth = vi.mocked(apiModule.postSoakTruth).mock.calls[0][1];
    expect(firstTruth).toMatchObject({ machine_id: 'bench_1', event_type: 'state_change', state: 'running' });
    expect(firstTruth).not.toHaveProperty('ts');
  });

  it('logs an alarm and a state change when a machine is stopped by hand during a manual run', async () => {
    render(
      <MemoryRouter>
        <VirtualMachineScreen />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByLabelText('Automatic faults'));
    fireEvent.click(screen.getByText('Start soak run'));
    await waitFor(() => expect(apiModule.postSoakTruth).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getAllByText('Stop + alarm')[0]);
    const types = vi.mocked(apiModule.postSoakTruth).mock.calls.slice(3).map((c) => c[1].event_type);
    expect(types).toEqual(['state_change', 'alarm']);
    expect(screen.getByTestId('hmi-1')).toHaveTextContent('E-104 SPINDLE OVERLOAD');
  });
});

describe('Machine Watch page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiModule.fetchMachines).mockResolvedValue([]);
    vi.mocked(apiModule.fetchMySoakRuns).mockResolvedValue([]);
  });

  it('renders the privacy note, camera button, and hides the video-file option without debug', async () => {
    render(
      <MemoryRouter>
        <MachineWatchScreen />
      </MemoryRouter>
    );
    expect(await screen.findByText('No machines yet.')).toBeInTheDocument();
    expect(screen.getByText(/Only small crops/)).toBeInTheDocument();
    expect(screen.getByText('Start camera')).toBeInTheDocument();
    expect(screen.queryByText('Use video file')).not.toBeInTheDocument();
  });
});

describe('Machines dashboard panel', () => {
  it('shows availability, stops and the source label from the summary', async () => {
    vi.mocked(apiModule.fetchMachinesSummary).mockResolvedValue({
      day: '2026-10-10',
      window_end: '2026-10-10T12:00:00+00:00',
      machines: [
        {
          id: 'm1',
          name: 'Press 2',
          state: 'stopped',
          last_alarm: 'E-221 COOLANT LOW',
          last_count: 120,
          last_seen_at: null,
          segments: [{ state: 'running', start: '2026-10-10T08:00:00+00:00', end: '2026-10-10T10:00:00+00:00' }],
          running_s: 7200,
          idle_s: 0,
          stopped_s: 1800,
          availability: 0.8,
          performance: 0.5,
          stops: 2,
          parts: 450,
          top_alarms: [{ alarm_text: 'E-221 COOLANT LOW', count: 2 }],
          source: 'HOME RIG',
          events: 10,
        },
      ],
    });
    render(<MachinesPanel />);
    expect(await screen.findByText('Press 2')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument(); // OEE = 0.8 x 0.5
    expect(screen.getByText('HOME RIG')).toBeInTheDocument();
    expect(screen.getByText(/E-221 COOLANT LOW \(2\)/)).toBeInTheDocument();
  });
});
