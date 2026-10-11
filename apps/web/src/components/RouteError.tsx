import React, { useEffect } from 'react';
import { useRouteError } from 'react-router-dom';
import { isChunkLoadError } from '../lib/chunkErrors';

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
        <h1 className="text-xl font-bold">{chunk ? 'TAKUMI was updated' : 'Something went wrong'}</h1>
        <p className="text-on-surface-variant">
          {chunk ? 'Loading the new version…' : 'This page hit an error. Reloading usually fixes it.'}
        </p>
        <div className="flex gap-2 justify-center">
          <button type="button" onClick={() => window.location.reload()} className="min-h-[48px] px-5 rounded-xl bg-primary text-on-primary font-bold">
            Reload
          </button>
          <a href="/" className="min-h-[48px] px-5 rounded-xl bg-surface-container-high font-bold flex items-center">
            Home
          </a>
        </div>
      </div>
    </div>
  );
};
