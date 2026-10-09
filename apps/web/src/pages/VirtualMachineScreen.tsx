import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { startSoakRun, endSoakRun, postSoakTruth } from '../lib/api';
import logoSvg from '../assets/logo.svg';

interface VirtualMachineDef {
  id: string;
  name: string;
  type: string;
  lightOrder: string[];
  idealCycleS: number;
}

const MACHINES: VirtualMachineDef[] = [
  {
    id: 'mach_cnc_01',
    name: 'CNC Milling Center 1',
    type: 'Subtractive 5-Axis',
    lightOrder: ['red', 'yellow', 'green'],
    idealCycleS: 10,
  },
  {
    id: 'mach_pack_02',
    name: 'Packaging Cell 2',
    type: 'High-Speed Cartoner',
    lightOrder: ['red', 'yellow', 'green'],
    idealCycleS: 8,
  },
  {
    id: 'mach_asm_03',
    name: 'Assembly Station 3',
    type: 'Robotic Pick & Place',
    lightOrder: ['red', 'yellow', 'green'],
    idealCycleS: 15,
  },
];

const PRESET_ALARMS = [
  { code: 'E-101', text: 'E-STOP PRESSED [E-101]' },
  { code: 'E-204', text: 'DOOR INTERLOCK OPEN [E-204]' },
  { code: 'E-315', text: 'FEED JAM DETECTED [E-315]' },
  { code: 'E-402', text: 'SPINDLE OVERTEMP [E-402]' },
];

export const VirtualMachineScreen: React.FC = () => {
  const navigate = useNavigate();

  const [selectedMachineId, setSelectedMachineId] = useState<string>(MACHINES[0].id);
  const currentMachine = MACHINES.find((m) => m.id === selectedMachineId) || MACHINES[0];

  const [light, setLight] = useState<'red' | 'yellow' | 'green' | 'off'>('green');
  const [state, setState] = useState<'running' | 'idle' | 'stopped' | 'unknown'>('running');
  const [count, setCount] = useState<number>(42);
  const [alarmCode, setAlarmCode] = useState<string | null>(null);
  const [cycleProgress, setCycleProgress] = useState<number>(0);

  // Soak Test State
  const [isSoakActive, setIsSoakActive] = useState<boolean>(false);
  const [soakRunId, setSoakRunId] = useState<string | null>(null);
  const [soakSeed, setSoakSeed] = useState<number>(42);
  const [soakDurationMin, setSoakDurationMin] = useState<number>(15);
  const [runSeconds, setRunSeconds] = useState<number>(0);
  const [recentEvents, setRecentEvents] = useState<Array<{ text: string; time: string; type: string }>>([]);

  // Hardware controls
  const [wakeLockActive, setWakeLockActive] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Wake Lock Integration
  const requestWakeLock = useCallback(async () => {
    if ('wakeLock' in navigator) {
      try {
        const lock = await navigator.wakeLock.request('screen');
        wakeLockRef.current = lock;
        setWakeLockActive(true);
        lock.addEventListener('release', () => {
          setWakeLockActive(false);
          wakeLockRef.current = null;
        });
      } catch (err) {
        console.warn('Wake Lock request failed:', err);
        setWakeLockActive(false);
      }
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
      } catch {
        // ignore
      }
      wakeLockRef.current = null;
      setWakeLockActive(false);
    }
  }, []);

  useEffect(() => {
    requestWakeLock();
    return () => {
      releaseWakeLock();
    };
  }, [requestWakeLock, releaseWakeLock]);

  // Fullscreen Toggle
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  // Log truth event helper
  const emitTruthEvent = useCallback(
    async (
      eventType: 'state_change' | 'alarm' | 'alarm_cleared' | 'count',
      newState: string | null,
      newLight: string | null,
      newCount: number | null,
      newAlarm: string | null
    ) => {
      const nowStr = new Date().toLocaleTimeString();
      const eventDesc =
        eventType === 'state_change'
          ? `State -> ${newState?.toUpperCase()} (${newLight?.toUpperCase()})`
          : eventType === 'alarm'
          ? `Alarm -> ${newAlarm}`
          : eventType === 'alarm_cleared'
          ? 'Alarm cleared'
          : `Parts Count -> ${newCount}`;

      setRecentEvents((prev) => [
        { text: eventDesc, time: nowStr, type: eventType },
        ...prev.slice(0, 9),
      ]);

      if (soakRunId) {
        try {
          await postSoakTruth(soakRunId, {
            machine_id: currentMachine.id,
            event_type: eventType,
            state: newState,
            count: newCount,
            alarm_code: newAlarm,
          });
        } catch (err) {
          console.warn('Failed to stream truth event:', err);
        }
      }
    },
    [soakRunId, currentMachine.id]
  );

  // Manual Controls
  const setMachineLight = (color: 'red' | 'yellow' | 'green' | 'off') => {
    setLight(color);
    let st: 'running' | 'idle' | 'stopped' | 'unknown' = 'unknown';
    if (color === 'green') st = 'running';
    else if (color === 'yellow') st = 'idle';
    else if (color === 'red') st = 'stopped';
    else st = 'stopped';
    setState(st);

    if (color !== 'red') {
      setAlarmCode(null);
    }
    emitTruthEvent('state_change', st, color, count, color === 'red' ? alarmCode : null);
  };

  const handleManualAlarm = (text: string | null) => {
    setAlarmCode(text);
    if (text) {
      setLight('red');
      setState('stopped');
      emitTruthEvent('alarm', 'stopped', 'red', count, text);
    } else if (alarmCode) {
      emitTruthEvent('alarm_cleared', state, light, count, null);
    }
  };

  const handleIncrementCount = (delta: number) => {
    setCount((prev) => {
      const next = Math.max(0, prev + delta);
      emitTruthEvent('count', state, light, next, alarmCode);
      return next;
    });
  };

  const handleResetCount = () => {
    setCount(0);
    emitTruthEvent('count', state, light, 0, alarmCode);
  };

  // Start / End Soak Runs
  const handleStartSoak = async () => {
    try {
      const run = await startSoakRun({
        duration_min: soakDurationMin,
        schedule_seed: soakSeed,
        machines: [currentMachine.id],
      });
      setSoakRunId(run.id);
      setIsSoakActive(true);
      setRunSeconds(0);
      emitTruthEvent('state_change', state, light, count, alarmCode);
    } catch (err) {
      console.error('Failed to start soak run:', err);
      alert('Failed to start soak run. Check permissions or network.');
    }
  };

  const handleStopSoak = useCallback(async () => {
    if (soakRunId) {
      try {
        await endSoakRun(soakRunId);
      } catch (err) {
        console.warn('Failed to end soak run:', err);
      }
    }
    setIsSoakActive(false);
    setSoakRunId(null);
  }, [soakRunId]);

  // Deterministic Soak Schedule & Clock Engine
  useEffect(() => {
    const timer = setInterval(() => {
      if (isSoakActive) {
        setRunSeconds((s) => {
          const nextSec = s + 1;
          if (nextSec >= soakDurationMin * 60) {
            handleStopSoak();
            return nextSec;
          }

          // Deterministic phase generation based on seed and elapsed seconds
          const phasePeriod = 120;
          const cycleSec = (nextSec + soakSeed * 7) % phasePeriod;

          if (cycleSec === 0) {
            // Transition: Green / Running
            setLight('green');
            setState('running');
            setAlarmCode(null);
            emitTruthEvent('state_change', 'running', 'green', count, null);
          } else if (cycleSec === 45) {
            // Transition: Yellow / Idle
            setLight('yellow');
            setState('idle');
            setAlarmCode(null);
            emitTruthEvent('state_change', 'idle', 'yellow', count, null);
          } else if (cycleSec === 65) {
            // Transition: Green / Running
            setLight('green');
            setState('running');
            setAlarmCode(null);
            emitTruthEvent('state_change', 'running', 'green', count, null);
          } else if (cycleSec === 95) {
            // Transition: Red / Stopped with Alarm
            setLight('red');
            setState('stopped');
            const alarmMsg = PRESET_ALARMS[soakSeed % PRESET_ALARMS.length].text;
            setAlarmCode(alarmMsg);
            emitTruthEvent('alarm', 'stopped', 'red', count, alarmMsg);
          }

          // Counter increment during running state
          if (state === 'running' && nextSec % currentMachine.idealCycleS === 0) {
            setCount((c) => {
              const nc = c + 1;
              emitTruthEvent('count', 'running', 'green', nc, null);
              return nc;
            });
          }

          return nextSec;
        });
      }

      // Live cycle progress animation
      if (state === 'running') {
        setCycleProgress((prev) => (prev >= 100 ? 0 : prev + 100 / currentMachine.idealCycleS));
      } else {
        setCycleProgress(0);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [
    isSoakActive,
    soakDurationMin,
    soakSeed,
    state,
    count,
    currentMachine.idealCycleS,
    emitTruthEvent,
    handleStopSoak,
  ]);

  // Format Run Clock HH:MM:SS
  const formatRunClock = (totalSec: number) => {
    const hrs = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const mins = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const secs = String(totalSec % 60).padStart(2, '0');
    return `${hrs}:${mins}:${secs}`;
  };

  return (
    <div className="bg-neutral-950 text-neutral-100 min-h-screen flex flex-col font-sans select-none antialiased">
      {/* Top Bar */}
      <header className="bg-neutral-900 border-b border-neutral-800 px-4 py-3 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="text-neutral-400 hover:text-white transition-colors"
              title="Return to Home"
            >
              <span className="material-symbols-outlined text-[24px]">arrow_back</span>
            </button>
            <img src={logoSvg} alt="TAKUMI" className="w-7 h-7 object-contain" />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[17px] font-bold tracking-wide text-white">
                  TAKUMI VIRTUAL RIG
                </span>
                <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                  PILLAR 3
                </span>
              </div>
              <p className="text-xs text-neutral-400">
                Deterministic Edge & Vision Test Bench
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Screen Wake Status */}
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-medium border ${
                wakeLockActive
                  ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                  : 'bg-neutral-800 border-neutral-700 text-neutral-400'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">
                {wakeLockActive ? 'screen_lock_portrait' : 'screen_lock_rotation'}
              </span>
              <span>{wakeLockActive ? 'Screen Awake' : 'No Wake Lock'}</span>
            </div>

            {/* Fullscreen Toggle */}
            <button
              type="button"
              onClick={toggleFullscreen}
              className="w-9 h-9 rounded-lg bg-neutral-800 border border-neutral-700 text-neutral-300 hover:text-white flex items-center justify-center transition-colors"
              title="Toggle Fullscreen for Rig Monitor"
            >
              <span className="material-symbols-outlined text-[20px]">
                {isFullscreen ? 'fullscreen_exit' : 'fullscreen'}
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Machine Rig Interface */}
      <main className="flex-1 max-w-7xl mx-auto w-full p-4 lg:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Visual Rig (Stack Light + HMI + Counter) */}
        <section className="lg:col-span-8 flex flex-col gap-6">
          {/* Machine Header & Selector */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <span className="text-xs font-mono text-neutral-400 uppercase tracking-wider">
                Active Cell
              </span>
              <h1 className="text-xl font-bold text-white flex items-center gap-2">
                {currentMachine.name}
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-neutral-800 text-neutral-400 font-normal">
                  {currentMachine.id}
                </span>
              </h1>
            </div>

            <div className="flex items-center gap-2">
              {MACHINES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelectedMachineId(m.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                    selectedMachineId === m.id
                      ? 'bg-neutral-100 text-neutral-900 shadow'
                      : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
                  }`}
                >
                  {m.name.split(' ')[0]}
                </button>
              ))}
            </div>
          </div>

          {/* Industrial RIG Display Box */}
          <div className="relative bg-gradient-to-b from-neutral-900 to-neutral-950 border-2 border-neutral-800 rounded-3xl p-6 sm:p-8 shadow-2xl flex flex-col md:flex-row items-center justify-around gap-8 min-h-[440px]">
            {/* Prominent Soak Run Clock (Corner Overlay) */}
            <div className="absolute top-4 right-4 bg-neutral-950/90 border border-neutral-700/80 rounded-xl px-4 py-2 flex flex-col items-end shadow-lg backdrop-blur-md">
              <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-400">
                {isSoakActive ? `RUN CLOCK (${soakRunId?.slice(0, 8)}...)` : 'TEST CLOCK'}
              </span>
              <span
                data-testid="virtual-run-clock"
                className={`font-mono text-2xl sm:text-3xl font-extrabold tracking-widest ${
                  isSoakActive ? 'text-emerald-400 animate-pulse' : 'text-neutral-500'
                }`}
              >
                {formatRunClock(runSeconds)}
              </span>
            </div>

            {/* Stack Light Segment */}
            <div className="flex flex-col items-center">
              <span className="text-xs font-mono text-neutral-400 mb-2 font-bold">
                PATLITE STACK
              </span>
              {/* Stack housing */}
              <div className="w-24 sm:w-28 bg-neutral-900 rounded-2xl p-2.5 border-4 border-neutral-800 shadow-2xl flex flex-col gap-2">
                {/* Red Light */}
                <div
                  data-testid="stack-light-red"
                  className={`w-full h-20 rounded-xl transition-all duration-300 flex items-center justify-center border ${
                    light === 'red'
                      ? 'bg-red-500 border-red-300 shadow-[0_0_35px_rgba(239,68,68,0.95)] animate-pulse'
                      : 'bg-red-950/30 border-red-950/40'
                  }`}
                >
                  {light === 'red' && (
                    <span className="w-8 h-8 rounded-full bg-red-200/40 blur-xs" />
                  )}
                </div>

                {/* Yellow Light */}
                <div
                  data-testid="stack-light-yellow"
                  className={`w-full h-20 rounded-xl transition-all duration-300 flex items-center justify-center border ${
                    light === 'yellow'
                      ? 'bg-amber-400 border-amber-200 shadow-[0_0_35px_rgba(251,191,36,0.95)]'
                      : 'bg-amber-950/30 border-amber-950/40'
                  }`}
                >
                  {light === 'yellow' && (
                    <span className="w-8 h-8 rounded-full bg-amber-100/40 blur-xs" />
                  )}
                </div>

                {/* Green Light */}
                <div
                  data-testid="stack-light-green"
                  className={`w-full h-20 rounded-xl transition-all duration-300 flex items-center justify-center border ${
                    light === 'green'
                      ? 'bg-emerald-400 border-emerald-200 shadow-[0_0_35px_rgba(52,211,153,0.95)]'
                      : 'bg-emerald-950/30 border-emerald-950/40'
                  }`}
                >
                  {light === 'green' && (
                    <span className="w-8 h-8 rounded-full bg-emerald-100/40 blur-xs" />
                  )}
                </div>
              </div>
              {/* Mounting Pole */}
              <div className="w-5 h-20 bg-gradient-to-r from-neutral-700 via-neutral-600 to-neutral-800 border-x border-neutral-700" />
              {/* Base */}
              <div className="w-20 h-4 bg-neutral-800 rounded-b-xl border border-neutral-700" />
            </div>

            {/* Industrial HMI Screen & Counter */}
            <div className="flex-1 max-w-md w-full flex flex-col gap-5">
              {/* Monospace 7-Segment Digital Parts Counter */}
              <div className="bg-neutral-950 border-2 border-neutral-800 rounded-2xl p-4 shadow-inner flex flex-col items-center">
                <div className="w-full flex items-center justify-between text-xs font-mono text-neutral-400 mb-1">
                  <span>OMRON PARTS COUNTER</span>
                  <span className="text-amber-500 font-bold">DIGITAL PULSE</span>
                </div>
                <div
                  data-testid="virtual-counter-display"
                  className="font-mono text-5xl sm:text-6xl font-black tracking-widest text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] py-2 select-all"
                >
                  {String(count).padStart(5, '0')}
                </div>
                {/* Cycle Timer Progress Bar */}
                <div className="w-full bg-neutral-900 h-2 rounded-full overflow-hidden mt-1 border border-neutral-800">
                  <div
                    className="h-full bg-amber-400 transition-all duration-200"
                    style={{ width: `${Math.min(100, cycleProgress)}%` }}
                  />
                </div>
              </div>

              {/* HMI Message Terminal */}
              <div className="bg-neutral-950 border-2 border-neutral-800 rounded-2xl p-5 shadow-inner flex flex-col gap-3 font-mono">
                <div className="flex items-center justify-between border-b border-neutral-800 pb-2">
                  <span className="text-xs text-neutral-400">PRO-FACE HMI TERMINAL</span>
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded ${
                      state === 'running'
                        ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/40'
                        : state === 'idle'
                        ? 'bg-amber-950 text-amber-400 border border-amber-500/40'
                        : 'bg-red-950 text-red-400 border border-red-500/40'
                    }`}
                  >
                    STATUS: {state.toUpperCase()}
                  </span>
                </div>

                {/* Alarm Line */}
                <div className="p-3 bg-neutral-900 rounded-xl border border-neutral-800 min-h-[58px] flex items-center">
                  {alarmCode ? (
                    <div className="text-red-400 font-bold flex items-center gap-2 animate-pulse">
                      <span className="material-symbols-outlined text-[20px]">warning</span>
                      <span data-testid="virtual-alarm-text">{alarmCode}</span>
                    </div>
                  ) : (
                    <div className="text-neutral-400 flex items-center gap-2">
                      <span className="material-symbols-outlined text-[18px] text-emerald-400">
                        check_circle
                      </span>
                      <span>SYSTEM NORMAL (NO ACTIVE ALARM)</span>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs text-neutral-400 pt-1">
                  <div>
                    CYCLE TIME:{' '}
                    <span className="text-neutral-200 font-bold">
                      {currentMachine.idealCycleS.toFixed(1)}s
                    </span>
                  </div>
                  <div>
                    STATE: <span className="text-neutral-200 font-bold">{state.toUpperCase()}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Right Column: Controls, Soak Scheduler & Event Stream */}
        <section className="lg:col-span-4 flex flex-col gap-6">
          {/* Mode Tabs: Manual vs Soak */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-5 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-300">
                Rig Simulator Controls
              </h2>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-neutral-800 text-neutral-400">
                {isSoakActive ? 'SOAK ACTIVE' : 'MANUAL'}
              </span>
            </div>

            {/* Manual Light Toggles */}
            <div className="space-y-2">
              <span className="text-xs font-mono text-neutral-400">Stack Light Override</span>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setMachineLight('green')}
                  className={`py-2 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition-all ${
                    light === 'green'
                      ? 'bg-emerald-500 text-neutral-950 font-black shadow-lg shadow-emerald-500/20'
                      : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                  <span>Green (Run)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setMachineLight('yellow')}
                  className={`py-2 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition-all ${
                    light === 'yellow'
                      ? 'bg-amber-400 text-neutral-950 font-black shadow-lg shadow-amber-400/20'
                      : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                  <span>Yellow (Idle)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setMachineLight('red')}
                  className={`py-2 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition-all ${
                    light === 'red'
                      ? 'bg-red-500 text-neutral-950 font-black shadow-lg shadow-red-500/20'
                      : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
                  <span>Red (Stop)</span>
                </button>
              </div>
            </div>

            {/* Counter Controls */}
            <div className="space-y-2">
              <span className="text-xs font-mono text-neutral-400">Parts Counter Override</span>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => handleIncrementCount(1)}
                  className="py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-bold rounded-xl transition-all"
                >
                  +1 Part
                </button>
                <button
                  type="button"
                  onClick={() => handleIncrementCount(10)}
                  className="py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-bold rounded-xl transition-all"
                >
                  +10 Parts
                </button>
                <button
                  type="button"
                  onClick={handleResetCount}
                  className="py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-red-400 text-xs font-bold rounded-xl transition-all"
                >
                  Reset (0)
                </button>
              </div>
            </div>

            {/* Manual Alarms Trigger */}
            <div className="space-y-2">
              <span className="text-xs font-mono text-neutral-400">Trigger HMI Alarms</span>
              <div className="grid grid-cols-2 gap-2">
                {PRESET_ALARMS.map((alarm) => (
                  <button
                    key={alarm.code}
                    type="button"
                    onClick={() => handleManualAlarm(alarm.text)}
                    className="py-2 px-2.5 bg-neutral-800 hover:bg-red-950/60 hover:text-red-300 text-neutral-300 text-[11px] font-bold rounded-xl truncate text-left border border-neutral-700/60 transition-all"
                  >
                    {alarm.code}: {alarm.text.split(' ')[0]}
                  </button>
                ))}
              </div>
              {alarmCode && (
                <button
                  type="button"
                  onClick={() => handleManualAlarm(null)}
                  className="w-full py-2 bg-emerald-950/60 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-900/60 text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-1.5"
                >
                  <span className="material-symbols-outlined text-[16px]">check</span>
                  <span>Clear Active Alarm</span>
                </button>
              )}
            </div>
          </div>

          {/* Soak Test Runner Card */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-5 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-300">
                Deterministic Soak Test
              </h2>
              <span className="material-symbols-outlined text-neutral-400 text-[18px]">
                science
              </span>
            </div>

            {!isSoakActive ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-mono text-neutral-400 block mb-1">
                      Duration
                    </label>
                    <select
                      value={soakDurationMin}
                      onChange={(e) => setSoakDurationMin(Number(e.target.value))}
                      className="w-full bg-neutral-950 border border-neutral-800 text-neutral-200 text-xs rounded-xl p-2 font-mono"
                    >
                      <option value={5}>5 min</option>
                      <option value={15}>15 min</option>
                      <option value={30}>30 min</option>
                      <option value={60}>60 min</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-mono text-neutral-400 block mb-1">
                      Seed
                    </label>
                    <input
                      type="number"
                      value={soakSeed}
                      onChange={(e) => setSoakSeed(Number(e.target.value))}
                      className="w-full bg-neutral-950 border border-neutral-800 text-neutral-200 text-xs rounded-xl p-2 font-mono"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleStartSoak}
                  className="w-full py-3 bg-emerald-500 text-neutral-950 font-extrabold text-sm rounded-xl hover:brightness-110 active:scale-[0.99] transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-[18px]">play_arrow</span>
                  <span>Start Soak Run</span>
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="p-3 bg-neutral-950 border border-emerald-500/40 rounded-xl font-mono text-xs text-neutral-300 space-y-1">
                  <div>
                    RUN ID: <span className="text-emerald-400 font-bold">{soakRunId}</span>
                  </div>
                  <div>
                    ELAPSED:{' '}
                    <span className="text-white font-bold">{formatRunClock(runSeconds)}</span> /{' '}
                    {soakDurationMin}m
                  </div>
                  <div>
                    SEED: <span className="text-neutral-200 font-bold">{soakSeed}</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleStopSoak}
                  className="w-full py-3 bg-red-500 text-neutral-950 font-extrabold text-sm rounded-xl hover:brightness-110 active:scale-[0.99] transition-all shadow-lg shadow-red-500/20 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-[18px]">stop</span>
                  <span>Stop Soak Run</span>
                </button>
              </div>
            )}
          </div>

          {/* Truth Event Stream Log */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-5 flex flex-col gap-3 flex-1 min-h-[180px]">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold text-neutral-400 uppercase tracking-wider">
                Ground Truth Stream
              </span>
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            </div>

            <div className="space-y-1.5 overflow-y-auto max-h-[220px] font-mono text-xs">
              {recentEvents.length === 0 ? (
                <p className="text-neutral-500 italic py-2">No state events recorded yet.</p>
              ) : (
                recentEvents.map((ev, idx) => (
                  <div
                    key={idx}
                    className="p-2 rounded-lg bg-neutral-950/80 border border-neutral-800 flex items-center justify-between gap-2"
                  >
                    <span className="text-neutral-200 truncate">{ev.text}</span>
                    <span className="text-[10px] text-neutral-500 shrink-0">{ev.time}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default VirtualMachineScreen;
