import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchLiveLatency, type LiveLatencyRow } from '../lib/api';
import visa from '../evals/visaResults.json';
import machineWatch from '../evals/machineWatchResults.json';

/**
 * /evals (P20): the evidence behind TAKUMI, public. Every figure carries its label: PUBLIC DATA
 * (dataset + licence), HOME RIG (our test bench filmed by a real camera) or LIVE (our deployment).
 */

const REPO = 'https://github.com/DivineTechie/takumi/blob/main';

type SetupKey = 'few_false_alarms' | 'catch_everything' | 'lite_ref' | 'flash_single';
const SETUP_ORDER: SetupKey[] = ['few_false_alarms', 'catch_everything', 'lite_ref', 'flash_single'];
const SETUP_SHORT: Record<SetupKey, string> = {
  few_false_alarms: 'Few false alarms (default)',
  catch_everything: 'Catch everything',
  lite_ref: 'Flash-Lite + references',
  flash_single: 'Flash only',
};

const ENDPOINT_NAMES: Record<string, string> = {
  watch: 'Station Watch step watcher (Flash-Lite)',
  verify: 'Station Watch step verifier (Flash)',
  point: 'Pointing at a part (Robotics-ER)',
  'live-token': 'Start a voice session (single-use token)',
  inspect: 'End-of-line inspection, station photo',
  inspect_gallery: 'End-of-line inspection, gallery part',
  machine_read: 'Machine Watch read (Flash-Lite)',
  ask: 'Ask the master (Flash)',
};

interface MachineRun {
  run_id: string;
  date: string;
  hours: number;
  machines: number;
  detection_rate: number | null;
  median_delay_s: number | null;
  p90_delay_s: number | null;
  false_alarms: number;
  reads_per_machine_hour: number | null;
  usd_per_machine_month: number | null;
  mode: string;
}

function pct(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`;
}

function secs(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`;
}

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-surface-container-high text-on-surface">{children}</span>
);

const Tile: React.FC<{ label: string; value: string; note?: string }> = ({ label, value, note }) => (
  <div className="bg-surface-container rounded-xl p-4">
    <div className="text-xs text-on-surface-variant">{label}</div>
    <div className="text-3xl font-bold">{value}</div>
    {note && <div className="text-xs text-on-surface-variant mt-1">{note}</div>}
  </div>
);

export const EvalsScreen: React.FC = () => {
  const [live, setLive] = useState<LiveLatencyRow[] | null>(null);
  const [liveError, setLiveError] = useState(false);
  const [catSetup, setCatSetup] = useState<SetupKey>('few_false_alarms');

  useEffect(() => {
    fetchLiveLatency(30)
      .then((r) => setLive(r.endpoints))
      .catch(() => setLiveError(true));
  }, []);

  const d = visa.setups.few_false_alarms;
  const runs = machineWatch.runs as MachineRun[];

  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <header className="px-4 py-3 border-b border-outline-variant flex items-center gap-3">
        <Link to="/" aria-label="Home" className="min-w-[44px] min-h-[44px] flex items-center justify-center">
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
        <div>
          <h1 className="text-lg font-bold">Evaluations</h1>
          <p className="text-xs text-on-surface-variant">Every number is labelled LIVE, HOME RIG or PUBLIC DATA.</p>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-4 space-y-8">
        {/* 1. Inspection */}
        <section className="space-y-4" aria-labelledby="eval-inspection">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="eval-inspection" className="text-xl font-bold">End-of-line visual inspection</h2>
            <Label>{visa.label}</Label>
          </div>
          <p className="text-sm text-on-surface-variant">
            {visa.images_scored.toLocaleString()} test images across {visa.categories} product categories of the VisA benchmark
            {visa.images_failed > 0 && ` (${visa.images_failed} not yet scored)`}. Default mode: Gemini Flash-Lite compares each part with 3
            known-good references, and Gemini Flash confirms suspected defects.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="Defects caught" value={pct(d.defects_caught)} />
            <Tile label="False alarms" value={pct(d.false_alarms)} note="good parts wrongly flagged" />
            <Tile label="Accuracy" value={pct(d.accuracy)} note={`±${pct(d.accuracy_ci95)} (95% CI)`} />
            <Tile label="Model cost per part" value={`$${(d.cost_per_image_usd ?? 0).toFixed(4)}`} />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="text-left text-on-surface-variant">
                <tr>
                  <th className="py-2 pr-3">Setup</th>
                  <th className="py-2 pr-3">Defects caught</th>
                  <th className="py-2 pr-3">False alarms</th>
                  <th className="py-2 pr-3">Accuracy</th>
                  <th className="py-2">Cost / part</th>
                </tr>
              </thead>
              <tbody>
                {SETUP_ORDER.map((k) => {
                  const s = visa.setups[k];
                  return (
                    <tr key={k} className="border-t border-outline-variant" data-testid={`setup-${k}`}>
                      <td className="py-2 pr-3">{s.name}</td>
                      <td className="py-2 pr-3">{pct(s.defects_caught)}</td>
                      <td className="py-2 pr-3">{pct(s.false_alarms)}</td>
                      <td className="py-2 pr-3">{pct(s.accuracy)}</td>
                      <td className="py-2">${(s.cost_per_image_usd ?? 0).toFixed(4)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <h3 className="font-bold">By product</h3>
              <select
                value={catSetup}
                onChange={(e) => setCatSetup(e.target.value as SetupKey)}
                aria-label="Setup for the per-product table"
                className="min-h-[40px] max-w-full rounded-lg bg-surface-container px-2 text-sm"
              >
                {SETUP_ORDER.map((k) => (
                  <option key={k} value={k}>
                    {SETUP_SHORT[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[480px]">
                <thead className="text-left text-on-surface-variant">
                  <tr>
                    <th className="py-2 pr-3">Product</th>
                    <th className="py-2 pr-3">Images</th>
                    <th className="py-2 pr-3">Defects caught</th>
                    <th className="py-2">False alarms</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(visa.by_category).map(([cat, v]) => {
                    const s = (v as Record<SetupKey, (typeof visa.setups)['few_false_alarms']>)[catSetup];
                    return (
                      <tr key={cat} className="border-t border-outline-variant">
                        <td className="py-2 pr-3 font-mono">{cat}</td>
                        <td className="py-2 pr-3">{s.n}</td>
                        <td className="py-2 pr-3">{pct(s.defects_caught, 0)}</td>
                        <td className="py-2">{pct(s.false_alarms, 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4 text-sm">
            <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-4">
              <h3 className="font-bold mb-1">Method</h3>
              <ul className="list-disc pl-5 space-y-1">
                {visa.method.map((m) => (
                  <li key={m}>{m}</li>
                ))}
                <li>
                  Median time per call: screen {secs(visa.latency_ms.screen_p50)}, confirm {secs(visa.latency_ms.confirm_p50)} ({visa.latency_ms.note})
                </li>
              </ul>
            </div>
            <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-4">
              <h3 className="font-bold mb-1">Caveats</h3>
              <ul className="list-disc pl-5 space-y-1">
                {visa.caveats.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="text-xs text-on-surface-variant">
            Per-image results:{' '}
            <a className="underline" href={`${REPO}/evals/inspection/visa_12cat_per_image.csv`} target="_blank" rel="noopener noreferrer">
              visa_12cat_per_image.csv
            </a>
            . Prices: Gemini list prices per 1M tokens (Flash introductory price until 31 Dec 2026). Try it yourself in the{' '}
            <Link className="underline" to="/inspect/gallery">
              gallery
            </Link>
            .
          </p>
        </section>

        {/* 2. Machine Watch */}
        <section className="space-y-3" aria-labelledby="eval-machines">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="eval-machines" className="text-xl font-bold">Machine Watch soak test</h2>
            <Label>HOME RIG</Label>
          </div>
          <p className="text-sm text-on-surface-variant">
            Simulated machines on a computer screen (the test bench) with a seeded fault schedule, filmed by a real phone camera. Every stop,
            alarm and clear is logged as ground truth with server timestamps and matched to what Machine Watch detected.
          </p>
          {runs.length === 0 ? (
            <p className="text-sm bg-surface-container-low border border-outline-variant rounded-2xl p-4" data-testid="machine-none">
              No soak run has been scored yet. Results will appear here, with detection rate, detection delay, false alarms and model cost per
              machine.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead className="text-left text-on-surface-variant">
                  <tr>
                    <th className="py-2 pr-3">Run</th>
                    <th className="py-2 pr-3">Hours × machines</th>
                    <th className="py-2 pr-3">Detected</th>
                    <th className="py-2 pr-3">Median / p90 delay</th>
                    <th className="py-2 pr-3">False alarms</th>
                    <th className="py-2">Model cost / machine / month</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.run_id} className="border-t border-outline-variant">
                      <td className="py-2 pr-3">
                        {r.date} · {r.mode}
                      </td>
                      <td className="py-2 pr-3">
                        {r.hours.toFixed(1)} × {r.machines}
                      </td>
                      <td className="py-2 pr-3">{pct(r.detection_rate, 0)}</td>
                      <td className="py-2 pr-3">
                        {r.median_delay_s?.toFixed(1) ?? '—'} s / {r.p90_delay_s?.toFixed(1) ?? '—'} s
                      </td>
                      <td className="py-2 pr-3">{r.false_alarms}</td>
                      <td className="py-2">{r.usd_per_machine_month === null ? '—' : `$${r.usd_per_machine_month.toFixed(2)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 3. Live timings */}
        <section className="space-y-3" aria-labelledby="eval-live">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="eval-live" className="text-xl font-bold">Production response times</h2>
            <Label>LIVE</Label>
          </div>
          <p className="text-sm text-on-surface-variant">
            Successful calls to the deployed API in the last 30 days, from BigQuery. Includes our own testing and load-test traffic.
          </p>
          {liveError && <p className="text-sm text-red-400">Could not load live timings.</p>}
          {!live && !liveError && <p className="text-sm text-on-surface-variant">Loading…</p>}
          {live && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[520px]" data-testid="live-table">
                <thead className="text-left text-on-surface-variant">
                  <tr>
                    <th className="py-2 pr-3">What</th>
                    <th className="py-2 pr-3">Calls</th>
                    <th className="py-2 pr-3">Median</th>
                    <th className="py-2">90th percentile</th>
                  </tr>
                </thead>
                <tbody>
                  {live.map((r) => (
                    <tr key={r.endpoint} className="border-t border-outline-variant">
                      <td className="py-2 pr-3">{ENDPOINT_NAMES[r.endpoint] ?? r.endpoint}</td>
                      <td className="py-2 pr-3">{r.n.toLocaleString()}</td>
                      <td className="py-2 pr-3">{secs(r.p50_ms)}</td>
                      <td className="py-2">{secs(r.p90_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer className="text-xs text-on-surface-variant border-t border-outline-variant pt-4">
          Inspection images and labels:{' '}
          <a className="underline" href={visa.dataset_url} target="_blank" rel="noopener noreferrer">
            VisA (Amazon)
          </a>
          ,{' '}
          <a className="underline" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">
            CC BY 4.0
          </a>
          . Generated media is never used as evidence.
        </footer>
      </main>
    </div>
  );
};

export default EvalsScreen;
