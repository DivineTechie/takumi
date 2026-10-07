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
    element: <div data-testid="test-feature-content">Member B Custom Feature</div>,
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
      updateDisplayName: vi.fn(),
    });

    const routes = buildRouteObjects([testFeatureRoute]);
    const router = createMemoryRouter(routes, {
      initialEntries: ['/test-feature'],
    });

    render(<RouterProvider router={router} />);

    // Trainee should be redirected away from /test-feature to Home ('/')
    expect(await screen.findByText('What would you like to do?')).toBeInTheDocument();
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
      updateDisplayName: vi.fn(),
    });

    const routes = buildRouteObjects([testFeatureRoute]);
    const router = createMemoryRouter(routes, {
      initialEntries: ['/test-feature'],
    });

    render(<RouterProvider router={router} />);

    // Master should see the feature content
    const content = await screen.findByTestId('test-feature-content');
    expect(content).toBeInTheDocument();
    expect(content.textContent).toBe('Member B Custom Feature');
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
      updateDisplayName: vi.fn(),
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

  it('allows master role to access /coach for lesson preview', async () => {
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
      updateDisplayName: vi.fn(),
    });

    const routes = buildRouteObjects([]);
    const router = createMemoryRouter(routes, {
      initialEntries: ['/coach'],
    });

    render(<RouterProvider router={router} />);

    // Master should see the lesson selection screen (Choose a lesson)
    expect(await screen.findByText('Choose a lesson')).toBeInTheDocument();
  });

  it('shows "This part of TAKUMI is still being finished" on 404 for known feature paths', async () => {
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
      updateDisplayName: vi.fn(),
    });

    // Without featureRoutes mounted, /capture falls through to 404
    const routes = buildRouteObjects([]);
    const router = createMemoryRouter(routes, {
      initialEntries: ['/capture'],
    });

    render(<RouterProvider router={router} />);

    expect(await screen.findByText('This part of TAKUMI is still being finished')).toBeInTheDocument();
  });
});
