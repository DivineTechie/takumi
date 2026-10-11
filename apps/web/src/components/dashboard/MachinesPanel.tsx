import React, { useCallback, useEffect, useState } from 'react';
import { fetchMachinesSummary, type MachineDaySummary } from '../../lib/api';
import { stateLabel, type TFn } from '../../lib/controlEvents';
import { useI18n } from '../../i18n';

/**
 * Supervisor view of Machine Watch (P17): today's state timeline per machine, availability, stops,
 * downtime, top alarms and parts, all computed by the API from real machine_events. Every figure
 * carries its source label (LIVE or HOME RIG); empty values show "—".
 */

const STATE_COLOUR: Record<string, string> = {
  running: 'bg-green-500',
  idle: 'bg-amber-400',
  stopped: 'bg-red-500',
};

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

function minutes(t: TFn, s: number): string {
  if (!s) return t('ops.machines_panel_minutes', { n: 0 });
  return s >= 3600 ? t('ops.machines_panel_hours', { n: (s / 3600).toFixed(1) }) : t('ops.machines_panel_minutes', { n: Math.round(s / 60) });
}

const Timeline: React.FC<{ m: MachineDaySummary; dayStart: number; dayEnd: number }> = ({ m, dayStart, dayEnd }) => {
  const { t, language } = useI18n();
  const span = Math.max(1, dayEnd - dayStart);
  return (
    <div className="relative h-6 rounded-md bg-surface-container-high overflow-hidden" role="img" aria-label={t('ops.machines_panel_timeline_label', { name: m.name })}>
      {m.segments.map((seg, i) => {
        const start = Date.parse(seg.start);
        const end = Date.parse(seg.end);
        return (
          <div
            key={i}
            title={`${stateLabel(t, seg.state)}: ${new Date(start).toLocaleTimeString(language)} – ${new Date(end).toLocaleTimeString(language)}`}
            className={`absolute top-0 bottom-0 ${STATE_COLOUR[seg.state] ?? 'bg-neutral-500'}`}
            style={{ left: `${((start - dayStart) / span) * 100}%`, width: `${Math.max(0.2, ((end - start) / span) * 100)}%` }}
          />
        );
      })}
    </div>
  );
};

export const MachinesPanel: React.FC = () => {
  const { t } = useI18n();
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchMachinesSummary>> | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await fetchMachinesSummary());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div className="text-red-400 p-4">{t('ops.machines_panel_load_error')}</div>;
  if (!data) return <div className="p-4 text-on-surface-variant">{t('ops.common_loading')}</div>;
  // Repeated setups of the same machine (same name, source and bench slot): keep the one with the most
  // events today, and leave out machines with no events at all today.
  const byMachine = new Map<string, MachineDaySummary>();
  for (const m of data.machines) {
    if (!m.events) continue;
    const key = `${m.source}|${m.name.trim().toLowerCase()}|${m.bench_slot ?? ''}`;
    const prev = byMachine.get(key);
    if (!prev || m.events > prev.events) byMachine.set(key, m);
  }
  const machines = [...byMachine.values()];

  if (machines.length === 0) {
    return (
      <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 text-on-surface-variant">
        {t('ops.machines_panel_empty')}
      </div>
    );
  }

  const dayStart = Date.parse(`${data.day}T00:00:00Z`);
  const dayEnd = Date.parse(data.window_end);

  return (
    <div className="space-y-4">
      <p className="text-xs text-on-surface-variant">
        {t('ops.machines_panel_legend')}
      </p>
      {machines.map((m) => {
        const oee = m.availability !== null && m.performance !== null ? m.availability * m.performance : null;
        return (
          <section key={m.id} className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 space-y-3" data-testid={`machine-summary-${m.id}`}>
            <div className="flex flex-wrap items-center gap-2 justify-between">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <h3 className="text-lg font-bold">{m.name}</h3>
                <span className={`text-xs px-2 py-0.5 rounded-full text-black ${STATE_COLOUR[m.state ?? ''] ?? 'bg-neutral-400'}`}>{stateLabel(t, m.state)}</span>
                {m.last_alarm && <span className="text-xs text-red-400 font-bold">{m.last_alarm}</span>}
              </div>
              <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-surface-container-high">{m.source ?? '—'}</span>
            </div>
            <Timeline m={m} dayStart={dayStart} dayEnd={dayEnd} />
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
              <div>
                <div className="text-on-surface-variant text-xs break-words">{t('ops.machines_panel_availability')}</div>
                <div className="text-xl font-bold">{pct(m.availability)}</div>
              </div>
              <div>
                <div className="text-on-surface-variant text-xs break-words">{t('ops.machines_panel_stops_downtime')}</div>
                <div className="text-xl font-bold">
                  {m.stops} / {minutes(t, m.stopped_s)}
                </div>
              </div>
              <div>
                <div className="text-on-surface-variant text-xs break-words">{t('ops.machines_panel_parts')}</div>
                <div className="text-xl font-bold">{m.events ? m.parts : '—'}</div>
              </div>
              <div>
                <div className="text-on-surface-variant text-xs break-words">{t('ops.machines_panel_performance')}</div>
                <div className="text-xl font-bold">{pct(m.performance)}</div>
              </div>
              <div>
                <div className="text-on-surface-variant text-xs break-words">{t('ops.machines_panel_oee')}</div>
                <div className="text-xl font-bold">{pct(oee)}</div>
              </div>
            </div>
            {m.top_alarms.length > 0 && (
              <div className="text-sm">
                <span className="text-on-surface-variant">{t('ops.machines_panel_top_alarms')} </span>
                {m.top_alarms.map((a) => `${a.alarm_text} (${a.count})`).join(', ')}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
};
