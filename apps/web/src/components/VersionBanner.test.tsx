import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { VersionBanner } from './VersionBanner';

describe('VersionBanner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not display banner when version is unchanged', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '1.0.0', commit: 'abc1234', builtAt: '2026-10-06T12:00:00Z' }),
    } as Response);

    render(
      <MemoryRouter initialEntries={['/']}>
        <VersionBanner />
      </MemoryRouter>
    );

    // Initial check establishes baseline commit
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId('version-banner')).toBeNull();
  });

  it('displays update banner when server reports newer commit', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          version: '1.0.0',
          commit: callCount === 1 ? 'abc1234' : 'def5678',
          builtAt: '2026-10-06T12:00:00Z',
        }),
      } as Response;
    });

    vi.useFakeTimers();

    render(
      <MemoryRouter initialEntries={['/']}>
        <VersionBanner />
      </MemoryRouter>
    );

    // First check (initial commit)
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('version-banner')).toBeNull();

    // Advance 5 minutes for next poll
    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve();
    });

    // Should now show update banner
    expect(screen.getByTestId('version-banner')).toBeInTheDocument();
    expect(screen.getByText('A new version of TAKUMI is available.')).toBeInTheDocument();
  });

  it('suppresses update banner during active coaching (/coach/:skillId)', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          version: '1.0.0',
          commit: callCount === 1 ? 'abc1234' : 'def5678',
          builtAt: '2026-10-06T12:00:00Z',
        }),
      } as Response;
    });

    vi.useFakeTimers();

    render(
      <MemoryRouter initialEntries={['/coach/wire-harness-1']}>
        <VersionBanner />
      </MemoryRouter>
    );

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve();
    });

    // Suppressed during active hands-on coaching
    expect(screen.queryByTestId('version-banner')).toBeNull();
  });
});
