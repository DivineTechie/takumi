import React, { useEffect, useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '../i18n';

interface VersionInfo {
  version: string;
  commit: string;
  builtAt: string;
}

export const VersionBanner: React.FC = () => {
  const location = useLocation();
  const { t } = useI18n();
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const currentCommitRef = useRef<string | null>(null);

  // Suppress update banner during active coaching to avoid interrupting worker hands-on flow
  const isCoachingActive = location.pathname.startsWith('/coach/') && location.pathname !== '/coach';

  useEffect(() => {
    let isMounted = true;

    async function checkVersion() {
      try {
        const res = await fetch(`/version.json?_t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data: VersionInfo = await res.json();
        if (!isMounted) return;

        if (!currentCommitRef.current) {
          // First load sets current baseline
          currentCommitRef.current = data.commit;
        } else if (data.commit && data.commit !== currentCommitRef.current) {
          // Server has newer commit
          setUpdateAvailable(true);
        }
      } catch {
        // Ignore network blips during polling
      }
    }

    // Initial check
    checkVersion();

    // Poll every 5 minutes
    const interval = setInterval(checkVersion, 5 * 60 * 1000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  if (!updateAvailable || dismissed || isCoachingActive) {
    return null;
  }

  return (
    <aside
      role="status"
      aria-live="polite"
      data-testid="version-banner"
      className="bg-primary text-on-primary py-2.5 px-4 text-sm font-medium flex items-center justify-between shadow-md relative z-50 animate-in fade-in slide-in-from-top-2 duration-300"
    >
      <div className="flex flex-wrap items-center gap-2 mx-auto min-w-0">
        <span className="material-symbols-outlined text-base" aria-hidden="true">
          system_update
        </span>
        <span className="min-w-0">{t('app.version_banner_available')}</span>
        <button
          onClick={() => window.location.reload()}
          className="ml-2 px-3 py-1 bg-white text-primary text-xs font-semibold rounded-full shadow-sm hover:bg-neutral-100 transition-colors focus:outline-none focus:ring-2 focus:ring-white"
        >
          {t('app.version_banner_refresh')}
        </button>
      </div>
      <button
        onClick={() => setDismissed(true)}
        aria-label={t('app.version_banner_dismiss')}
        className="p-1 rounded hover:bg-white/10 transition-colors text-white/80 hover:text-white"
      >
        <span className="material-symbols-outlined text-base">close</span>
      </button>
    </aside>
  );
};
