import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMachines, type Machine } from '../../lib/api';

/**
 * Live machine states for the control tower (P17/P18). The phone on the floor only senses; this is
 * where a supervisor notices a stop: stopped machines turn red with their alarm text, and with alerts
 * switched on the page beeps when a machine newly stops.
 */

const POLL_MS = 5_000;
/** Longer than the 10-minute check-in: after this the last state is stale, not a live stop. */
const STALE_MS = 15 * 60_000;

function isStale(m: Machine): boolean {
  return !m.last_seen_at || Date.now() - Date.parse(m.last_seen_at) > STALE_MS;
}

function liveState(m: Machine): string | null {
  return isStale(m) ? null : (m.state ?? null);
}

function ago(iso: string | null | undefined): string {
  if (!iso) return 'no reading yet';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

export const MachinesNow: React.FC<{
  /** Called when the supervisor asks the maintenance agent for a work order. */
  onDraft?: (m: Machine) => void;
  /** Called for machines that stopped while the page was open (not ones already stopped at load). */
  onNewStop?: (m: Machine) => void;
}> = ({ onDraft, onNewStop }) => {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [alertsOn, setAlertsOn] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const stoppedRef = useRef<Set<string>>(new Set());
  const loadedRef = useRef(false);
  const onNewStopRef = useRef(onNewStop);
  onNewStopRef.current = onNewStop;

  const beep = useCallback(() => {
    const ctx = audioRef.current;
    if (!ctx) return;
    [0, 0.35, 0.7].forEach((t) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.25, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.26);
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const ms = await fetchMachines();
      const nowStopped = new Set(ms.filter((m) => liveState(m) === 'stopped').map((m) => m.id));
      const fresh = ms.filter((m) => nowStopped.has(m.id) && !stoppedRef.current.has(m.id));
      if (fresh.length > 0 && alertsOn) beep();
      if (loadedRef.current) fresh.forEach((m) => onNewStopRef.current?.(m));
      loadedRef.current = true;
      stoppedRef.current = nowStopped;
      setMachines(ms);
    } catch {
      setMachines((prev) => prev ?? []);
    }
  }, [alertsOn, beep]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const toggleAlerts = () => {
    if (!alertsOn) {
      try {
        audioRef.current = audioRef.current ?? new AudioContext();
        void audioRef.current.resume();
      } catch {
        audioRef.current = null;
      }
    }
    setAlertsOn((v) => !v);
  };

  if (!machines || machines.length === 0) return null;
  const stopped = machines.filter((m) => liveState(m) === 'stopped');

  return (
    <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 space-y-3" aria-labelledby="machines-now">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="machines-now" className="font-bold text-lg">
          Machines now {stopped.length > 0 && <span className="text-red-500">· {stopped.length} stopped</span>}
        </h2>
        <button type="button" onClick={toggleAlerts} className="min-h-[44px] px-3 rounded-xl bg-surface-container-high text-sm font-bold flex items-center gap-1">
          <span className="material-symbols-outlined text-[18px]">{alertsOn ? 'notifications_active' : 'notifications_off'}</span>
          {alertsOn ? 'Stop alerts on' : 'Turn on stop alerts'}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {machines.map((m) => {
          const state = liveState(m);
          const colour =
            state === 'stopped' ? 'bg-red-600 text-white' : state === 'idle' ? 'bg-amber-400 text-black' : state === 'running' ? 'bg-green-600 text-white' : 'bg-surface-container-high';
          return (
            <div key={m.id} className={`${colour} rounded-xl px-3 py-2 text-sm min-w-[150px] flex-1 sm:flex-none ${state === 'stopped' ? 'tk-ring' : ''}`} data-testid={`machine-now-${m.id}`}>
              <div className="font-bold">{m.name}</div>
              <div>{state ?? (isStale(m) ? `no camera (last: ${m.state ?? 'unknown'})` : 'unknown')}</div>
              {state === 'stopped' && m.last_alarm && <div className="text-xs font-bold">{m.last_alarm}</div>}
              {state === 'stopped' && onDraft && (
                <button
                  type="button"
                  onClick={() => onDraft(m)}
                  className="mt-1 min-h-[40px] w-full rounded-lg bg-white/90 text-red-700 text-xs font-bold flex items-center justify-center gap-1"
                >
                  <span className="material-symbols-outlined text-[16px]">build</span>
                  Draft work order
                </button>
              )}
              <div className="text-[11px] opacity-80">
                {m.source === 'VIRTUAL' ? 'HOME RIG' : 'LIVE'} · {ago(m.last_seen_at)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
