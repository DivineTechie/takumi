import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App.tsx';
import * as authModule from './lib/auth';

describe('App', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders application shell and redirects unauthenticated user to SignIn', async () => {
    vi.spyOn(authModule, 'useAuth').mockReturnValue({
      user: null,
      role: null,
      loading: false,
      signInWithGoogle: vi.fn(),
      signInWithPassword: vi.fn(),
      sendSignInLink: vi.fn(),
      finishSignInWithEmail: vi.fn(),
      signOut: vi.fn(),
      refreshRole: vi.fn(),
      updateDisplayName: vi.fn(),
    });

    render(<App />);
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('TAKUMI');
    expect(await screen.findByText('Sign in with Google')).toBeInTheDocument();
  });
});
