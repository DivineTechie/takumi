import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { fetchSystemStatus, type SystemStatusResponse } from '../lib/api';
import logoSvg from '../assets/logo.svg';
import { useI18n } from '../i18n';

export const StatusScreen: React.FC = () => {
  const { t, language } = useI18n();
  const [status, setStatus] = useState<SystemStatusResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());

  const loadStatus = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchSystemStatus();
      setStatus(data);
      setLastRefreshed(new Date());
    } catch (err: unknown) {
      console.error('Failed to load status:', err);
      setError(err instanceof Error ? err.message : 'app.status_load_failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    // Auto refresh every 60 seconds (matches server-side cache TTL)
    const interval = window.setInterval(() => {
      void loadStatus();
    }, 60000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  const hasLatencyData =
    status?.last_24h &&
    (status.last_24h.sessions > 0 ||
      status.last_24h.p50_ms.watch !== null ||
      status.last_24h.p50_ms.verify !== null ||
      status.last_24h.p50_ms.point !== null ||
      status.last_24h.p50_ms.decision_to_audio !== null);

  const isCoachingActive = status?.sessions_enabled ?? true;
  const isApiHealthy = status?.api === 'ok';

  return (
    <div className="min-h-screen bg-surface text-on-surface flex flex-col items-center px-4 py-8 md:py-12">
      <div className="w-full max-w-3xl flex flex-col gap-6">
        {/* Navigation & Header */}
        <header className="flex items-center justify-between border-b border-outline-variant pb-4">
          <Link to="/" className="flex items-center gap-3 group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg p-1">
            <img src={logoSvg} alt="TAKUMI" className="w-9 h-9 object-contain" />
            <div className="flex flex-col">
              <span className="font-headline-sm font-extrabold tracking-tight text-on-surface">
                TAKUMI
              </span>
              <span className="text-xs font-medium text-on-surface-variant">{t('app.status_title')}</span>
            </div>
          </Link>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                void loadStatus();
              }}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface border border-outline-variant transition-colors cursor-pointer disabled:opacity-50"
              title={t('app.status_refresh_title')}
            >
              <span className={`material-symbols-outlined text-[18px] ${loading ? 'animate-spin' : ''}`}>
                refresh
              </span>
              <span className="hidden sm:inline">{t('app.status_refresh')}</span>
            </button>
            <Link
              to="/coach"
              className="px-3.5 py-2 text-sm font-semibold rounded-lg bg-primary-container text-on-primary-container hover:brightness-105 transition-all shadow-sm"
            >
              {t('app.status_open_app')}
            </Link>
          </div>
        </header>

        {/* Overall Status Banner */}
        {loading && !status ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="w-8 h-8 border-3 border-primary-container border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-medium text-on-surface-variant">{t('app.status_checking')}</p>
          </div>
        ) : error && !status ? (
          <div className="p-5 rounded-2xl bg-error-container/20 border border-error/30 text-error flex items-start gap-3">
            <span className="material-symbols-outlined text-2xl shrink-0">error</span>
            <div className="flex flex-col gap-1">
              <span className="font-bold">{t('app.status_unavailable')}</span>
              <span className="text-sm opacity-90">{t(error)}</span>
            </div>
          </div>
        ) : (
          <>
            <div
              className={`p-6 rounded-2xl border flex items-center justify-between gap-4 transition-all ${
                isApiHealthy && isCoachingActive
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-950 dark:text-emerald-100'
                  : !isCoachingActive
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-950 dark:text-amber-100'
                  : 'bg-rose-500/10 border-rose-500/30 text-rose-950 dark:text-rose-100'
              }`}
            >
              <div className="flex items-center gap-4">
                <span
                  className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 text-white ${
                    isApiHealthy && isCoachingActive
                      ? 'bg-emerald-500 shadow-emerald-500/20 shadow-lg'
                      : !isCoachingActive
                      ? 'bg-amber-500 shadow-amber-500/20 shadow-lg'
                      : 'bg-rose-500 shadow-rose-500/20 shadow-lg'
                  }`}
                >
                  <span className="material-symbols-outlined text-2xl">
                    {isApiHealthy && isCoachingActive
                      ? 'check_circle'
                      : !isCoachingActive
                      ? 'construction'
                      : 'warning'}
                  </span>
                </span>
                <div className="flex flex-col">
                  <h1 className="text-xl font-bold tracking-tight">
                    {isApiHealthy && isCoachingActive
                      ? t('app.status_banner_ok_title')
                      : !isCoachingActive
                      ? t('app.status_banner_paused_title')
                      : t('app.status_banner_degraded_title')}
                  </h1>
                  <p className="text-sm opacity-80 mt-0.5">
                    {isApiHealthy && isCoachingActive
                      ? t('app.status_banner_ok_desc')
                      : !isCoachingActive
                      ? t('app.status_banner_paused_desc')
                      : t('app.status_banner_degraded_desc')}
                  </p>
                </div>
              </div>
            </div>

            {/* Core Services Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="p-4 rounded-xl bg-surface-container border border-outline-variant flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                    {t('app.status_live_coach')}
                  </span>
                  <span className="text-base font-bold mt-1">
                    {isCoachingActive ? t('app.status_active') : t('app.status_maintenance')}
                  </span>
                </div>
                <span
                  className={`w-3 h-3 rounded-full ${
                    isCoachingActive ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
                  }`}
                />
              </div>

              <div className="p-4 rounded-xl bg-surface-container border border-outline-variant flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                    {t('app.status_api')}
                  </span>
                  <span className="text-base font-bold mt-1">
                    {isApiHealthy ? t('app.status_operational') : t('app.status_degraded')}
                  </span>
                </div>
                <span
                  className={`w-3 h-3 rounded-full ${
                    isApiHealthy ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'
                  }`}
                />
              </div>

              <div className="p-4 rounded-xl bg-surface-container border border-outline-variant flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                    {t('app.status_sessions_24h')}
                  </span>
                  <span className="text-base font-bold mt-1">
                    {status?.last_24h?.sessions ?? 0}
                  </span>
                </div>
                <span className="material-symbols-outlined text-primary text-xl">
                  verified
                </span>
              </div>
            </div>

            {/* Telemetry & Latencies Section */}
            <section className="p-6 rounded-2xl bg-surface-container-low border border-outline-variant flex flex-col gap-5">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex flex-col">
                  <h2 className="text-lg font-bold text-on-surface">{t('app.status_telemetry_title')}</h2>
                  <p className="text-xs text-on-surface-variant">
                    {t('app.status_telemetry_desc')}
                  </p>
                </div>
                <span className="text-xs px-2.5 py-1 rounded-md bg-surface-container text-on-surface-variant border border-outline-variant">
                  {t('app.status_updated', { time: lastRefreshed.toLocaleTimeString(language) })}
                </span>
              </div>

              {!hasLatencyData ? (
                <div className="p-8 rounded-xl bg-surface-container/50 border border-outline-variant text-center flex flex-col items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-3xl text-on-surface-variant">
                    query_stats
                  </span>
                  <span className="text-sm font-semibold text-on-surface-variant">
                    {t('app.status_no_data')}
                  </span>
                  <p className="text-xs text-on-surface-variant/80 max-w-sm">
                    {t('app.status_no_data_desc')}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-outline-variant text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                        <th className="py-3 px-3">{t('app.status_col_component')}</th>
                        <th className="py-3 px-3">{t('app.status_col_model')}</th>
                        <th className="py-3 px-3 text-right">{t('app.status_col_p50')}</th>
                        <th className="py-3 px-3 text-right">p90</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/60 text-sm">
                      <tr>
                        <td className="py-3 px-3 font-semibold text-on-surface">{t('app.status_row_watch')}</td>
                        <td className="py-3 px-3 text-xs text-on-surface-variant">gemini-3.5-flash-lite</td>
                        <td className="py-3 px-3 text-right font-mono font-medium">
                          {status?.last_24h.p50_ms.watch !== null ? t('app.status_ms', { value: status?.last_24h.p50_ms.watch ?? '' }) : '—'}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-on-surface-variant">
                          {status?.last_24h.p90_ms.watch !== null ? t('app.status_ms', { value: status?.last_24h.p90_ms.watch ?? '' }) : '—'}
                        </td>
                      </tr>
                      <tr>
                        <td className="py-3 px-3 font-semibold text-on-surface">{t('app.status_row_verify')}</td>
                        <td className="py-3 px-3 text-xs text-on-surface-variant">gemini-3.8-flash</td>
                        <td className="py-3 px-3 text-right font-mono font-medium">
                          {status?.last_24h.p50_ms.verify !== null ? t('app.status_ms', { value: status?.last_24h.p50_ms.verify ?? '' }) : '—'}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-on-surface-variant">
                          {status?.last_24h.p90_ms.verify !== null ? t('app.status_ms', { value: status?.last_24h.p90_ms.verify ?? '' }) : '—'}
                        </td>
                      </tr>
                      <tr>
                        <td className="py-3 px-3 font-semibold text-on-surface">{t('app.status_row_point')}</td>
                        <td className="py-3 px-3 text-xs text-on-surface-variant">gemini-robotics-er-2-preview</td>
                        <td className="py-3 px-3 text-right font-mono font-medium">
                          {status?.last_24h.p50_ms.point !== null ? t('app.status_ms', { value: status?.last_24h.p50_ms.point ?? '' }) : '—'}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-on-surface-variant">
                          {status?.last_24h.p90_ms.point !== null ? t('app.status_ms', { value: status?.last_24h.p90_ms.point ?? '' }) : '—'}
                        </td>
                      </tr>
                      <tr>
                        <td className="py-3 px-3 font-semibold text-on-surface">{t('app.status_row_decision')}</td>
                        <td className="py-3 px-3 text-xs text-on-surface-variant">{t('app.status_row_decision_desc')}</td>
                        <td className="py-3 px-3 text-right font-mono font-medium">
                          {status?.last_24h.p50_ms.decision_to_audio !== null
                            ? t('app.status_ms', { value: status?.last_24h.p50_ms.decision_to_audio ?? '' })
                            : '—'}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-on-surface-variant">
                          {status?.last_24h.p90_ms.decision_to_audio !== null
                            ? t('app.status_ms', { value: status?.last_24h.p90_ms.decision_to_audio ?? '' })
                            : '—'}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Privacy & SLA Notice */}
            <footer className="text-center text-xs text-on-surface-variant/80 flex flex-col gap-1 py-4">
              <p>{t('app.status_footer_privacy')}</p>
              <p>{t('app.status_footer_monitoring')}</p>
            </footer>
          </>
        )}
      </div>
    </div>
  );
};

export default StatusScreen;
