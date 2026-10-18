import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HomeScreen } from './HomeScreen';
import * as authModule from '../lib/auth';

vi.mock('../lib/auth', () => ({ useAuth: vi.fn() }));

function mockAuth(over: Partial<authModule.AuthContextType>) {
  vi.mocked(authModule.useAuth).mockReturnValue({
    user: { email: 'judge@example.com', displayName: 'Judge' } as authModule.AuthContextType['user'],
    role: 'trainee',
    loading: false,
    signInWithGoogle: vi.fn(),
    signInWithPassword: vi.fn(),
    sendSignInLink: vi.fn(),
    finishSignInWithEmail: vi.fn(),
    signOut: vi.fn(),
    refreshRole: vi.fn(),
    canPickRole: false,
    pickRole: vi.fn(),
    ...over,
  });
}

const renderHome = () =>
  render(
    <MemoryRouter>
      <HomeScreen />
    </MemoryRouter>
  );

describe('HomeScreen demo role picker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lets a personal account switch to supervisor', async () => {
    const pickRole = vi.fn().mockResolvedValue(undefined);
    mockAuth({ canPickRole: true, pickRole });
    renderHome();
    expect(screen.getByRole('radio', { name: /Operator/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: /Supervisor/ }));
    await waitFor(() => expect(pickRole).toHaveBeenCalledWith('supervisor'));
  });

  it('is hidden for the shared test accounts', () => {
    mockAuth({ canPickRole: false, role: 'supervisor' });
    renderHome();
    expect(screen.queryByText('Try every role')).not.toBeInTheDocument();
  });
});
