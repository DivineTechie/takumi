import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchControlSummary, type ControlSourceKpis, type ControlSummary } from '../lib/api';
import { agoText, describe, type TFn } from '../lib/controlEvents';
import { useI18n } from '../i18n';
import { OrdersPanel } from '../components/control/OrdersPanel';
import { MachinesNow } from '../components/control/MachinesNow';
import { WorkOrdersPanel, type DraftRequest } from '../components/control/WorkOrdersPanel';
import type { Machine, WorkOrder } from '../lib/api';
import { CopilotPanel } from '../components/control/CopilotPanel';

/**
 * Control tower (P18): the whole factory from one event stream. Cloud Run publishes every event to
 * Pub/Sub; a BigQuery subscription writes it to takumi.events; this page reads it every 10 seconds.
 * Figures are shown per source label so live, home-rig and public-dataset events never mix.
 */

const SOURCE_ORDER = (s: string) => (s === 'LIVE' ? 0 : s === 'HOME RIG' ? 1 : 2);

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

function ago(t: TFn, iso: string | null): string {
  if (!iso) return t('ops.tower_no_events_yet');
  return agoText(t, (Date.now() - Date.parse(iso)) / 1000, true);
}

const KIND_ICON: Record<string, string> = { station: 'front_hand', inspection: 'verified', machine: 'precision_manufacturing', unit: 'inventory_2' };

const Kpi: React.FC<{ label: string; value: string | number; tone?: string }> = ({ label, value, tone }) => (
  <div className="bg-surface-container rounded-xl p-3 min-w-0">
    <div className="text-xs text-on-surface-variant break-words">{label}</div>
    <div className={`text-2xl font-bold ${tone ?? ''}`}>{value}</div>
  </div>
);

const SourceBlock: React.FC<{ source: string; k: ControlSourceKpis }> = ({ source, k }) => {
  const { t } = useI18n();
  return (
    <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 space-y-3" data-testid={`source-${source}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-surface-container-high">{source}</span>
        <span className="text-xs text-on-surface-variant">{t(k.events === 1 ? 'ops.tower_events_one' : 'ops.tower_events_other', { n: k.events })}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Kpi label={t('ops.tower_kpi_inspected')} value={k.inspected} />
        <Kpi label={t('ops.tower_kpi_first_pass')} value={pct(k.first_pass_rate)} />
        <Kpi label={t('ops.tower_kpi_defects')} value={k.confirmed_defects} tone={k.confirmed_defects ? 'text-red-400' : ''} />
        <Kpi label={t('ops.tower_kpi_on_hold')} value={k.units_held} tone={k.units_held ? 'text-purple-400' : ''} />
        <Kpi label={t('ops.tower_kpi_stations')} value={k.stations_completed} />
        <Kpi label={t('ops.tower_kpi_mistakes')} value={k.mistakes} tone={k.mistakes ? 'text-amber-400' : ''} />
        <Kpi label={t('ops.tower_kpi_safety_stops')} value={k.safety_stops} tone={k.safety_stops ? 'text-red-400' : ''} />
        <Kpi label={t('ops.tower_kpi_machine_stops')} value={`${k.machine_stops} / ${k.machine_alarms}`} />
      </div>
    </section>
  );
};

export const ControlTowerScreen: React.FC = () => {
  const navigate = useNavigate();
  const { t, language } = useI18n();
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<ControlSummary | null>(null);
  const [error, setError] = useState(false);
  const [draftRequest, setDraftRequest] = useState<DraftRequest | null>(null);
  const [autoDraft, setAutoDraft] = useState(false);
  const [machineNames, setMachineNames] = useState<Record<string, string>>({});
  const onMachines = useCallback((ms: Machine[]) => setMachineNames(Object.fromEntries(ms.map((m) => [m.id, m.name]))), []);
  const requestDraft = useCallback((m: Machine) => setDraftRequest({ machineId: m.id, name: m.name, nonce: Date.now() + Math.random() }), []);
  // The voice copilot waits for the visible maintenance agent run to finish.
  const draftForCopilot = useCallback(
    (m: Machine) =>
      new Promise<WorkOrder | null>((resolve) => setDraftRequest({ machineId: m.id, name: m.name, nonce: Date.now() + Math.random(), onDone: resolve })),
    []
  );

  const load = useCallback(async () => {
    try {
      setData(await fetchControlSummary(hours));
      setError(false);
    } catch {
      setError(true);
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
        <button type="button" onClick={() => navigate(-1)} aria-label={t('back')} className="min-w-[44px] min-h-[44px]">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold">{t('ops.tower_title')}</h1>
          <p className="text-xs text-on-surface-variant">Cloud Run → Pub/Sub → BigQuery · {t('ops.tower_last_event', { ago: ago(t, data?.last_event_at ?? null) })}</p>
        </div>
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label={t('ops.tower_time_window')} className="min-h-[44px] rounded-lg bg-surface-container px-2">
          <option value={24}>{t('ops.tower_last_24h')}</option>
          <option value={168}>{t('ops.tower_last_7d')}</option>
        </select>
      </header>

      <main className="max-w-6xl mx-auto p-4 grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4 min-w-0">
          <CopilotPanel draftWorkOrder={draftForCopilot} />
          <MachinesNow onDraft={requestDraft} onNewStop={autoDraft ? requestDraft : undefined} onMachines={onMachines} />
          <WorkOrdersPanel request={draftRequest} autoDraft={autoDraft} onAutoDraftChange={setAutoDraft} />
          <OrdersPanel />
          {error && <p className="text-red-400">{t('ops.tower_load_error')}</p>}
          {!data && !error && <p className="text-on-surface-variant">{t('ops.common_loading')}</p>}
          {data && sources.length === 0 && (
            <p className="text-on-surface-variant bg-surface-container-low border border-outline-variant rounded-2xl p-4">
              {t('ops.tower_no_events')}
            </p>
          )}
          {data && sources.map((s) => <SourceBlock key={s} source={s} k={data.by_source[s]} />)}
        </div>

        <aside className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 min-w-0">
          <h2 className="font-bold mb-2">{t('ops.tower_live_feed')}</h2>
          {data && data.feed.length === 0 && <p className="text-sm text-on-surface-variant">{t('ops.tower_nothing_yet')}</p>}
          <ul className="space-y-2" data-testid="control-feed">
            {data?.feed.map((e, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className="material-symbols-outlined text-[18px] text-on-surface-variant shrink-0">{KIND_ICON[e.kind] ?? 'circle'}</span>
                <div className="min-w-0">
                  <div className="break-words">{describe(e, t, machineNames)}</div>
                  <div className="text-xs text-on-surface-variant">
                    {new Date(e.ts).toLocaleTimeString(language)} · {e.source}
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
