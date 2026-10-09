import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  createMachine,
  fetchMachines,
  fetchMySoakRuns,
  readMachine,
  setupMachine,
  type Machine,
  type NormalizedRoi,
  type SoakRun,
} from '../lib/api';
import { RateCap, RegionChange, StableValue, roiToPixels, stackLightLit, type Roi } from '../lib/machineVision';
import { MACHINE_WATCH } from '../config';

/**
 * Machine Watch (P17): a fixed camera (old phone or webcam) watches stack lights, counters and HMI
 * screens. Gemini Robotics-ER finds the regions once; the browser then checks them every 500 ms for
 * free and only asks Gemini Flash-Lite to read a machine when something changed. Only small region
 * crops ever leave the device.
 */

type RoiKind = 'stack_light' | 'counter' | 'hmi';
const ROI_KINDS: RoiKind[] = ['stack_light', 'counter', 'hmi'];
const ROI_COLOUR: Record<RoiKind, string> = { stack_light: '#22c55e', counter: '#38bdf8', hmi: '#c084fc' };
const ROI_LABEL: Record<RoiKind, string> = { stack_light: 'light', counter: 'counter', hmi: 'screen' };

interface DraftMachine {
  name: string;
  idealCycleS: number;
  rois: Partial<Record<RoiKind, NormalizedRoi>>;
}

interface Watcher {
  light: StableValue<string>;
  counter: RegionChange;
  hmi: RegionChange;
  cap: RateCap;
  inFlight: boolean;
  lastReadAt: number;
  lastCounterReadAt: number;
  counterPending: boolean;
  reads: number;
  startedAt: number;
}

interface MachineView {
  edgeLight: string;
  state: string | null;
  count: number | null;
  alarm: string | null;
  lastReadAt: number | null;
  readsPerHour: number;
  error: string | null;
}

const STORAGE_KEY = 'takumi.machineWatch.selected';

function loadSelected(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveSelected(ids: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Remembering the selection is a convenience only.
  }
}

function parseOffset(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

export const MachineWatchScreen: React.FC = () => {
  const navigate = useNavigate();
  const debug = useMemo(() => new URLSearchParams(window.location.search).get('debug') === '1', []);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameCanvas = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [source, setSource] = useState<'camera' | 'file' | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const [machines, setMachines] = useState<Machine[]>([]);
  const [selected, setSelected] = useState<string[]>(loadSelected);
  const [runs, setRuns] = useState<SoakRun[]>([]);
  const [runId, setRunId] = useState('');
  const [offsetText, setOffsetText] = useState('');

  const [mode, setMode] = useState<'idle' | 'setup' | 'watching'>('idle');
  const [setupFrame, setSetupFrame] = useState<string | null>(null);
  const [setupCount, setSetupCount] = useState(1);
  const [benchMachines, setBenchMachines] = useState(false);
  const [drafts, setDrafts] = useState<DraftMachine[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const watchersRef = useRef<Record<string, Watcher>>({});
  const [views, setViews] = useState<Record<string, MachineView>>({});

  const watched = useMemo(() => machines.filter((m) => selected.includes(m.id)), [machines, selected]);

  const refreshLists = useCallback(async () => {
    try {
      const [ms, rs] = await Promise.all([fetchMachines(), fetchMySoakRuns()]);
      setMachines(ms);
      setRuns(rs);
    } catch {
      setMessage('Could not load machines. Check that you are signed in.');
    }
  }, []);

  useEffect(() => {
    refreshLists();
  }, [refreshLists]);

  useEffect(() => saveSelected(selected), [selected]);

  // Keep the screen awake: a phone that locks stops watching.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    if (mode === 'watching' && 'wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then((l) => (lock = l)).catch(() => {});
    }
    return () => {
      lock?.release().catch(() => {});
    };
  }, [mode]);

  const stopSource = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => stopSource, []);

  const startCamera = async () => {
    setSourceError(null);
    stopSource();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setSource('camera');
    } catch {
      setSourceError('Camera not available. Allow camera access and try again.');
    }
  };

  const startFile = async (file: File) => {
    stopSource();
    if (!videoRef.current) return;
    videoRef.current.srcObject = null;
    videoRef.current.src = URL.createObjectURL(file);
    videoRef.current.loop = false;
    await videoRef.current.play().catch(() => {});
    setSource('file');
  };

  /** Draws the current video frame into the working canvas (max 1280 px wide) and returns its context. */
  const grabFrame = (): CanvasRenderingContext2D | null => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return null;
    if (!frameCanvas.current) frameCanvas.current = document.createElement('canvas');
    const scale = Math.min(1, 1280 / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    const c = frameCanvas.current;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx?.drawImage(video, 0, 0, w, h);
    return ctx;
  };

  const cropBlock = (ctx: CanvasRenderingContext2D, roi: Roi) => {
    const p = roiToPixels(roi, ctx.canvas.width, ctx.canvas.height);
    return ctx.getImageData(p.x, p.y, p.w, p.h);
  };

  const cropJpegB64 = (ctx: CanvasRenderingContext2D, roi: Roi): string => {
    const p = roiToPixels(roi, ctx.canvas.width, ctx.canvas.height);
    const scale = Math.min(1, MACHINE_WATCH.cropMaxPx / Math.max(p.w, p.h));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(p.w * scale));
    out.height = Math.max(1, Math.round(p.h * scale));
    out.getContext('2d')?.drawImage(ctx.canvas, p.x, p.y, p.w, p.h, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.85).split(',')[1];
  };

  // ---------- Setup ----------

  const beginSetup = async () => {
    const ctx = grabFrame();
    if (!ctx) {
      setMessage('Start the camera (or a video) first.');
      return;
    }
    const frame = ctx.canvas.toDataURL('image/jpeg', 0.9);
    setSetupFrame(frame);
    setMode('setup');
    setMessage(null);
    const b64 = frame.split(',')[1];
    const next: DraftMachine[] = [];
    for (let i = 1; i <= setupCount; i++) {
      setBusy(`Finding machine ${i} of ${setupCount} with Gemini…`);
      const name = benchMachines ? ['CNC Mill 1', 'Press 2', 'Packer 3'][i - 1] ?? `Machine ${i}` : `Machine ${i}`;
      try {
        const res = await setupMachine(b64, { machine_count: setupCount, machine_index: i });
        next.push({
          name,
          idealCycleS: 10,
          rois: { stack_light: res.rois.stack_light, counter: res.rois.counter ?? undefined, hmi: res.rois.hmi ?? undefined },
        });
      } catch (e) {
        const detail = e instanceof ApiError ? e.message : 'Setup failed.';
        setMessage(`Machine ${i}: ${detail} Drag the box to the stack light by hand.`);
        next.push({ name, idealCycleS: 10, rois: { stack_light: { x: 0.1 + 0.3 * (i - 1), y: 0.1, w: 0.1, h: 0.3 } } });
      }
    }
    setDrafts(next);
    setBusy(null);
  };

  const saveSetup = async () => {
    setBusy('Saving…');
    try {
      const created: Machine[] = [];
      for (const [i, d] of drafts.entries()) {
        if (!d.rois.stack_light) continue;
        created.push(
          await createMachine({
            name: d.name.trim() || `Machine ${i + 1}`,
            rois: { stack_light: d.rois.stack_light, counter: d.rois.counter ?? null, hmi: d.rois.hmi ?? null },
            ideal_cycle_s: d.idealCycleS,
            source: benchMachines ? 'VIRTUAL' : 'LIVE',
            bench_slot: benchMachines ? i + 1 : null,
          })
        );
      }
      await refreshLists();
      setSelected(created.map((m) => m.id));
      setMode('idle');
      setSetupFrame(null);
      setMessage(`Saved ${created.length} machine(s). Press Start watching.`);
    } catch {
      setMessage('Could not save the machines.');
    } finally {
      setBusy(null);
    }
  };

  // Drag to move a box; drag its corner to resize.
  const dragRef = useRef<{ idx: number; kind: RoiKind; resize: boolean; startX: number; startY: number; roi: NormalizedRoi } | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const onPointerDown = (e: React.PointerEvent, idx: number, kind: RoiKind, resize: boolean) => {
    const roi = drafts[idx]?.rois[kind];
    if (!roi) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { idx, kind, resize, startX: e.clientX, startY: e.clientY, roi: { ...roi } };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const box = overlayRef.current?.getBoundingClientRect();
    if (!d || !box) return;
    const dx = (e.clientX - d.startX) / box.width;
    const dy = (e.clientY - d.startY) / box.height;
    const roi = d.resize
      ? { ...d.roi, w: clamp01(Math.max(0.02, d.roi.w + dx)), h: clamp01(Math.max(0.02, d.roi.h + dy)) }
      : { ...d.roi, x: clamp01(d.roi.x + dx), y: clamp01(d.roi.y + dy) };
    roi.w = Math.min(roi.w, 1 - roi.x);
    roi.h = Math.min(roi.h, 1 - roi.y);
    setDrafts((prev) => prev.map((m, i) => (i === d.idx ? { ...m, rois: { ...m.rois, [d.kind]: roi } } : m)));
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  // ---------- Watching ----------

  const doRead = useCallback(
    async (m: Machine, ctx: CanvasRenderingContext2D, reason: 'change' | 'heartbeat') => {
      const w = watchersRef.current[m.id];
      if (!w || w.inFlight) return;
      w.inFlight = true;
      const now = Date.now();
      w.lastReadAt = now;
      if (m.rois.counter) {
        w.lastCounterReadAt = now;
        w.counterPending = false;
      }
      const crops: { stack_light_b64?: string; counter_b64?: string; hmi_b64?: string } = {
        stack_light_b64: cropJpegB64(ctx, m.rois.stack_light),
      };
      if (m.rois.counter) crops.counter_b64 = cropJpegB64(ctx, m.rois.counter);
      if (m.rois.hmi) crops.hmi_b64 = cropJpegB64(ctx, m.rois.hmi);
      const video = videoRef.current;
      const offset = parseOffset(offsetText);
      const videoRunS = source === 'file' && video && offset !== null ? Math.max(0, video.currentTime - offset) : undefined;
      try {
        const res = await readMachine(m.id, {
          crops,
          reason,
          detected_by: 'gemini',
          soak_run_id: runId || undefined,
          video_run_s: videoRunS,
        });
        w.reads += 1;
        const hours = Math.max(1 / 60, (Date.now() - w.startedAt) / 3_600_000);
        setViews((prev) => ({
          ...prev,
          [m.id]: {
            ...(prev[m.id] ?? { edgeLight: 'off' }),
            state: res.state,
            count: res.count,
            alarm: res.alarm_text,
            lastReadAt: Date.now(),
            readsPerHour: w.reads / hours,
            error: null,
          },
        }));
      } catch (e) {
        const msg = e instanceof ApiError && e.status === 429 ? 'Read limit reached, waiting' : 'Read failed, will retry';
        setViews((prev) => ({ ...prev, [m.id]: { ...(prev[m.id] as MachineView), error: msg } }));
      } finally {
        w.inFlight = false;
      }
    },
    [offsetText, runId, source]
  );

  const startWatching = () => {
    if (!watched.length) {
      setMessage('Pick at least one machine (or set up new ones).');
      return;
    }
    const now = Date.now();
    watchersRef.current = Object.fromEntries(
      watched.map((m) => [
        m.id,
        {
          light: new StableValue<string>(MACHINE_WATCH.lightStableFrames),
          counter: new RegionChange(MACHINE_WATCH.regionDiffThreshold, MACHINE_WATCH.regionStableFrames),
          hmi: new RegionChange(MACHINE_WATCH.regionDiffThreshold, MACHINE_WATCH.regionStableFrames),
          cap: new RateCap(MACHINE_WATCH.maxReadsPerMinute, 60_000),
          inFlight: false,
          lastReadAt: 0,
          lastCounterReadAt: 0,
          counterPending: false,
          reads: 0,
          startedAt: now,
        },
      ])
    );
    setViews({});
    setMessage(null);
    setMode('watching');
  };

  useEffect(() => {
    if (mode !== 'watching') return;
    const timer = setInterval(() => {
      const ctx = grabFrame();
      if (!ctx) return;
      const now = Date.now();
      for (const m of watched) {
        const w = watchersRef.current[m.id];
        if (!w) continue;
        const lit = stackLightLit(cropBlock(ctx, m.rois.stack_light), m.light_order);
        const lightChanged = w.light.push(lit.light) !== undefined;
        const hmiChanged = m.rois.hmi ? w.hmi.push(cropBlock(ctx, m.rois.hmi)) : false;
        if (m.rois.counter && w.counter.push(cropBlock(ctx, m.rois.counter))) w.counterPending = true;
        setViews((prev) => (prev[m.id]?.edgeLight === lit.light ? prev : { ...prev, [m.id]: { ...(prev[m.id] ?? emptyView()), edgeLight: lit.light } }));

        let reason: 'change' | 'heartbeat' | null = null;
        if (w.lastReadAt === 0 || lightChanged || hmiChanged) reason = 'change';
        else if (w.counterPending && now - w.lastCounterReadAt > MACHINE_WATCH.counterReadEveryMs) reason = 'change';
        else if (now - w.lastReadAt > MACHINE_WATCH.heartbeatMs) reason = 'heartbeat';
        if (reason && !w.inFlight && w.cap.tryTake(now)) doRead(m, ctx, reason);
      }
    }, MACHINE_WATCH.frameIntervalMs);
    return () => clearInterval(timer);
  }, [mode, watched, doRead]);

  // ---------- Render ----------

  const toggle = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="min-h-screen bg-surface text-on-surface flex flex-col">
      <header className="px-4 py-3 border-b border-outline-variant flex items-center gap-3">
        <button type="button" onClick={() => navigate('/')} aria-label="Back to home" className="min-w-[44px] min-h-[44px]">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-bold">Machine Watch</h1>
          <p className="text-xs text-on-surface-variant">Only small crops of the light, counter and screen leave this device.</p>
        </div>
      </header>

      {source === 'file' && (
        <div className="bg-amber-500/20 text-amber-200 text-sm px-4 py-2" role="status">
          Simulated input: a recorded video file, not a live camera.
        </div>
      )}

      <main className="flex-1 grid lg:grid-cols-[1fr_380px] gap-4 p-4">
        <section className="flex flex-col gap-3 min-w-0">
          <div
            ref={overlayRef}
            className="relative bg-black rounded-2xl overflow-hidden aspect-video touch-none"
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <video ref={videoRef} className={`w-full h-full object-contain ${mode === 'setup' ? 'hidden' : ''}`} playsInline muted />
            {mode === 'setup' && setupFrame && <img src={setupFrame} alt="Setup frame" className="w-full h-full object-contain" />}
            {(mode === 'setup' ? drafts : []).map((d, idx) =>
              ROI_KINDS.map((kind) => {
                const r = d.rois[kind];
                if (!r) return null;
                return (
                  <div
                    key={`${idx}-${kind}`}
                    className="absolute border-2 cursor-move"
                    style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, borderColor: ROI_COLOUR[kind] }}
                    onPointerDown={(e) => onPointerDown(e, idx, kind, false)}
                  >
                    <span className="absolute -top-5 left-0 text-[11px] font-bold px-1 rounded" style={{ background: ROI_COLOUR[kind], color: '#000' }}>
                      M{idx + 1} {ROI_LABEL[kind]}
                    </span>
                    <span
                      className="absolute -right-2 -bottom-2 w-5 h-5 rounded-full border-2 border-white cursor-se-resize"
                      style={{ background: ROI_COLOUR[kind] }}
                      onPointerDown={(e) => onPointerDown(e, idx, kind, true)}
                    />
                  </div>
                );
              })
            )}
            {mode === 'watching' &&
              watched.map((m) =>
                ROI_KINDS.map((kind) => {
                  const r = m.rois[kind as keyof typeof m.rois] as NormalizedRoi | undefined;
                  if (!r) return null;
                  return (
                    <div
                      key={`${m.id}-${kind}`}
                      className="absolute border pointer-events-none"
                      style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, borderColor: ROI_COLOUR[kind] }}
                    />
                  );
                })
              )}
            {!source && (
              <div className="absolute inset-0 flex items-center justify-center text-on-surface-variant text-sm p-4 text-center">
                Mount the phone so the machines' lights, counters and screens are in view, then start the camera.
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={startCamera} className="min-h-[56px] px-5 rounded-xl bg-primary text-on-primary font-bold">
              Start camera
            </button>
            {debug && (
              <label className="min-h-[56px] px-5 rounded-xl bg-surface-container-high font-bold flex items-center cursor-pointer">
                Use video file
                <input type="file" accept="video/*" className="hidden" onChange={(e) => e.target.files?.[0] && startFile(e.target.files[0])} />
              </label>
            )}
            {mode === 'watching' ? (
              <button type="button" onClick={() => setMode('idle')} className="min-h-[56px] px-5 rounded-xl bg-red-700 text-white font-bold">
                Stop watching
              </button>
            ) : (
              <button type="button" onClick={startWatching} disabled={!source || mode === 'setup'} className="min-h-[56px] px-5 rounded-xl bg-emerald-700 text-white font-bold disabled:opacity-40">
                Start watching
              </button>
            )}
          </div>
          {sourceError && <p className="text-red-300 text-sm">{sourceError}</p>}
          {message && <p className="text-amber-200 text-sm" role="status">{message}</p>}
          {busy && <p className="text-on-surface-variant text-sm" role="status">{busy}</p>}
        </section>

        <aside className="flex flex-col gap-4">
          {mode === 'setup' ? (
            <div className="bg-surface-container rounded-2xl p-4 flex flex-col gap-3">
              <h2 className="font-bold">Check the boxes</h2>
              <p className="text-sm text-on-surface-variant">Drag a box to move it, drag its dot to resize. Green = light, blue = counter, purple = screen.</p>
              {drafts.map((d, i) => (
                <div key={i} className="flex flex-col gap-2 border-t border-outline-variant pt-2">
                  <label className="text-sm">
                    Name
                    <input
                      value={d.name}
                      onChange={(e) => setDrafts((p) => p.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                      className="w-full min-h-[44px] rounded-lg bg-surface-container-high px-2"
                    />
                  </label>
                  <label className="text-sm">
                    Ideal cycle time (seconds per part)
                    <input
                      type="number"
                      min={0.1}
                      step={0.1}
                      value={d.idealCycleS}
                      onChange={(e) => setDrafts((p) => p.map((x, j) => (j === i ? { ...x, idealCycleS: Number(e.target.value) || 10 } : x)))}
                      className="w-full min-h-[44px] rounded-lg bg-surface-container-high px-2"
                    />
                  </label>
                </div>
              ))}
              <div className="flex gap-2">
                <button type="button" onClick={saveSetup} disabled={!!busy} className="min-h-[56px] flex-1 rounded-xl bg-primary text-on-primary font-bold">
                  Save machines
                </button>
                <button type="button" onClick={() => setMode('idle')} className="min-h-[56px] px-4 rounded-xl bg-surface-container-high">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="bg-surface-container rounded-2xl p-4 flex flex-col gap-3">
                <h2 className="font-bold">Set up new machines</h2>
                <label className="text-sm flex items-center gap-2">
                  Machines in view
                  <select value={setupCount} onChange={(e) => setSetupCount(Number(e.target.value))} className="min-h-[44px] rounded-lg bg-surface-container-high px-2">
                    {[1, 2, 3].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <label className="text-sm flex items-center gap-2">
                  <input type="checkbox" checked={benchMachines} onChange={(e) => setBenchMachines(e.target.checked)} />
                  These are the test bench machines (HOME RIG)
                </label>
                <button type="button" onClick={beginSetup} disabled={!source || !!busy || mode === 'watching'} className="min-h-[56px] rounded-xl bg-surface-container-high font-bold disabled:opacity-40">
                  Find machines with Gemini
                </button>
              </div>

              <div className="bg-surface-container rounded-2xl p-4 flex flex-col gap-2">
                <h2 className="font-bold">Machines this camera watches</h2>
                {machines.length === 0 && <p className="text-sm text-on-surface-variant">No machines yet.</p>}
                {machines.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 text-sm min-h-[44px]">
                    <input type="checkbox" checked={selected.includes(m.id)} onChange={() => toggle(m.id)} disabled={mode === 'watching'} />
                    <span className="flex-1">{m.name}</span>
                    <span className="text-xs text-on-surface-variant">{m.source === 'VIRTUAL' ? 'HOME RIG' : 'LIVE'}</span>
                  </label>
                ))}
              </div>

              <div className="bg-surface-container rounded-2xl p-4 flex flex-col gap-2">
                <h2 className="font-bold">Soak run (optional)</h2>
                <select value={runId} onChange={(e) => setRunId(e.target.value)} disabled={mode === 'watching'} className="min-h-[44px] rounded-lg bg-surface-container-high px-2 text-sm">
                  <option value="">No soak run</option>
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id.slice(-6).toUpperCase()} · {r.status} · {new Date(r.started_at).toLocaleString()}
                    </option>
                  ))}
                </select>
                {source === 'file' && runId && (
                  <label className="text-sm">
                    Video time when the run clock showed 00:00:00 (mm:ss)
                    <input value={offsetText} onChange={(e) => setOffsetText(e.target.value)} placeholder="0:12" className="w-full min-h-[44px] rounded-lg bg-surface-container-high px-2" />
                  </label>
                )}
              </div>
            </>
          )}

          {mode === 'watching' && (
            <div className="flex flex-col gap-2">
              {watched.map((m) => {
                const v = views[m.id];
                const ago = v?.lastReadAt ? Math.round((Date.now() - v.lastReadAt) / 1000) : null;
                return (
                  <div key={m.id} className="bg-surface-container rounded-2xl p-3" data-testid={`watch-card-${m.id}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-bold">{m.name}</span>
                      <span className="text-xs px-2 py-1 rounded-full bg-surface-container-high">{v?.state ?? '…'}</span>
                    </div>
                    <div className="text-sm text-on-surface-variant mt-1">
                      Edge light: {v?.edgeLight ?? '…'} · Count: {v?.count ?? '—'}
                    </div>
                    {v?.alarm && <div className="text-sm text-red-300 font-bold">{v.alarm}</div>}
                    <div className="text-xs text-on-surface-variant mt-1">
                      Last Gemini read {ago === null ? '—' : `${ago}s ago`} · {v ? v.readsPerHour.toFixed(0) : 0} reads/hour
                    </div>
                    {v?.error && <div className="text-xs text-amber-300">{v.error}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </main>
    </div>
  );
};

function emptyView(): MachineView {
  return { edgeLight: 'off', state: null, count: null, alarm: null, lastReadAt: null, readsPerHour: 0, error: null };
}

export default MachineWatchScreen;
