import React, { useCallback, useEffect, useState } from 'react';
import { fetchMachinesSummary, type MachineDaySummary } from '../../lib/api';

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

function minutes(s: number): string {
  if (!s) return '0 min';
  return s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`;
}

const Timeline: React.FC<{ m: MachineDaySummary; dayStart: number; dayEnd: number }> = ({ m, dayStart, dayEnd }) => {
  const span = Math.max(1, dayEnd - dayStart);
  return (
    <div className="relative h-6 rounded-md bg-surface-container-high overflow-hidden" role="img" aria-label={`${m.name} state timeline`}>
      {m.segments.map((seg, i) => {
        const start = Date.parse(seg.start);
        const end = Date.parse(seg.end);
        return (
          <div
            key={i}
            title={`${seg.state}: ${new Date(start).toLocaleTimeString()} – ${new Date(end).toLocaleTimeString()}`}
            className={`absolute top-0 bottom-0 ${STATE_COLOUR[seg.state] ?? 'bg-neutral-500'}`}
            style={{ left: `${((start - dayStart) / span) * 100}%`, width: `${Math.max(0.2, ((end - start) / span) * 100)}%` }}
          />
        );
      })}
    </div>
  );
};

export const MachinesPanel: React.FC = () => {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchMachinesSummary>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchMachinesSummary());
      setError(null);
    } catch {
      setError('Could not load machine data.');
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div className="text-red-400 p-4">{error}</div>;
  if (!data) return <div className="p-4 text-on-surface-variant">Loading…</div>;
  if (data.machines.length === 0) {
    return (
      <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 text-on-surface-variant">
        No machines set up yet. Open Machine Watch on a mounted phone to add one.
      </div>
    );
  }

  const dayStart = Date.parse(`${data.day}T00:00:00Z`);
  const dayEnd = Date.parse(data.window_end);

  return (
    <div className="space-y-4">
      <p className="text-xs text-on-surface-variant">
        Today (UTC). Timeline: green running, amber idle, red stopped, grey not yet observed. OEE here is availability × performance;
        quality is n/a until a machine is linked to an inspection point.
      </p>
      {data.machines.map((m) => {
        const oee = m.availability !== null && m.performance !== null ? m.availability * m.performance : null;
        return (
          <section key={m.id} className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 space-y-3" data-testid={`machine-summary-${m.id}`}>
            <div className="flex flex-wrap items-center gap-2 justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold">{m.name}</h3>
                <span className={`text-xs px-2 py-0.5 rounded-full text-black ${STATE_COLOUR[m.state ?? ''] ?? 'bg-neutral-400'}`}>{m.state ?? 'unknown'}</span>
                {m.last_alarm && <span className="text-xs text-red-400 font-bold">{m.last_alarm}</span>}
              </div>
              <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-surface-container-high">{m.source ?? '—'}</span>
            </div>
            <Timeline m={m} dayStart={dayStart} dayEnd={dayEnd} />
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
              <div>
                <div className="text-on-surface-variant text-xs">Availability</div>
                <div className="text-xl font-bold">{pct(m.availability)}</div>
              </div>
              <div>
                <div className="text-on-surface-variant text-xs">Stops / downtime</div>
                <div className="text-xl font-bold">
                  {m.stops} / {minutes(m.stopped_s)}
                </div>
              </div>
              <div>
                <div className="text-on-surface-variant text-xs">Parts (counter)</div>
                <div className="text-xl font-bold">{m.events ? m.parts : '—'}</div>
              </div>
              <div>
                <div className="text-on-surface-variant text-xs">Performance</div>
                <div className="text-xl font-bold">{pct(m.performance)}</div>
              </div>
              <div>
                <div className="text-on-surface-variant text-xs">OEE (A × P)</div>
                <div className="text-xl font-bold">{pct(oee)}</div>
              </div>
            </div>
            {m.top_alarms.length > 0 && (
              <div className="text-sm">
                <span className="text-on-surface-variant">Top alarms: </span>
                {m.top_alarms.map((a) => `${a.alarm_text} (${a.count})`).join(', ')}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
};
