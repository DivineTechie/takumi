import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { fetchSystemStatus, type SystemStatusResponse } from '../lib/api';
import logoSvg from '../assets/logo.svg';

export const StatusScreen: React.FC = () => {
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
      setError(err instanceof Error ? err.message : 'Unable to load system status.');
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
              <span className="text-xs font-medium text-on-surface-variant">System Status</span>
            </div>
          </Link>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                void loadStatus();
              }}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface border border-outline-variant transition-colors cursor-pointer disabled:opacity-50"
              title="Refresh status"
            >
              <span className={`material-symbols-outlined text-[18px] ${loading ? 'animate-spin' : ''}`}>
                refresh
              </span>
              <span className="hidden sm:inline">Refresh</span>
            </button>
            <Link
              to="/coach"
              className="px-3.5 py-2 text-sm font-semibold rounded-lg bg-primary-container text-on-primary-container hover:brightness-105 transition-all shadow-sm"
            >
              Open App
            </Link>
          </div>
        </header>

        {/* Overall Status Banner */}
        {loading && !status ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="w-8 h-8 border-3 border-primary-container border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-medium text-on-surface-variant">Checking system status...</p>
          </div>
        ) : error && !status ? (
          <div className="p-5 rounded-2xl bg-error-container/20 border border-error/30 text-error flex items-start gap-3">
            <span className="material-symbols-outlined text-2xl shrink-0">error</span>
            <div className="flex flex-col gap-1">
              <span className="font-bold">Status check unavailable</span>
              <span className="text-sm opacity-90">{error}</span>
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
                      ? 'All Systems Operational'
                      : !isCoachingActive
                      ? 'Coaching Paused for Maintenance'
                      : 'Degraded Performance'}
                  </h1>
                  <p className="text-sm opacity-80 mt-0.5">
                    {isApiHealthy && isCoachingActive
                      ? 'Live Coach, Vision Models, and APIs are operating nominally.'
                      : !isCoachingActive
                      ? 'Live coaching sessions are temporarily paused. Other features remain accessible.'
                      : 'Some background services may experience elevated latency.'}
                  </p>
                </div>
              </div>
            </div>

            {/* Core Services Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="p-4 rounded-xl bg-surface-container border border-outline-variant flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                    Live Coach
                  </span>
                  <span className="text-base font-bold mt-1">
                    {isCoachingActive ? 'Active' : 'Maintenance'}
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
                    TAKUMI API
                  </span>
                  <span className="text-base font-bold mt-1">
                    {isApiHealthy ? 'Operational' : 'Degraded'}
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
                    24h Sessions
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
                  <h2 className="text-lg font-bold text-on-surface">24-Hour Performance Telemetry</h2>
                  <p className="text-xs text-on-surface-variant">
                    Aggregate p50 / p90 latencies measured from live sessions and BigQuery logs
                  </p>
                </div>
                <span className="text-xs px-2.5 py-1 rounded-md bg-surface-container text-on-surface-variant border border-outline-variant">
                  Updated {lastRefreshed.toLocaleTimeString()}
                </span>
              </div>

              {!hasLatencyData ? (
                <div className="p-8 rounded-xl bg-surface-container/50 border border-outline-variant text-center flex flex-col items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-3xl text-on-surface-variant">
                    query_stats
                  </span>
                  <span className="text-sm font-semibold text-on-surface-variant">
                    No data in the last 24 h
                  </span>
                  <p className="text-xs text-on-surface-variant/80 max-w-sm">
                    Latency percentiles will automatically populate once coaching runs are recorded.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-outline-variant text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                        <th className="py-3 px-3">Pipeline Component</th>
                        <th className="py-3 px-3">Underlying Model</th>
                        <th className="py-3 px-3 text-right">p50 (Median)</th>
                        <th className="py-3 px-3 text-right">p90</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/60 text-sm">
                      <tr>
                        <td className="py-3 px-3 font-semibold text-on-surface">Step Watch</td>
                        <td className="py-3 px-3 text-xs text-on-surface-variant">gemini-3.5-flash-lite</td>
                        <td className="py-3 px-3 text-right font-mono font-medium">
                          {status?.last_24h.p50_ms.watch !== null ? `${status?.last_24h.p50_ms.watch} ms` : '—'}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-on-surface-variant">
                          {status?.last_24h.p90_ms.watch !== null ? `${status?.last_24h.p90_ms.watch} ms` : '—'}
                        </td>
                      </tr>
                      <tr>
                        <td className="py-3 px-3 font-semibold text-on-surface">Step Verify</td>
                        <td className="py-3 px-3 text-xs text-on-surface-variant">gemini-3.8-flash</td>
                        <td className="py-3 px-3 text-right font-mono font-medium">
                          {status?.last_24h.p50_ms.verify !== null ? `${status?.last_24h.p50_ms.verify} ms` : '—'}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-on-surface-variant">
                          {status?.last_24h.p90_ms.verify !== null ? `${status?.last_24h.p90_ms.verify} ms` : '—'}
                        </td>
                      </tr>
                      <tr>
                        <td className="py-3 px-3 font-semibold text-on-surface">Spatial Pointer</td>
                        <td className="py-3 px-3 text-xs text-on-surface-variant">gemini-robotics-er-2-preview</td>
                        <td className="py-3 px-3 text-right font-mono font-medium">
                          {status?.last_24h.p50_ms.point !== null ? `${status?.last_24h.p50_ms.point} ms` : '—'}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-on-surface-variant">
                          {status?.last_24h.p90_ms.point !== null ? `${status?.last_24h.p90_ms.point} ms` : '—'}
                        </td>
                      </tr>
                      <tr>
                        <td className="py-3 px-3 font-semibold text-on-surface">Decision to Audio</td>
                        <td className="py-3 px-3 text-xs text-on-surface-variant">Watcher trigger → speech output</td>
                        <td className="py-3 px-3 text-right font-mono font-medium">
                          {status?.last_24h.p50_ms.decision_to_audio !== null
                            ? `${status?.last_24h.p50_ms.decision_to_audio} ms`
                            : '—'}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-on-surface-variant">
                          {status?.last_24h.p90_ms.decision_to_audio !== null
                            ? `${status?.last_24h.p90_ms.decision_to_audio} ms`
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
              <p>TAKUMI Telemetry • Anonymous latency statistics only • Zero personal data retained</p>
              <p>Monitored with Google Cloud Monitoring & Model Armor security screening</p>
            </footer>
          </>
        )}
      </div>
    </div>
  );
};

export default StatusScreen;
