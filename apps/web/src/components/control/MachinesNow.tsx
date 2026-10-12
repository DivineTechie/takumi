import React, { useCallback, useRef, useState } from 'react';
import { fetchMachines, type Machine } from '../../lib/api';
import { agoText, stateLabel, type TFn } from '../../lib/controlEvents';
import { useI18n } from '../../i18n';
import { visibleMachines } from '../../lib/machinesView';
import { usePolling } from '../../lib/usePolling';

/**
 * Live machine states for the control tower. The phone on the floor only senses; this is
 * where a supervisor notices a stop: stopped machines turn red with their alarm text, and with alerts
 * switched on the page beeps when a machine newly stops.
 */

const POLL_MS = 10_000;
/** Longer than the 10-minute check-in: after this the last state is stale, not a live stop. */
const STALE_MS = 15 * 60_000;

function isStale(m: Machine): boolean {
  return !m.last_seen_at || Date.now() - Date.parse(m.last_seen_at) > STALE_MS;
}

function liveState(m: Machine): string | null {
  return isStale(m) ? null : (m.state ?? null);
}

function ago(t: TFn, iso: string | null | undefined): string {
  if (!iso) return t('ops.machines_now_no_reading');
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? t('ops.common_s_ago', { n: s }) : agoText(t, s);
}

export const MachinesNow: React.FC<{
  /** Called when the supervisor asks the maintenance agent for a work order. */
  onDraft?: (m: Machine) => void;
  /** Called for machines that stopped while the page was open (not ones already stopped at load). */
  onNewStop?: (m: Machine) => void;
  /** Receives every machine list it loads (the control tower names machines in its feed). */
  onMachines?: (ms: Machine[]) => void;
}> = ({ onDraft, onNewStop, onMachines }) => {
  const { t } = useI18n();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [alertsOn, setAlertsOn] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const stoppedRef = useRef<Set<string>>(new Set());
  const loadedRef = useRef(false);
  const onNewStopRef = useRef(onNewStop);
  onNewStopRef.current = onNewStop;
  const onMachinesRef = useRef(onMachines);
  onMachinesRef.current = onMachines;

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
      onMachinesRef.current?.(ms);
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

  usePolling(load, POLL_MS);

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
  const { shown, offline } = visibleMachines(machines);
  const stopped = shown.filter((m) => liveState(m) === 'stopped');

  return (
    <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 space-y-3" aria-labelledby="machines-now">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="machines-now" className="font-bold text-lg">
          {t('ops.machines_now_title')} {stopped.length > 0 && <span className="text-red-500">· {t('ops.machines_now_stopped_count', { n: stopped.length })}</span>}
        </h2>
        <button type="button" onClick={toggleAlerts} className="min-h-[44px] px-3 rounded-xl bg-surface-container-high text-sm font-bold flex items-center gap-1 text-left">
          <span className="material-symbols-outlined text-[18px]">{alertsOn ? 'notifications_active' : 'notifications_off'}</span>
          {alertsOn ? t('ops.machines_now_alerts_on') : t('ops.machines_now_alerts_turn_on')}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {shown.map((m) => {
          const state = liveState(m);
          const colour =
            state === 'stopped' ? 'bg-red-600 text-white' : state === 'idle' ? 'bg-amber-400 text-black' : state === 'running' ? 'bg-green-600 text-white' : 'bg-surface-container-high';
          return (
            <div key={m.id} className={`${colour} rounded-xl px-3 py-2 text-sm min-w-[150px] flex-1 sm:flex-none break-words ${state === 'stopped' ? 'tk-ring' : ''}`} data-testid={`machine-now-${m.id}`}>
              <div className="font-bold">{m.name}</div>
              <div>{state ? stateLabel(t, state) : isStale(m) ? t('ops.machines_now_no_camera', { state: stateLabel(t, m.state) }) : stateLabel(t, null)}</div>
              {state === 'stopped' && m.last_alarm && <div className="text-xs font-bold">{m.last_alarm}</div>}
              {state === 'stopped' && onDraft && (
                <button
                  type="button"
                  onClick={() => onDraft(m)}
                  className="mt-1 min-h-[40px] w-full rounded-lg bg-white/90 text-red-700 text-xs font-bold flex items-center justify-center gap-1"
                >
                  <span className="material-symbols-outlined text-[16px]">build</span>
                  {t('ops.machines_now_draft_work_order')}
                </button>
              )}
              <div className="text-[11px] opacity-80">
                {m.source === 'VIRTUAL' ? 'HOME RIG' : 'LIVE'} · {ago(t, m.last_seen_at)}
              </div>
            </div>
          );
        })}
      </div>
      {offline.length > 0 && <p className="text-xs text-on-surface-variant">{t('ops.machines_now_offline_count', { n: offline.length })}</p>}
    </section>
  );
};
