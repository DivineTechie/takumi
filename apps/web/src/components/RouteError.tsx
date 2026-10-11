import React, { useEffect } from 'react';
import { useRouteError } from 'react-router-dom';
import { isChunkLoadError } from '../lib/chunkErrors';
import { useI18n } from '../i18n';

/**
 * Route error screen. After a new deploy, an open tab may ask for a page-code file that no longer
 * exists ("Failed to fetch dynamically imported module"); then we reload once to pick up the new
 * version. Any other error gets a plain message instead of a developer stack trace.
 */

const RELOAD_KEY = 'takumi.chunkReloadAt';


function reloadedRecently(): boolean {
  try {
    const at = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    return Date.now() - at < 30_000;
  } catch {
    return false;
  }
}

export const RouteError: React.FC = () => {
  const error = useRouteError();
  const chunk = isChunkLoadError(error);
  const { t } = useI18n();

  useEffect(() => {
    if (chunk && !reloadedRecently()) {
      try {
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      } catch {
        // reload anyway
      }
      window.location.reload();
    }
  }, [chunk]);

  return (
    <div className="min-h-screen bg-surface text-on-surface flex items-center justify-center p-6">
      <div className="max-w-sm text-center space-y-4">
        <h1 className="text-xl font-bold">{chunk ? t('app.route_error_updated_title') : t('app.route_error_title')}</h1>
        <p className="text-on-surface-variant">
          {chunk ? t('app.route_error_updated_desc') : t('app.route_error_desc')}
        </p>
        <div className="flex flex-wrap gap-2 justify-center">
          <button type="button" onClick={() => window.location.reload()} className="min-h-[48px] px-5 rounded-xl bg-primary text-on-primary font-bold">
            {t('app.route_error_reload')}
          </button>
          <a href="/" className="min-h-[48px] px-5 rounded-xl bg-surface-container-high font-bold flex items-center">
            {t('app.route_error_home')}
          </a>
        </div>
      </div>
    </div>
  );
};
