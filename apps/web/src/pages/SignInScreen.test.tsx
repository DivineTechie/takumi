import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SignInScreen } from './SignInScreen';
import * as authModule from '../lib/auth';

vi.mock('../lib/auth', () => ({
  useAuth: vi.fn(),
  signInWithGoogleAction: vi.fn(),
  sendEmailSignInLink: vi.fn(),
  signInWithPasswordAction: vi.fn(),
}));

describe('SignInScreen Test Account Integration', () => {
  const mockSignInWithGoogle = vi.fn();
  const mockSendSignInLink = vi.fn();
  const mockSignInWithPassword = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authModule.useAuth).mockReturnValue({
      user: null,
      role: null,
      loading: false,
      signInWithGoogle: mockSignInWithGoogle,
      signInWithPassword: mockSignInWithPassword,
      sendSignInLink: mockSendSignInLink,
      finishSignInWithEmail: vi.fn(),
      signOut: vi.fn(),
      refreshRole: vi.fn(),
      updateDisplayName: vi.fn(),
    });
  });

  it('renders Google sign-in button and test account toggle', () => {
    render(
      <MemoryRouter>
        <SignInScreen />
      </MemoryRouter>
    );

    expect(screen.getByText(/Sign in with Google/i)).toBeDefined();
    expect(screen.getByText(/Use a test account/i)).toBeDefined();
    expect(screen.queryByPlaceholderText('judge-trainee@takumi-cup-2026.web.app')).toBeNull();
  });

  it('toggles test account form when clicking "Use a test account"', () => {
    render(
      <MemoryRouter>
        <SignInScreen />
      </MemoryRouter>
    );

    const toggleButton = screen.getByText(/Use a test account/i);
    fireEvent.click(toggleButton);

    expect(screen.getByPlaceholderText('judge-trainee@takumi-cup-2026.web.app')).toBeDefined();
    expect(screen.getByPlaceholderText('Password')).toBeDefined();
    expect(screen.getByText('Sign in with test account')).toBeDefined();

    // Toggle off
    fireEvent.click(toggleButton);
    expect(screen.queryByPlaceholderText('judge-trainee@takumi-cup-2026.web.app')).toBeNull();
  });

  it('submits test account credentials via signInWithPassword', async () => {
    mockSignInWithPassword.mockResolvedValueOnce(undefined);

    render(
      <MemoryRouter>
        <SignInScreen />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText(/Use a test account/i));

    const emailInput = screen.getByPlaceholderText('judge-trainee@takumi-cup-2026.web.app');
    const passwordInput = screen.getByPlaceholderText('Password');
    const submitBtn = screen.getByText('Sign in with test account');

    fireEvent.change(emailInput, { target: { value: 'judge-trainee@takumi-cup-2026.web.app' } });
    fireEvent.change(passwordInput, { target: { value: 'secretPassword123' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockSignInWithPassword).toHaveBeenCalledWith(
        'judge-trainee@takumi-cup-2026.web.app',
        'secretPassword123'
      );
    });
  });

  it('displays error message when signInWithPassword fails', async () => {
    mockSignInWithPassword.mockRejectedValueOnce(new Error('auth/invalid-credential'));

    render(
      <MemoryRouter>
        <SignInScreen />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText(/Use a test account/i));

    fireEvent.change(screen.getByPlaceholderText('judge-trainee@takumi-cup-2026.web.app'), {
      target: { value: 'bad@takumi-cup-2026.web.app' },
    });
    fireEvent.change(screen.getByPlaceholderText('Password'), {
      target: { value: 'wrongpass' },
    });
    fireEvent.click(screen.getByText('Sign in with test account'));

    await waitFor(() => {
      expect(screen.getByText('auth/invalid-credential')).toBeDefined();
    });
  });
});
