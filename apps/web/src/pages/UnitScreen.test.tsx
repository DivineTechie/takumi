import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { UnitScreen } from './UnitScreen';
import * as apiModule from '../lib/api';
import * as authModule from '../lib/auth';

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { ApiError, fetchUnitHistory: vi.fn(), holdUnits: vi.fn(), releaseUnit: vi.fn(), runTraceback: vi.fn(), createReviewRequest: vi.fn() };
});
vi.mock('../lib/auth', () => ({ useAuth: vi.fn() }));

const history: apiModule.UnitHistory = {
  id: 'SN-0042',
  product_id: 'cable_kit',
  status: 'failed',
  created_at: '2026-10-10T08:00:00+00:00',
  holds: [],
  station_records: [
    {
      session_id: 'ses_1',
      skill_id: 'skill_cable',
      station: 'Cable and adapter assembly',
      status: 'completed',
      started_at: null,
      ended_at: '2026-10-10T08:05:00+00:00',
      steps_total: 3,
      steps_done: 3,
      incomplete_steps: [],
      mistakes: 1,
      safety_stops: 0,
      issues: [{ step: 2, step_title: 'Fit the adapter', type: 'mistake', reason: 'adapter upside down', t: null, frame_url: 'https://example.test/f.jpg' }],
    },
  ],
  inspections: [
    { id: 'i1', created_at: null, ai_verdict: 'defective', defect: 'adapter reversed', where: 'cable end', human_decision: 'confirmed_defect', mode: 'few_false_alarms', source: 'LIVE', image_url: null },
  ],
};

function renderAt(role: string) {
  vi.mocked(authModule.useAuth).mockReturnValue({ role } as unknown as ReturnType<typeof authModule.useAuth>);
  return render(
    <MemoryRouter initialEntries={['/units/SN-0042']}>
      <Routes>
        <Route path="/units/:unitId" element={<UnitScreen />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('UnitScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiModule.fetchUnitHistory).mockResolvedValue(history);
  });

  it('shows stations with evidence and inspections; trace-back is supervisor only', async () => {
    renderAt('trainee');
    expect(await screen.findByText('Cable and adapter assembly')).toBeInTheDocument();
    expect(screen.getByText('adapter upside down')).toBeInTheDocument();
    expect(screen.getByAltText('Evidence for step 2')).toBeInTheDocument();
    expect(screen.getByText('Defect: adapter reversed')).toBeInTheDocument();
    expect(screen.queryByText('Trace back')).not.toBeInTheDocument();
  });

  it('runs the agent, shows its steps and holds only the approved units', async () => {
    vi.mocked(apiModule.runTraceback).mockResolvedValue({
      unit_id: 'SN-0042',
      report: {
        summary: 'Step 2 adapter orientation.',
        root_cause_station: 'Cable and adapter assembly',
        root_cause_skill_id: 'skill_cable',
        root_cause_step: 2,
        evidence: ['Mistake logged at step 2'],
        confidence: 'high',
        hold_unit_ids: ['SN-0043', 'SN-0044'],
        hold_reason: 'Same step 2 issue',
        work_instruction_fix: 'Add an orientation mark.',
      },
      agent_steps: [{ agent: 'investigator', tool: 'get_unit_history', args: { unit_id: 'SN-0042' } }],
    });
    vi.mocked(apiModule.holdUnits).mockResolvedValue({ held: ['SN-0043'], skipped: [] });

    renderAt('supervisor');
    fireEvent.click(await screen.findByText('Trace back'));
    expect(await screen.findByTestId('traceback-report')).toBeInTheDocument();
    expect(screen.getByText(/investigator → get_unit_history\(SN-0042\)/)).toBeInTheDocument();
    expect(screen.getByText('Add an orientation mark.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'SN-0044' }));
    fireEvent.click(screen.getByText('Approve: hold 1 unit(s)'));
    await waitFor(() => expect(apiModule.holdUnits).toHaveBeenCalledWith(['SN-0043'], 'Same step 2 issue', 'traceback'));

    vi.mocked(apiModule.createReviewRequest).mockResolvedValue({ id: 'rr_1' });
    fireEvent.click(screen.getByText('Send to the Standard Work Studio (step 2)'));
    await waitFor(() =>
      expect(apiModule.createReviewRequest).toHaveBeenCalledWith(
        expect.objectContaining({ skill_id: 'skill_cable', step: 2, suggested_instruction: 'Add an orientation mark.', source: 'traceback', unit_id: 'SN-0042' })
      )
    );
    expect(await screen.findByText('Sent to the Standard Work Studio')).toBeInTheDocument();
  });
});
