import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { endSoakRun, fetchMachines, postSoakTruth, startSoakRun } from '../lib/api';
import {
  DETECTION_POLL_MS,
  median,
  resolvePending,
  watchedFor,
  type DetectionResult,
  type PendingChange,
} from '../lib/detectionTimer';
import {
  BENCH_ALARMS,
  buildBenchSchedule,
  formatRunClock,
  phaseAt,
  type BenchPace,
  type BenchPhase,
  type BenchState,
} from '../lib/benchSchedule';
import logoSvg from '../assets/logo.svg';
import { useI18n } from '../i18n';

/**
 * HOME RIG test bench (P17): 1-3 simulated machines with a stack light, a parts counter and an HMI
 * screen. A camera pointed at this page is watched by /machines/watch. During a soak run every state
 * change, alarm and part is logged as ground truth (server timestamps) so detections can be scored.
 */

const BENCH = [
  { slot: 1, name: 'CNC Mill 1', idealCycleS: 12 },
  { slot: 2, name: 'Press 2', idealCycleS: 8 },
  { slot: 3, name: 'Packer 3', idealCycleS: 15 },
];

const DURATIONS = [15, 60, 240, 480];

interface BenchMachine {
  slot: number;
  name: string;
  idealCycleS: number;
  state: BenchState;
  alarm: string | null;
  count: number;
  nextPartAt: number;
}

type TruthType = 'state_change' | 'alarm' | 'alarm_cleared' | 'count';

function nextCycleMs(idealCycleS: number): number {
  return idealCycleS * 1000 * (0.9 + Math.random() * 0.2);
}

const LIGHT_STYLE: Record<string, { on: string; off: string }> = {
  red: { on: 'bg-red-500 shadow-[0_0_40px_12px_rgba(239,68,68,0.75)]', off: 'bg-red-950' },
  yellow: { on: 'bg-amber-400 shadow-[0_0_40px_12px_rgba(251,191,36,0.75)]', off: 'bg-amber-950' },
  green: { on: 'bg-green-500 shadow-[0_0_40px_12px_rgba(34,197,94,0.75)]', off: 'bg-green-950' },
};
const STATE_LIGHT: Record<BenchState, string> = { stopped: 'red', idle: 'yellow', running: 'green' };

interface Detection {
  pending: PendingChange | null;
  result: DetectionResult | null;
}

/** Stopwatch chip: how long TAKUMI took to see this machine's last change (HOME RIG). */
const DetectionChip: React.FC<{ d: Detection | undefined; now: number }> = ({ d, now }) => {
  const { t } = useI18n();
  if (d?.pending) {
    return (
      <div className="min-h-[36px] py-1 px-3 rounded-full bg-neutral-800 text-neutral-200 text-sm font-mono flex items-center gap-2" role="status">
        <span className="w-2 h-2 rounded-full bg-neutral-300 animate-pulse" />
        {t('ops.bench_chip_watching', { s: ((now - d.pending.since) / 1000).toFixed(1) })}
      </div>
    );
  }
  const r = d?.result;
  if (!r || now - r.at > 12_000) return <div className="h-9" aria-hidden="true" />;
  if (r.kind === 'seen') {
    return (
      <div key={r.at} className="min-h-[36px] py-1 px-3 rounded-full bg-neutral-700 text-white text-sm font-bold flex items-center gap-1.5 tk-pop" role="status">
        <span className="material-symbols-outlined text-[18px]">visibility</span>
        {t('ops.bench_chip_seen', { s: r.afterS.toFixed(1) })}
      </div>
    );
  }
  return (
    <div className="min-h-[36px] py-1 px-3 rounded-full bg-neutral-800 text-neutral-400 text-sm flex items-center text-center" role="status">
      {r.kind === 'missed' ? t('ops.bench_chip_missed') : t('ops.bench_chip_no_camera')}
    </div>
  );
};

const MachinePanel: React.FC<{
  m: BenchMachine;
  showControls: boolean;
  onSet: (slot: number, state: BenchState, alarm: string | null) => void;
  detection?: Detection;
  showTimer: boolean;
  now: number;
}> = ({ m, showControls, onSet, detection, showTimer, now }) => {
  const { t } = useI18n();
  const [alarmPick, setAlarmPick] = useState(BENCH_ALARMS[0]);
  const lit = STATE_LIGHT[m.state];
  return (
    <div className="flex flex-col items-center gap-5 bg-neutral-900 border-2 border-neutral-800 rounded-3xl p-5 min-w-0">
      <div className="text-lg font-bold tracking-wide text-neutral-200">{m.name}</div>
      <div className="flex items-end gap-6">
        {/* Stack light tower: red, yellow, green top to bottom */}
        <div className="flex flex-col items-center">
          <div className="flex flex-col gap-2 bg-neutral-800 border-4 border-neutral-700 rounded-xl p-2" data-testid={`stack-light-${m.slot}`}>
            {['red', 'yellow', 'green'].map((c) => (
              <div
                key={c}
                data-lit={c === lit}
                className={`w-20 h-16 rounded-md transition-all duration-150 ${c === lit ? LIGHT_STYLE[c].on : LIGHT_STYLE[c].off}`}
              />
            ))}
          </div>
          <div className="w-3 h-16 bg-neutral-700" />
          <div className="w-16 h-3 bg-neutral-700 rounded" />
        </div>
        <div className="flex flex-col gap-4 min-w-0">
          {/* Parts counter */}
          <div className="bg-black border-4 border-neutral-700 rounded-lg px-4 py-2">
            <div className="text-[10px] font-mono text-neutral-500 tracking-widest">PARTS</div>
            <div className="font-mono text-5xl font-bold text-red-500 tracking-[0.15em] tabular-nums" data-testid={`counter-${m.slot}`}>
              {String(m.count).padStart(6, '0')}
            </div>
          </div>
          {/* HMI screen */}
          <div className="bg-slate-950 border-4 border-neutral-600 rounded-lg w-64 h-28 p-3 font-mono flex flex-col justify-center" data-testid={`hmi-${m.slot}`}>
            {m.state === 'stopped' && m.alarm ? (
              <>
                <div className="text-xs text-red-400 font-bold">ALARM</div>
                <div className="text-xl text-red-300 font-bold leading-tight">{m.alarm}</div>
              </>
            ) : m.state === 'idle' ? (
              <div className="text-2xl text-amber-300 font-bold">IDLE</div>
            ) : m.state === 'stopped' ? (
              <div className="text-2xl text-red-300 font-bold">STOPPED</div>
            ) : (
              <div className="text-2xl text-green-300 font-bold">RUNNING</div>
            )}
          </div>
        </div>
      </div>
      {/* Below the machine, away from the boxed lamps, counter and screen; neutral colours only. */}
      {showTimer && <DetectionChip d={detection} now={now} />}
      {showControls && (
        <div className="flex flex-wrap justify-center gap-2 w-full">
          <button type="button" onClick={() => onSet(m.slot, 'running', null)} className="min-h-[48px] px-4 rounded-xl bg-green-700 font-bold">
            {t('ops.bench_btn_run')}
          </button>
          <button type="button" onClick={() => onSet(m.slot, 'idle', null)} className="min-h-[48px] px-4 rounded-xl bg-amber-700 font-bold">
            {t('ops.bench_btn_idle')}
          </button>
          <select
            value={alarmPick}
            onChange={(e) => setAlarmPick(e.target.value)}
            aria-label={t('ops.bench_alarm_for', { name: m.name })}
            className="min-h-[48px] rounded-xl bg-neutral-800 border border-neutral-700 px-2 text-sm"
          >
            {BENCH_ALARMS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <button type="button" onClick={() => onSet(m.slot, 'stopped', alarmPick)} className="min-h-[48px] px-4 rounded-xl bg-red-700 font-bold">
            {t('ops.bench_btn_stop_alarm')}
          </button>
        </div>
      )}
    </div>
  );
};

export const VirtualMachineScreen: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [machineCount, setMachineCount] = useState(3);
  const [machines, setMachines] = useState<BenchMachine[]>(() =>
    BENCH.map((b) => ({ ...b, state: 'running', alarm: null, count: 0, nextPartAt: Date.now() + nextCycleMs(b.idealCycleS) }))
  );
  const machinesRef = useRef(machines);

  const [showControls, setShowControls] = useState(true);
  const [duration, setDuration] = useState(60);
  const [seed, setSeed] = useState(42);
  const [pace, setPace] = useState<BenchPace>('realistic');
  const [autoSchedule, setAutoSchedule] = useState(true);
  const [run, setRun] = useState<{ id: string; localStart: number; durationS: number; auto: boolean } | null>(null);
  const runRef = useRef(run);
  const schedulesRef = useRef<Record<number, BenchPhase[]>>({});
  const [clockS, setClockS] = useState(0);
  const [error, setError] = useState(false);
  const [truthFailures, setTruthFailures] = useState(0);
  const [showTimer, setShowTimer] = useState(true);
  const [detections, setDetections] = useState<Record<number, Detection>>({});
  const [seenTimes, setSeenTimes] = useState<number[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const pendingRef = useRef<Record<number, PendingChange>>({});
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const updateMachines = useCallback((next: BenchMachine[]) => {
    machinesRef.current = next;
    setMachines(next);
  }, []);

  const updateRun = useCallback((next: typeof run) => {
    runRef.current = next;
    setRun(next);
  }, []);

  // Keep the screen awake while the bench is open (a sleeping screen would look like a stoppage).
  useEffect(() => {
    let released = false;
    const request = async () => {
      try {
        if ('wakeLock' in navigator && !released) wakeLockRef.current = await navigator.wakeLock.request('screen');
      } catch {
        // Not fatal: the bench still works, the screen may just dim.
      }
    };
    request();
    const onVisible = () => document.visibilityState === 'visible' && request();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisible);
      wakeLockRef.current?.release().catch(() => {});
    };
  }, []);

  const logTruth = useCallback((slot: number, type: TruthType, m: Partial<BenchMachine>) => {
    const r = runRef.current;
    if (!r) return;
    postSoakTruth(r.id, {
      machine_id: `bench_${slot}`,
      event_type: type,
      state: m.state ?? null,
      count: m.count ?? null,
      alarm_code: m.alarm ?? null,
    }).catch(() => setTruthFailures((n) => n + 1));
  }, []);

  /** Applies a new state/alarm to one machine and logs the truth events it implies. */
  const applyState = useCallback(
    (slot: number, state: BenchState, alarm: string | null) => {
      const prev = machinesRef.current.find((m) => m.slot === slot);
      if (!prev) return;
      const next = { ...prev, state, alarm: state === 'stopped' ? alarm : null };
      if (prev.state === next.state && prev.alarm === next.alarm) return;
      if (prev.alarm && prev.alarm !== next.alarm) logTruth(slot, 'alarm_cleared', next);
      if (prev.state !== next.state) logTruth(slot, 'state_change', next);
      if (next.alarm && next.alarm !== prev.alarm) logTruth(slot, 'alarm', next);
      if (prev.state !== next.state) {
        const pending = { target: next.state, since: Date.now() };
        pendingRef.current = { ...pendingRef.current, [slot]: pending };
        setDetections((d) => ({ ...d, [slot]: { pending, result: null } }));
      }
      updateMachines(machinesRef.current.map((m) => (m.slot === slot ? next : m)));
    },
    [logTruth, updateMachines]
  );

  // Engine: parts counting and the soak schedule, ticking 4x per second.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const r = runRef.current;
      if (r) {
        const s = (now - r.localStart) / 1000;
        setClockS(s);
        if (r.auto) {
          for (const m of machinesRef.current.slice(0, machineCount)) {
            const phases = schedulesRef.current[m.slot];
            if (!phases?.length) continue;
            const phase = phaseAt(phases, s);
            if (phase.state !== m.state || phase.alarm !== m.alarm) applyState(m.slot, phase.state, phase.alarm);
          }
        }
        if (s >= r.durationS) {
          endSoakRun(r.id).catch(() => {});
          updateRun(null);
        }
      }
      let changed = false;
      const updated = machinesRef.current.map((m) => {
        if (m.state !== 'running') return m.nextPartAt > now ? m : { ...m, nextPartAt: now + nextCycleMs(m.idealCycleS) };
        if (now < m.nextPartAt) return m;
        changed = true;
        const next = { ...m, count: m.count + 1, nextPartAt: now + nextCycleMs(m.idealCycleS) };
        if (m.slot <= machineCount) logTruth(m.slot, 'count', next);
        return next;
      });
      if (changed) updateMachines(updated);
    }, 250);
    return () => clearInterval(timer);
  }, [applyState, logTruth, machineCount, updateMachines, updateRun]);

  // Detection stopwatch: while a change is waiting, ask the server what the watched copy reports.
  useEffect(() => {
    let inFlight = false;
    const timer = setInterval(async () => {
      setNowMs(Date.now());
      const slots = Object.keys(pendingRef.current).map(Number);
      if (slots.length === 0 || inFlight) return;
      inFlight = true;
      try {
        const list = await fetchMachines();
        const now = Date.now();
        for (const slot of slots) {
          const pending = pendingRef.current[slot];
          if (!pending) continue;
          const result = resolvePending(pending, watchedFor(list, slot, now), now);
          if (!result) continue;
          const rest = { ...pendingRef.current };
          delete rest[slot];
          pendingRef.current = rest;
          setDetections((d) => ({ ...d, [slot]: { pending: null, result } }));
          if (result.kind === 'seen') setSeenTimes((t) => [...t, result.afterS]);
        }
      } catch {
        // Offline or signed out: the bench keeps running without the stopwatch.
      } finally {
        inFlight = false;
      }
    }, DETECTION_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const startRun = async () => {
    setError(false);
    try {
      const slots = BENCH.slice(0, machineCount).map((b) => b.slot);
      const created = await startSoakRun({
        duration_min: duration,
        schedule_seed: seed,
        machines: slots.map((s) => `bench_${s}`),
      });
      const durationS = duration * 60;
      schedulesRef.current = Object.fromEntries(slots.map((s) => [s, buildBenchSchedule(seed, s, durationS, pace)]));
      updateRun({ id: created.id, localStart: Date.now(), durationS, auto: autoSchedule });
      setClockS(0);
      setTruthFailures(0);
      // Truth starts from a known state: every machine running with no alarm.
      for (const s of slots) {
        const m = machinesRef.current.find((x) => x.slot === s);
        if (m?.state === 'running' && !m.alarm) logTruth(s, 'state_change', m);
        else applyState(s, 'running', null);
      }
    } catch {
      setError(true);
    }
  };

  const stopRun = async () => {
    const r = runRef.current;
    updateRun(null);
    if (r) await endSoakRun(r.id).catch(() => {});
  };

  const visible = machines.slice(0, machineCount);

  return (
    <div className="bg-neutral-950 text-neutral-100 min-h-screen flex flex-col font-sans select-none antialiased">
      {showControls && (
        <header className="bg-neutral-900 border-b border-neutral-800 px-4 py-3">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center gap-3 justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <button type="button" onClick={() => navigate('/')} className="min-w-[44px] min-h-[44px] text-neutral-400 hover:text-white" aria-label={t('ops.common_back_home')}>
                <span className="material-symbols-outlined text-[24px]">arrow_back</span>
              </button>
              <img src={logoSvg} alt="TAKUMI" className="w-7 h-7" />
              <div className="min-w-0">
                <div className="font-bold tracking-wide">{t('ops.bench_title')}</div>
                <div className="text-xs text-neutral-400">{t('ops.bench_subtitle')}</div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex items-center gap-1">
                {t('ops.bench_label_machines')}
                <select value={machineCount} onChange={(e) => setMachineCount(Number(e.target.value))} disabled={!!run} className="bg-neutral-800 rounded px-2 py-1">
                  {[1, 2, 3].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1">
                {t('ops.bench_label_minutes')}
                <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} disabled={!!run} className="bg-neutral-800 rounded px-2 py-1">
                  {DURATIONS.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1">
                {t('ops.bench_label_seed')}
                <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} disabled={!!run} className="bg-neutral-800 rounded px-2 py-1 w-20" />
              </label>
              <label className="flex items-center gap-1">
                {t('ops.bench_label_pace')}
                <select value={pace} onChange={(e) => setPace(e.target.value as BenchPace)} disabled={!!run} className="bg-neutral-800 rounded px-2 py-1">
                  <option value="realistic">{t('ops.bench_pace_realistic')}</option>
                  <option value="fast">{t('ops.bench_pace_fast')}</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={showTimer} onChange={(e) => setShowTimer(e.target.checked)} />
                {t('ops.bench_detection_timer')}
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={autoSchedule} onChange={(e) => setAutoSchedule(e.target.checked)} disabled={!!run} />
                {t('ops.bench_automatic_faults')}
              </label>
              {run ? (
                <button type="button" onClick={stopRun} className="min-h-[44px] px-4 rounded-xl bg-red-700 font-bold">
                  {t('ops.bench_end_run')}
                </button>
              ) : (
                <button type="button" onClick={startRun} className="min-h-[44px] px-4 rounded-xl bg-emerald-700 font-bold">
                  {t('ops.bench_start_run')}
                </button>
              )}
              <button type="button" onClick={() => setShowControls(false)} className="min-h-[44px] px-3 rounded-xl bg-neutral-800">
                {t('ops.bench_camera_view')}
              </button>
            </div>
          </div>
          {error && <div className="max-w-7xl mx-auto mt-2 text-red-300 text-sm">{t('ops.bench_start_error')}</div>}
          {truthFailures > 0 && (
            <div className="max-w-7xl mx-auto mt-2 text-amber-300 text-sm">
              {t('ops.bench_truth_failures', { n: truthFailures })}
            </div>
          )}
        </header>
      )}

      <main className="flex-1 relative flex items-center justify-center p-4 pt-24" onDoubleClick={() => setShowControls(true)}>
        {/* Run clock: used to line up a recorded video with the ground truth */}
        <div className="absolute top-3 right-3 bg-black border border-neutral-700 rounded-xl px-4 py-2 text-right">
          <div className="text-[11px] font-mono text-neutral-400">{run ? `RUN ${run.id.slice(-6).toUpperCase()}` : 'NO RUN'}</div>
          <div className="font-mono text-3xl font-bold tabular-nums text-emerald-400" data-testid="run-clock">
            {run ? formatRunClock(clockS) : '--:--:--'}
          </div>
        </div>
        <div className={`grid gap-4 w-full max-w-7xl ${machineCount === 1 ? 'grid-cols-1' : machineCount === 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 lg:grid-cols-3'}`}>
          {visible.map((m) => (
            <MachinePanel
              key={m.slot}
              m={m}
              showControls={showControls && !run?.auto}
              onSet={applyState}
              detection={detections[m.slot]}
              showTimer={showTimer}
              now={nowMs}
            />
          ))}
        </div>
        {showTimer && seenTimes.length > 0 && (
          <div className="absolute top-3 left-3 bg-black border border-neutral-700 rounded-xl px-4 py-2" data-testid="detection-summary">
            <div className="text-[11px] font-mono text-neutral-400">{t('ops.bench_summary_title')} · HOME RIG</div>
            <div className="font-mono text-xl font-bold tabular-nums text-emerald-400">
              {t(seenTimes.length === 1 ? 'ops.bench_summary_median_one' : 'ops.bench_summary_median_other', {
                s: median(seenTimes)?.toFixed(1) ?? '—',
                n: seenTimes.length,
              })}
            </div>
          </div>
        )}
        {!showControls && <div className="absolute bottom-3 left-3 text-[11px] text-neutral-600">{t('ops.bench_show_controls_hint')}</div>}
      </main>

      <footer className="text-center text-xs text-neutral-500 py-2">{t('ops.bench_footer', { rig: 'HOME RIG' })}</footer>
    </div>
  );
};

export default VirtualMachineScreen;
