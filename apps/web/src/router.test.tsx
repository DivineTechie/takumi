import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { User } from 'firebase/auth';
import { buildRouteObjects } from './router';
import type { FeatureRoute } from './features/routes';
import * as authModule from './lib/auth';

describe('Router & Feature Routes behind RoleGuard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const testFeatureRoute: FeatureRoute = {
    path: '/test-feature',
    roles: ['master'],
    element: <div data-testid="test-feature-content">Studio test screen</div>,
  };

  it('mounts entries from features/routes.tsx and protects them with RoleGuard for unauthorized role', async () => {
    // Mock useAuth as trainee (not allowed for 'master')
    vi.spyOn(authModule, 'useAuth').mockReturnValue({
      user: { uid: 'trainee_user', email: 'trainee@example.com' } as unknown as User,
      role: 'trainee',
      loading: false,
      signInWithGoogle: vi.fn(),
      signInWithPassword: vi.fn(),
      sendSignInLink: vi.fn(),
      finishSignInWithEmail: vi.fn(),
      signOut: vi.fn(),
      refreshRole: vi.fn(),
      signInAsGuest: vi.fn(),
      canPickRole: false,
      pickRole: vi.fn(),
    });

    const routes = buildRouteObjects([testFeatureRoute]);
    const router = createMemoryRouter(routes, {
      initialEntries: ['/test-feature'],
    });

    render(<RouterProvider router={router} />);

    // Trainee should be redirected away from /test-feature to Home ('/')
    expect(
      await screen.findByText('What would you like to do?', {}, { timeout: 4000 })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('test-feature-content')).toBeNull();
  });

  it('renders feature route when user has the authorized role', async () => {
    // Mock useAuth as master (allowed)
    vi.spyOn(authModule, 'useAuth').mockReturnValue({
      user: { uid: 'master_user', email: 'master@example.com' } as unknown as User,
      role: 'master',
      loading: false,
      signInWithGoogle: vi.fn(),
      signInWithPassword: vi.fn(),
      sendSignInLink: vi.fn(),
      finishSignInWithEmail: vi.fn(),
      signOut: vi.fn(),
      refreshRole: vi.fn(),
      signInAsGuest: vi.fn(),
      canPickRole: false,
      pickRole: vi.fn(),
    });

    const routes = buildRouteObjects([testFeatureRoute]);
    const router = createMemoryRouter(routes, {
      initialEntries: ['/test-feature'],
    });

    render(<RouterProvider router={router} />);

    // Master should see the feature content
    const content = await screen.findByTestId('test-feature-content');
    expect(content).toBeInTheDocument();
    expect(content.textContent).toBe('Studio test screen');
  });

  it('redirects unauthenticated user to /signin when accessing feature route', async () => {
    // Mock useAuth as signed out
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
      signInAsGuest: vi.fn(),
      canPickRole: false,
      pickRole: vi.fn(),
    });

    const routes = buildRouteObjects([testFeatureRoute]);
    const router = createMemoryRouter(routes, {
      initialEntries: ['/test-feature'],
    });

    render(<RouterProvider router={router} />);

    // Unauthenticated user should be redirected to /signin
    expect(await screen.findByText('Sign in with Google')).toBeInTheDocument();
    expect(screen.queryByTestId('test-feature-content')).toBeNull();
  });

  it('allows master role to open Station Watch at /coach', async () => {
    vi.spyOn(authModule, 'useAuth').mockReturnValue({
      user: { uid: 'master_user', email: 'master@example.com' } as unknown as User,
      role: 'master',
      loading: false,
      signInWithGoogle: vi.fn(),
      signInWithPassword: vi.fn(),
      sendSignInLink: vi.fn(),
      finishSignInWithEmail: vi.fn(),
      signOut: vi.fn(),
      refreshRole: vi.fn(),
      signInAsGuest: vi.fn(),
      canPickRole: false,
      pickRole: vi.fn(),
    });

    const routes = buildRouteObjects([]);
    const router = createMemoryRouter(routes, {
      initialEntries: ['/coach'],
    });

    render(<RouterProvider router={router} />);

    // Master sees the work instruction picker (lazy-loaded, so allow time under a parallel test run)
    expect(await screen.findByText('Choose a work instruction', {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it('shows the not-found page for a path that is not mounted', async () => {
    vi.spyOn(authModule, 'useAuth').mockReturnValue({
      user: { uid: 'master_user', email: 'master@example.com' } as unknown as User,
      role: 'master',
      loading: false,
      signInWithGoogle: vi.fn(),
      signInWithPassword: vi.fn(),
      sendSignInLink: vi.fn(),
      finishSignInWithEmail: vi.fn(),
      signOut: vi.fn(),
      refreshRole: vi.fn(),
      signInAsGuest: vi.fn(),
      canPickRole: false,
      pickRole: vi.fn(),
    });

    // Without the Studio routes mounted, /capture falls through to the not-found page
    const routes = buildRouteObjects([]);
    const router = createMemoryRouter(routes, {
      initialEntries: ['/capture'],
    });

    render(<RouterProvider router={router} />);

    expect(await screen.findByText('404 - Page Not Found')).toBeInTheDocument();
  });
});
