import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AgentTrace } from './AgentTrace';
import { store, resetStore } from '../../test/firestoreStore';

vi.mock('firebase/firestore', async () => (await import('../../test/firestoreStore')).firestoreMock);
vi.mock('../../lib/firebase', () => ({ db: {} }));
vi.mock('./mediaStorage', () => ({ getVideoObjectUrl: vi.fn().mockResolvedValue(null) }));
vi.mock('../../i18n', () => {
  const t = (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key);
  return { useI18n: () => ({ t, language: 'en', setLanguage: vi.fn() }) };
});

function renderJob(jobId = 'job_1') {
  return render(
    <MemoryRouter initialEntries={[`/forge/${jobId}`]}>
      <Routes>
        <Route path="/forge/:jobId" element={<AgentTrace />} />
        <Route path="/review/:skillId" element={<div>review page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const event = (id: string, agent: string, message: string, extra: Record<string, unknown> = {}) => ({
  id, agent, message, level: 'info', t: `2026-10-12T10:00:0${id}Z`, ...extra,
});

describe('AgentTrace', () => {
  beforeEach(() => resetStore());

  it('shows only what the Studio job reported and the lesson it saved', () => {
    store.docs['forge_jobs/job_1'] = { capture_id: 'cap_1', skill_id: 'skill_1', status: 'done' };
    store.collections['forge_jobs/job_1/events'] = [
      event('1', 'segmenter', 'gemini-3.8-flash found 2 steps in the 40 s video', { ms: 51000 }),
      event('2', 'spatial', 'Step 2: no pointer (Robotics-ER did not find the target in the frame)', { level: 'warn' }),
      event('3', 'spatial', 'gemini-robotics-er-2-preview pointed at the part in 1 of 2 steps', { ms: 4000 }),
      event('4', 'publisher', 'Saved 2 steps in 6 languages for the master\'s review', { ms: 300 }),
    ];
    store.docs['skills/skill_1'] = {
      languages: ['en', 'vi'],
      steps: [
        { n: 1, title: 'Seat the wire', instruction: 'Insert the blue wire into the left terminal.', why: 'Left is neutral.',
          clip: { start_s: 1, end_s: 20 }, point_hint: 'the left terminal screw',
          translations: { vi: { title: 'Lắp dây', instruction: 'Cắm dây xanh vào cổng trái.', why: 'Trái là trung tính.' } } },
        { n: 2, instruction: 'Pull each wire lightly.', why: '', clip: { start_s: 20, end_s: 40 } },
      ],
    };
    renderJob();

    expect(screen.getByText('gemini-3.8-flash found 2 steps in the 40 s video')).toBeInTheDocument();
    expect(screen.getByText(/Step 2: no pointer/)).toBeInTheDocument();
    expect(screen.getByText('Insert the blue wire into the left terminal.')).toBeInTheDocument();
    expect(screen.getAllByText('Seat the wire').length).toBeGreaterThan(0);
    expect(screen.queryByText(/trace_fast_forward/)).not.toBeInTheDocument();
    expect(screen.queryByText(/terminal 1|IEC|jam nut|solder/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'vi' } });
    expect(screen.getByText('Cắm dây xanh vào cổng trái.')).toBeInTheDocument();

    fireEvent.click(screen.getByText('app.trace_review_lesson'));
    expect(screen.getByText('review page')).toBeInTheDocument();
  });

  it('shows the failure and the reason the run stopped, with no lesson and no review button', () => {
    store.docs['forge_jobs/job_1'] = { capture_id: 'cap_1', skill_id: 'skill_1', status: 'failed' };
    store.collections['forge_jobs/job_1/events'] = [
      event('1', 'segmenter', 'Sending the master\'s video to gemini-3.8-flash'),
      event('2', 'segmenter', 'Stopped: The capture video was not found in Cloud Storage', { level: 'error', ms: 900 }),
    ];
    store.docs['skills/skill_1'] = { steps: [] };
    renderJob();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The Studio could not finish this recording.');
    expect(alert).toHaveTextContent('Stopped: The capture video was not found in Cloud Storage');
    expect(screen.queryByText('app.trace_review_lesson')).not.toBeInTheDocument();
    expect(screen.queryByText(/app.trace_step_badge/)).not.toBeInTheDocument();
  });

  it('invents nothing while the job has not reported yet', () => {
    store.docs['forge_jobs/job_1'] = { capture_id: 'cap_1', skill_id: 'skill_1', status: 'queued' };
    store.collections['forge_jobs/job_1/events'] = [];
    store.docs['skills/skill_1'] = { steps: [] };
    renderJob();

    expect(screen.getByText('app.trace_assembling')).toBeInTheDocument();
    expect(screen.getAllByText('app.trace_queued')).toHaveLength(5);
    expect(screen.queryByText(/app.trace_step_badge/)).not.toBeInTheDocument();
  });
});
