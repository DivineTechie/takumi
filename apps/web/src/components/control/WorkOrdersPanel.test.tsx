import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { WorkOrdersPanel } from './WorkOrdersPanel';
import { MachinesNow } from './MachinesNow';
import * as apiModule from '../../lib/api';

vi.mock('../../lib/api', () => ({
  fetchWorkOrders: vi.fn(),
  draftWorkOrder: vi.fn(),
  decideWorkOrder: vi.fn(),
  speakWorkOrder: vi.fn(),
  fetchMachines: vi.fn(),
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

const wo: apiModule.WorkOrder = {
  id: 'w1',
  machine_id: 'm1',
  machine_name: 'Press 2',
  alarm_text: 'E-221 COOLANT LOW',
  source: 'HOME RIG',
  status: 'draft',
  created_at: new Date().toISOString(),
  agent_ms: 14200,
  agent_steps: [
    { agent: 'maintenance_lead', tool: 'get_machine_status', args: {} },
    { agent: 'maintenance_lead', tool: 'lookup_alarm_guide', args: { alarm_text: 'E-221 COOLANT LOW' } },
  ],
  draft: {
    title: 'Press 2: coolant low',
    priority: 'high',
    summary: 'Press 2 stopped 6 minutes ago with coolant low.',
    likely_causes: [{ cause: 'Tank below minimum', evidence: 'Alarm E-221 on screen' }],
    steps: ['Top up the coolant tank'],
    safety: ['Wear gloves'],
    parts: ['Coolant concentrate'],
    estimated_minutes: 15,
    repeat_issue: true,
    operator_alert: 'Press 2 has stopped: coolant low.',
  },
};

describe('WorkOrdersPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiModule.fetchWorkOrders).mockResolvedValue([wo]);
    vi.mocked(apiModule.decideWorkOrder).mockResolvedValue({ id: 'w1', status: 'approved' });
  });

  it('shows a waiting draft with causes, steps, source label and approves it', async () => {
    render(<WorkOrdersPanel request={null} autoDraft={false} onAutoDraftChange={vi.fn()} />);
    expect(await screen.findByText('Press 2: coolant low')).toBeInTheDocument();
    expect(screen.getByText('· 1 to approve')).toBeInTheDocument();
    expect(screen.getByText('Tank below minimum')).toBeInTheDocument();
    expect(screen.getByText('Top up the coolant tank')).toBeInTheDocument();
    expect(screen.getByText('HOME RIG')).toBeInTheDocument();
    expect(screen.getByText('repeat issue')).toBeInTheDocument();
    expect(screen.getByText(/in 14.2 s/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Approve work order'));
    await waitFor(() => expect(apiModule.decideWorkOrder).toHaveBeenCalledWith('w1', 'approve'));
  });

  it('runs the agent for a request and reveals its real tool calls', async () => {
    vi.mocked(apiModule.fetchWorkOrders).mockResolvedValue([]);
    let resolve: (w: apiModule.WorkOrder) => void = () => {};
    vi.mocked(apiModule.draftWorkOrder).mockReturnValue(new Promise((r) => (resolve = r)));
    vi.mocked(apiModule.speakWorkOrder).mockResolvedValue({ audio: new Blob(), text: 'प्रेस 2 रुक गया है।' });
    const { rerender } = render(<WorkOrdersPanel request={null} autoDraft={false} onAutoDraftChange={vi.fn()} />);
    rerender(<WorkOrdersPanel request={{ machineId: 'm1', name: 'Press 2', nonce: 1 }} autoDraft={false} onAutoDraftChange={vi.fn()} />);
    expect(await screen.findByText(/Maintenance agent is investigating Press 2/)).toBeInTheDocument();
    await act(async () => resolve({ ...wo, existing: false }));
    expect(await screen.findByText(/Read the machine/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(await screen.findByText(/Looked up the alarm guide \(E-221 COOLANT LOW\)/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(apiModule.draftWorkOrder).toHaveBeenCalledWith('m1');
  });

  it('explains when the machine is already running again', async () => {
    vi.mocked(apiModule.fetchWorkOrders).mockResolvedValue([]);
    vi.mocked(apiModule.draftWorkOrder).mockRejectedValue(new (apiModule.ApiError as unknown as new (m: string, s: number) => Error)('x', 409));
    render(<WorkOrdersPanel request={{ machineId: 'm1', name: 'Press 2', nonce: 2 }} autoDraft={false} onAutoDraftChange={vi.fn()} />);
    expect(await screen.findByText('Press 2 is running again; no work order needed.')).toBeInTheDocument();
  });
});

describe('MachinesNow draft button', () => {
  it('asks for a work order on a stopped machine', async () => {
    vi.mocked(apiModule.fetchMachines).mockResolvedValue([
      { id: 'm1', name: 'Press 2', state: 'stopped', last_alarm: 'E-221', source: 'VIRTUAL', last_seen_at: new Date().toISOString() },
    ] as unknown as apiModule.Machine[]);
    const onDraft = vi.fn();
    render(<MachinesNow onDraft={onDraft} />);
    fireEvent.click(await screen.findByText('Draft work order'));
    expect(onDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
  });
});
