import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { endSoakRun, postSoakTruth, startSoakRun } from '../lib/api';
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

const MachinePanel: React.FC<{
  m: BenchMachine;
  showControls: boolean;
  onSet: (slot: number, state: BenchState, alarm: string | null) => void;
}> = ({ m, showControls, onSet }) => {
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
      {showControls && (
        <div className="flex flex-wrap justify-center gap-2 w-full">
          <button type="button" onClick={() => onSet(m.slot, 'running', null)} className="min-h-[48px] px-4 rounded-xl bg-green-700 font-bold">
            Run
          </button>
          <button type="button" onClick={() => onSet(m.slot, 'idle', null)} className="min-h-[48px] px-4 rounded-xl bg-amber-700 font-bold">
            Idle
          </button>
          <select
            value={alarmPick}
            onChange={(e) => setAlarmPick(e.target.value)}
            aria-label={`Alarm for ${m.name}`}
            className="min-h-[48px] rounded-xl bg-neutral-800 border border-neutral-700 px-2 text-sm"
          >
            {BENCH_ALARMS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <button type="button" onClick={() => onSet(m.slot, 'stopped', alarmPick)} className="min-h-[48px] px-4 rounded-xl bg-red-700 font-bold">
            Stop + alarm
          </button>
        </div>
      )}
    </div>
  );
};

export const VirtualMachineScreen: React.FC = () => {
  const navigate = useNavigate();
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
  const [error, setError] = useState<string | null>(null);
  const [truthFailures, setTruthFailures] = useState(0);
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

  const startRun = async () => {
    setError(null);
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
      setError('Could not start the run. Check that you are signed in and online.');
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
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => navigate('/')} className="text-neutral-400 hover:text-white" aria-label="Back to home">
                <span className="material-symbols-outlined text-[24px]">arrow_back</span>
              </button>
              <img src={logoSvg} alt="TAKUMI" className="w-7 h-7" />
              <div>
                <div className="font-bold tracking-wide">Machine test bench</div>
                <div className="text-xs text-neutral-400">Point a camera at this screen and open Machine Watch on it</div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex items-center gap-1">
                Machines
                <select value={machineCount} onChange={(e) => setMachineCount(Number(e.target.value))} disabled={!!run} className="bg-neutral-800 rounded px-2 py-1">
                  {[1, 2, 3].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1">
                Minutes
                <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} disabled={!!run} className="bg-neutral-800 rounded px-2 py-1">
                  {DURATIONS.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1">
                Seed
                <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} disabled={!!run} className="bg-neutral-800 rounded px-2 py-1 w-20" />
              </label>
              <label className="flex items-center gap-1">
                Pace
                <select value={pace} onChange={(e) => setPace(e.target.value as BenchPace)} disabled={!!run} className="bg-neutral-800 rounded px-2 py-1">
                  <option value="realistic">Realistic</option>
                  <option value="fast">Fast (x10)</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={autoSchedule} onChange={(e) => setAutoSchedule(e.target.checked)} disabled={!!run} />
                Automatic faults
              </label>
              {run ? (
                <button type="button" onClick={stopRun} className="min-h-[44px] px-4 rounded-xl bg-red-700 font-bold">
                  End run
                </button>
              ) : (
                <button type="button" onClick={startRun} className="min-h-[44px] px-4 rounded-xl bg-emerald-700 font-bold">
                  Start soak run
                </button>
              )}
              <button type="button" onClick={() => setShowControls(false)} className="min-h-[44px] px-3 rounded-xl bg-neutral-800">
                Camera view
              </button>
            </div>
          </div>
          {error && <div className="max-w-7xl mx-auto mt-2 text-red-300 text-sm">{error}</div>}
          {truthFailures > 0 && (
            <div className="max-w-7xl mx-auto mt-2 text-amber-300 text-sm">
              {truthFailures} ground-truth events failed to save; this run's score will be incomplete.
            </div>
          )}
        </header>
      )}

      <main className="flex-1 relative flex items-center justify-center p-4" onDoubleClick={() => setShowControls(true)}>
        {/* Run clock: used to line up a recorded video with the ground truth */}
        <div className="absolute top-3 right-3 bg-black border border-neutral-700 rounded-xl px-4 py-2 text-right">
          <div className="text-[11px] font-mono text-neutral-400">{run ? `RUN ${run.id.slice(-6).toUpperCase()}` : 'NO RUN'}</div>
          <div className="font-mono text-3xl font-bold tabular-nums text-emerald-400" data-testid="run-clock">
            {run ? formatRunClock(clockS) : '--:--:--'}
          </div>
        </div>
        <div className={`grid gap-4 w-full max-w-7xl ${machineCount === 1 ? 'grid-cols-1' : machineCount === 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 lg:grid-cols-3'}`}>
          {visible.map((m) => (
            <MachinePanel key={m.slot} m={m} showControls={showControls && !run?.auto} onSet={applyState} />
          ))}
        </div>
        {!showControls && <div className="absolute bottom-3 left-3 text-[11px] text-neutral-600">Double-click to show controls</div>}
      </main>

      <footer className="text-center text-xs text-neutral-500 py-2">HOME RIG test bench, simulated machines</footer>
    </div>
  );
};

export default VirtualMachineScreen;
