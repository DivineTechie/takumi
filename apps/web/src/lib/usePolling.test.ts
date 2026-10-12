import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePolling } from './usePolling';

const setVisibility = (state: DocumentVisibilityState) =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });

describe('usePolling', () => {
  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('loads at once, on each tick while visible, skips hidden ticks and refreshes on return', () => {
    vi.useFakeTimers();
    setVisibility('visible');
    const load = vi.fn();
    const { unmount } = renderHook(() => usePolling(load, 1000));
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(load).toHaveBeenCalledTimes(2);

    setVisibility('hidden');
    vi.advanceTimersByTime(3000);
    expect(load).toHaveBeenCalledTimes(2);

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(load).toHaveBeenCalledTimes(3);

    unmount();
    vi.advanceTimersByTime(5000);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
