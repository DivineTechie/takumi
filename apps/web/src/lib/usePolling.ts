import { useEffect } from 'react';

/**
 * Runs `load` now and every `intervalMs`, but only while the tab is visible: a control tower left open
 * in a background tab costs nothing. Coming back to the tab refreshes at once.
 */
export function usePolling(load: () => unknown, intervalMs: number): void {
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, intervalMs]);
}
