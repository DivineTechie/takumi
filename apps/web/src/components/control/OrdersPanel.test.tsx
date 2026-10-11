import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OrdersPanel } from './OrdersPanel';
import * as apiModule from '../../lib/api';

vi.mock('../../lib/api', () => ({
  fetchOrders: vi.fn(),
  fetchMachines: vi.fn(),
  createOrder: vi.fn(),
  closeOrder: vi.fn(),
  runDemandAgent: vi.fn(),
  ApiError: class extends Error {},
}));

const order: apiModule.OrderStatus = {
  order_id: 'o1', name: 'Customer A', quantity: 900, due_at: new Date(Date.now() + 2 * 3600_000).toISOString(), made: 380,
  rate_per_hour: 0, first_pass_rate: null, source: 'HOME RIG', hours_left: 2, good_made: 380, projected_good: 380, shortfall: 520,
  on_track: false, rate_needed_per_hour: 260,
  machines: [{ machine_id: 'm1', name: 'Press 2', state: 'stopped', last_alarm: 'E-221 COOLANT LOW', made: 380, rate_per_hour: 0, ideal_rate_per_hour: 450 }],
};

describe('OrdersPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiModule.fetchOrders).mockResolvedValue([order]);
    vi.mocked(apiModule.fetchMachines).mockResolvedValue([]);
  });

  it('shows the projection with its source label and runs the planner', async () => {
    vi.mocked(apiModule.runDemandAgent).mockResolvedValue({
      report: {
        summary: 'Customer A is short because Press 2 is stopped.',
        orders: [{ order_id: 'o1', verdict: 'At risk.', main_constraint: 'Press 2 coolant alarm' }],
        actions: [{ action: 'Refill coolant on Press 2.', reason: 'Restarts output.', expected_extra_units: null }],
        confidence: 'high',
      },
      orders: [order],
      agent_steps: [{ agent: 'planner', tool: 'list_open_orders', args: {} }],
    });
    render(<OrdersPanel />);
    expect(await screen.findByText('Short by 520')).toBeInTheDocument();
    expect(screen.getByText('HOME RIG')).toBeInTheDocument();
    expect(screen.getByText(/needs 260\/h/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Will we make it?'));
    expect(await screen.findByText('Customer A is short because Press 2 is stopped.')).toBeInTheDocument();
    expect(screen.getByText('Refill coolant on Press 2.')).toBeInTheDocument();
    expect(screen.getByText(/planner → list_open_orders/)).toBeInTheDocument();
  });
});
