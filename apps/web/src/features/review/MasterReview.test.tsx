import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MasterReview } from './MasterReview';
import * as apiModule from '../../lib/api';
import { store, resetStore } from '../../test/firestoreStore';

vi.mock('firebase/firestore', async () => (await import('../../test/firestoreStore')).firestoreMock);
vi.mock('../../lib/firebase', () => ({ db: {} }));
vi.mock('../../lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { ApiError, regenerateStepPart: vi.fn() };
});
// Like the real i18n for a key that is not translated yet: the key comes back unchanged.
vi.mock('../../i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t, language: 'en', setLanguage: vi.fn() }) };
});

function renderSkill(skillId = 'skill_1') {
  return render(
    <MemoryRouter initialEntries={[`/review/${skillId}`]}>
      <Routes>
        <Route path="/review/:skillId" element={<MasterReview />} />
      </Routes>
    </MemoryRouter>
  );
}

const lesson = {
  id: 'skill_1',
  title: 'Wire a terminal block',
  capture_id: 'cap_1',
  source_language: 'ja',
  languages: ['en', 'vi'],
  status: 'in_review',
  master: { display_name: 'Master Craftsman', role: 'Senior Technician' },
  video_uri: 'gs://bucket/captures/cap_1/master.mp4',
  safety_rules: ['Panel power switch is in the OFF position'],
  steps: [
    {
      n: 1,
      title: 'Seat the wire',
      instruction: 'Insert the blue wire.',
      success_criteria: 'The wire is seated properly.',
      why: 'Left is neutral.',
      tools: [],
      hazards: [],
      common_mistakes: [],
      verifier: { conflict: true, detail: "'properly' is subjective.", suggestion: 'The blue ferrule is inside the left terminal.' },
      translations: { vi: { instruction: 'Cắm dây xanh.', why: 'Trái là trung tính.' } },
    },
  ],
  created_at: '2026-10-12T10:00:00Z',
  published_at: null,
};

describe('MasterReview', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it('says the lesson was not found instead of showing a sample lesson', async () => {
    renderSkill('skill_missing');
    expect(await screen.findByText('This lesson could not be found.')).toBeInTheDocument();
    expect(screen.queryByText(/DIN-rail|terminal 1/)).not.toBeInTheDocument();
  });

  it('shows an error when the lesson cannot be read', async () => {
    store.fail.add('skills/skill_1');
    renderSkill();
    expect(await screen.findByText('app.route_error_title')).toBeInTheDocument();
  });

  it('shows the verifier flag and applies a regenerated instruction with its translation', async () => {
    store.docs['skills/skill_1'] = lesson;
    vi.mocked(apiModule.regenerateStepPart).mockResolvedValue({
      skill_id: 'skill_1', n: 1, part: 'instruction',
      text: 'Insert the blue wire into the left terminal.', translations: { vi: 'Cắm dây xanh vào cổng trái.' },
    });
    renderSkill();

    const flag = await screen.findByTestId('verifier-flag');
    expect(flag).toHaveTextContent("'properly' is subjective.");
    expect(flag).toHaveTextContent('The blue ferrule is inside the left terminal.');

    fireEvent.click(screen.getByLabelText('app.review_regenerate'));
    await waitFor(() => expect(screen.getByDisplayValue('Insert the blue wire into the left terminal.')).toBeInTheDocument());
    expect(apiModule.regenerateStepPart).toHaveBeenCalledWith('skill_1', 1, 'instruction');

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'vi' } });
    expect(screen.getByDisplayValue('Cắm dây xanh vào cổng trái.')).toBeInTheDocument();
  });

  it('reports a failed regenerate and keeps the text', async () => {
    store.docs['skills/skill_1'] = lesson;
    vi.mocked(apiModule.regenerateStepPart).mockRejectedValue(new apiModule.ApiError('Could not regenerate the step', 502));
    renderSkill();

    fireEvent.click(await screen.findByLabelText('app.review_regenerate'));
    expect(await screen.findByText('Could not regenerate step 1. Please try again.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Insert the blue wire.')).toBeInTheDocument();
  });
});
