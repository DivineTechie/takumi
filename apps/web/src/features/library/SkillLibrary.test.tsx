import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SkillLibrary } from './SkillLibrary';
import { store, resetStore } from '../../test/firestoreStore';

vi.mock('firebase/firestore', async () => (await import('../../test/firestoreStore')).firestoreMock);
vi.mock('../../lib/firebase', () => ({ db: {} }));
vi.mock('../../i18n', () => {
  const t = (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key);
  return { useI18n: () => ({ t, language: 'en', setLanguage: vi.fn() }) };
});

const renderLibrary = () => render(<MemoryRouter><SkillLibrary /></MemoryRouter>);

describe('SkillLibrary', () => {
  beforeEach(() => resetStore());

  it('shows an empty library instead of a sample lesson', () => {
    store.collections['skills'] = [];
    renderLibrary();
    expect(screen.getByText('app.library_empty_title')).toBeInTheDocument();
    expect(screen.queryByText(/DIN-rail/)).not.toBeInTheDocument();
  });

  it('shows an error when lessons cannot be read', () => {
    store.fail.add('skills');
    renderLibrary();
    expect(screen.getByRole('alert')).toHaveTextContent('app.route_error_title');
  });

  it('lists the stored lessons', () => {
    store.collections['skills'] = [{
      id: 'skill_1', title: 'Wire a terminal block', status: 'in_review', languages: ['en', 'vi'],
      master: { display_name: 'Master Craftsman', role: 'Senior Technician' }, steps: [{ n: 1 }], created_at: '2026-10-12T10:00:00Z',
    }];
    renderLibrary();
    expect(screen.getByText('Wire a terminal block')).toBeInTheDocument();
    expect(screen.queryByText('app.library_empty_title')).not.toBeInTheDocument();
  });

  it('hides archived instructions', () => {
    store.collections['skills'] = [{
      id: 'skill_old', title: 'Withdrawn draft', status: 'archived', languages: ['en'],
      master: { display_name: 'Master Craftsman', role: 'Senior Technician' }, steps: [{ n: 1 }], created_at: '2026-10-07T10:00:00Z',
    }];
    renderLibrary();
    expect(screen.queryByText('Withdrawn draft')).not.toBeInTheDocument();
  });
});
