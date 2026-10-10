import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchControlSummary, type ControlSourceKpis, type ControlSummary } from '../lib/api';
import { describe } from '../lib/controlEvents';

/**
 * Control tower (P18): the whole factory from one event stream. Cloud Run publishes every event to
 * Pub/Sub; a BigQuery subscription writes it to takumi.events; this page reads it every 10 seconds.
 * Figures are shown per source label so live, home-rig and public-dataset events never mix.
 */

const SOURCE_ORDER = (s: string) => (s === 'LIVE' ? 0 : s === 'HOME RIG' ? 1 : 2);

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

function ago(iso: string | null): string {
  if (!iso) return 'no events yet';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

const KIND_ICON: Record<string, string> = { station: 'front_hand', inspection: 'verified', machine: 'precision_manufacturing', unit: 'inventory_2' };

const Kpi: React.FC<{ label: string; value: string | number; tone?: string }> = ({ label, value, tone }) => (
  <div className="bg-surface-container rounded-xl p-3">
    <div className="text-xs text-on-surface-variant">{label}</div>
    <div className={`text-2xl font-bold ${tone ?? ''}`}>{value}</div>
  </div>
);

const SourceBlock: React.FC<{ source: string; k: ControlSourceKpis }> = ({ source, k }) => (
  <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 space-y-3" data-testid={`source-${source}`}>
    <div className="flex items-center justify-between">
      <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-surface-container-high">{source}</span>
      <span className="text-xs text-on-surface-variant">{k.events} events</span>
    </div>
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <Kpi label="Inspected" value={k.inspected} />
      <Kpi label="First-pass rate" value={pct(k.first_pass_rate)} />
      <Kpi label="Defects confirmed" value={k.confirmed_defects} tone={k.confirmed_defects ? 'text-red-400' : ''} />
      <Kpi label="Units on hold" value={k.units_held} tone={k.units_held ? 'text-purple-400' : ''} />
      <Kpi label="Stations finished" value={k.stations_completed} />
      <Kpi label="Mistakes caught" value={k.mistakes} tone={k.mistakes ? 'text-amber-400' : ''} />
      <Kpi label="Safety stops" value={k.safety_stops} tone={k.safety_stops ? 'text-red-400' : ''} />
      <Kpi label="Machine stops / alarms" value={`${k.machine_stops} / ${k.machine_alarms}`} />
    </div>
  </section>
);

export const ControlTowerScreen: React.FC = () => {
  const navigate = useNavigate();
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<ControlSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchControlSummary(hours));
      setError(null);
    } catch {
      setError('Could not load the control tower.');
    }
  }, [hours]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const sources = data ? Object.keys(data.by_source).sort((a, b) => SOURCE_ORDER(a) - SOURCE_ORDER(b) || a.localeCompare(b)) : [];

  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <header className="px-4 py-3 border-b border-outline-variant flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => navigate(-1)} aria-label="Back" className="min-w-[44px] min-h-[44px]">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold">Control tower</h1>
          <p className="text-xs text-on-surface-variant">Cloud Run → Pub/Sub → BigQuery · last event {ago(data?.last_event_at ?? null)}</p>
        </div>
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Time window" className="min-h-[44px] rounded-lg bg-surface-container px-2">
          <option value={24}>Last 24 hours</option>
          <option value={168}>Last 7 days</option>
        </select>
      </header>

      <main className="max-w-6xl mx-auto p-4 grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4 min-w-0">
          {error && <p className="text-red-400">{error}</p>}
          {!data && !error && <p className="text-on-surface-variant">Loading…</p>}
          {data && sources.length === 0 && (
            <p className="text-on-surface-variant bg-surface-container-low border border-outline-variant rounded-2xl p-4">
              No events in this window yet. Events appear as stations, inspections and machines report.
            </p>
          )}
          {data && sources.map((s) => <SourceBlock key={s} source={s} k={data.by_source[s]} />)}
        </div>

        <aside className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 min-w-0">
          <h2 className="font-bold mb-2">Live feed</h2>
          {data && data.feed.length === 0 && <p className="text-sm text-on-surface-variant">Nothing yet.</p>}
          <ul className="space-y-2" data-testid="control-feed">
            {data?.feed.map((e, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className="material-symbols-outlined text-[18px] text-on-surface-variant shrink-0">{KIND_ICON[e.kind] ?? 'circle'}</span>
                <div className="min-w-0">
                  <div className="truncate">{describe(e)}</div>
                  <div className="text-xs text-on-surface-variant">
                    {new Date(e.ts).toLocaleTimeString()} · {e.source}
                    {e.unit_id && (
                      <>
                        {' · '}
                        <Link to={`/units/${encodeURIComponent(e.unit_id)}`} className="underline font-mono">
                          {e.unit_id}
                        </Link>
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </aside>
      </main>
    </div>
  );
};

export default ControlTowerScreen;
