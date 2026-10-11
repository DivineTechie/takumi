import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchLiveLatency, type LiveLatencyRow } from '../lib/api';
import visa from '../evals/visaResults.json';
import machineWatch from '../evals/machineWatchResults.json';
import agents from '../evals/agentResults.json';
import { useI18n } from '../i18n';

/**
 * /evals (P20): the evidence behind TAKUMI, public. Every figure carries its label: PUBLIC DATA
 * (dataset + licence), HOME RIG (our test bench filmed by a real camera) or LIVE (our deployment).
 */

const REPO = 'https://github.com/DivineTechie/takumi/blob/main';

type SetupKey = 'few_false_alarms' | 'catch_everything' | 'lite_ref' | 'flash_single';
const SETUP_ORDER: SetupKey[] = ['few_false_alarms', 'catch_everything', 'lite_ref', 'flash_single'];
// Translation keys; resolved with t() at render time.
const SETUP_SHORT: Record<SetupKey, string> = {
  few_false_alarms: 'quality.evals_setup_few_false_alarms',
  catch_everything: 'quality.evals_setup_catch_everything',
  lite_ref: 'quality.evals_setup_lite_ref',
  flash_single: 'quality.evals_setup_flash_single',
};

const ENDPOINT_NAMES: Record<string, string> = {
  watch: 'quality.evals_endpoint_watch',
  verify: 'quality.evals_endpoint_verify',
  point: 'quality.evals_endpoint_point',
  'live-token': 'quality.evals_endpoint_live_token',
  inspect: 'quality.evals_endpoint_inspect',
  inspect_gallery: 'quality.evals_endpoint_inspect_gallery',
  machine_read: 'quality.evals_endpoint_machine_read',
  ask: 'quality.evals_endpoint_ask',
};

type TFn = (key: string, params?: Record<string, string | number>) => string;

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
  detected?: number;
  truth?: number;
  note?: string;
}

interface CostEstimate {
  usd_per_machine_month_24_7: number;
  usd_per_machine_month_one_shift: number;
  assumptions: string[];
}

function pct(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`;
}

function secs(ms: number | null | undefined, t: TFn): string {
  return ms === null || ms === undefined ? '—' : t('quality.evals_seconds', { value: (ms / 1000).toFixed(1) });
}

/** Splits a translated sentence on {slot} markers so links and emphasis can sit inside it. */
function interpolate(text: string, nodes: Record<string, React.ReactNode>): React.ReactNode[] {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return <React.Fragment key={i}>{m && m[1] in nodes ? nodes[m[1]] : part}</React.Fragment>;
  });
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
  const { t, language } = useI18n();
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
  const estimate = (machineWatch as { cost_estimate?: CostEstimate }).cost_estimate;

  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <header className="px-4 py-3 border-b border-outline-variant flex items-center gap-3">
        <Link to="/" aria-label={t('quality.evals_home')} className="min-w-[44px] min-h-[44px] flex items-center justify-center">
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
        <div className="min-w-0">
          <h1 className="text-lg font-bold">{t('quality.evals_title')}</h1>
          <p className="text-xs text-on-surface-variant">{t('quality.evals_subtitle')}</p>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-4 space-y-8">
        {/* 1. Inspection */}
        <section className="space-y-4" aria-labelledby="eval-inspection">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="eval-inspection" className="text-xl font-bold">{t('quality.evals_inspection_title')}</h2>
            <Label>{visa.label}</Label>
          </div>
          <p className="text-sm text-on-surface-variant">
            {t(visa.images_failed > 0 ? 'quality.evals_inspection_intro_failed' : 'quality.evals_inspection_intro', {
              scored: visa.images_scored.toLocaleString(language),
              categories: visa.categories,
              failed: visa.images_failed,
            })}
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label={t('quality.evals_defects_caught')} value={pct(d.defects_caught)} />
            <Tile label={t('quality.evals_false_alarms')} value={pct(d.false_alarms)} note={t('quality.evals_false_alarms_note')} />
            <Tile label={t('quality.evals_accuracy')} value={pct(d.accuracy)} note={t('quality.evals_accuracy_ci', { ci: pct(d.accuracy_ci95) })} />
            <Tile label={t('quality.evals_model_cost_per_part')} value={`$${(d.cost_per_image_usd ?? 0).toFixed(4)}`} />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="text-left text-on-surface-variant">
                <tr>
                  <th className="py-2 pr-3">{t('quality.evals_col_setup')}</th>
                  <th className="py-2 pr-3">{t('quality.evals_defects_caught')}</th>
                  <th className="py-2 pr-3">{t('quality.evals_false_alarms')}</th>
                  <th className="py-2 pr-3">{t('quality.evals_accuracy')}</th>
                  <th className="py-2">{t('quality.evals_col_cost_per_part')}</th>
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
              <h3 className="font-bold">{t('quality.evals_by_product')}</h3>
              <select
                value={catSetup}
                onChange={(e) => setCatSetup(e.target.value as SetupKey)}
                aria-label={t('quality.evals_by_product_setup_label')}
                className="min-h-[40px] max-w-full rounded-lg bg-surface-container px-2 text-sm"
              >
                {SETUP_ORDER.map((k) => (
                  <option key={k} value={k}>
                    {t(SETUP_SHORT[k])}
                  </option>
                ))}
              </select>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[480px]">
                <thead className="text-left text-on-surface-variant">
                  <tr>
                    <th className="py-2 pr-3">{t('quality.evals_col_product')}</th>
                    <th className="py-2 pr-3">{t('quality.evals_col_images')}</th>
                    <th className="py-2 pr-3">{t('quality.evals_defects_caught')}</th>
                    <th className="py-2">{t('quality.evals_false_alarms')}</th>
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
              <h3 className="font-bold mb-1">{t('quality.evals_method')}</h3>
              <ul className="list-disc pl-5 space-y-1">
                {visa.method.map((m) => (
                  <li key={m}>{m}</li>
                ))}
                <li>
                  {t('quality.evals_median_time_per_call', {
                    screen: secs(visa.latency_ms.screen_p50, t),
                    confirm: secs(visa.latency_ms.confirm_p50, t),
                    note: visa.latency_ms.note,
                  })}
                </li>
              </ul>
            </div>
            <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-4">
              <h3 className="font-bold mb-1">{t('quality.evals_caveats')}</h3>
              <ul className="list-disc pl-5 space-y-1">
                {visa.caveats.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="text-xs text-on-surface-variant">
            {interpolate(t('quality.evals_per_image_and_prices'), {
              file: (
                <a className="underline break-all" href={`${REPO}/evals/inspection/visa_12cat_per_image.csv`} target="_blank" rel="noopener noreferrer">
                  visa_12cat_per_image.csv
                </a>
              ),
              gallery: (
                <Link className="underline" to="/inspect/gallery">
                  {t('quality.evals_gallery_link')}
                </Link>
              ),
            })}
          </p>
        </section>

        {/* 2. Machine Watch */}
        <section className="space-y-3" aria-labelledby="eval-machines">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="eval-machines" className="text-xl font-bold">{t('quality.evals_machines_title')}</h2>
            <Label>HOME RIG</Label>
          </div>
          <p className="text-sm text-on-surface-variant">
            {t('quality.evals_machines_desc')}
          </p>
          {runs.length === 0 ? (
            <p className="text-sm bg-surface-container-low border border-outline-variant rounded-2xl p-4" data-testid="machine-none">
              {t('quality.evals_machines_none')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead className="text-left text-on-surface-variant">
                  <tr>
                    <th className="py-2 pr-3">{t('quality.evals_col_run')}</th>
                    <th className="py-2 pr-3">{t('quality.evals_col_hours_machines')}</th>
                    <th className="py-2 pr-3">{t('quality.evals_col_detected')}</th>
                    <th className="py-2 pr-3">{t('quality.evals_col_delay')}</th>
                    <th className="py-2 pr-3">{t('quality.evals_false_alarms')}</th>
                    <th className="py-2">{t('quality.evals_col_cost_machine_month')}</th>
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
                      <td className="py-2 pr-3">
                        {pct(r.detection_rate, 0)}
                        {r.truth !== undefined && ` (${r.detected}/${r.truth})`}
                      </td>
                      <td className="py-2 pr-3">
                        {t('quality.evals_seconds', { value: r.median_delay_s?.toFixed(1) ?? '—' })} /{' '}
                        {t('quality.evals_seconds', { value: r.p90_delay_s?.toFixed(1) ?? '—' })}
                      </td>
                      <td className="py-2 pr-3">{r.false_alarms}</td>
                      <td className="py-2">{r.usd_per_machine_month === null ? '—' : `$${r.usd_per_machine_month.toFixed(2)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {estimate && (
                <div className="mt-3 bg-surface-container-low border border-outline-variant rounded-2xl p-4 text-sm" data-testid="machine-estimate">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <h3 className="font-bold">{t('quality.evals_estimate_title')}</h3>
                    <Label>{t('quality.evals_estimate_label')}</Label>
                  </div>
                  <p>
                    {interpolate(t('quality.evals_estimate_text'), {
                      one_shift: <strong>${estimate.usd_per_machine_month_one_shift.toFixed(2)}</strong>,
                      full_time: <strong>${estimate.usd_per_machine_month_24_7.toFixed(0)}</strong>,
                    })}
                  </p>
                  <ul className="list-disc pl-5 text-xs text-on-surface-variant mt-1 space-y-0.5">
                    {estimate.assumptions.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                </div>
              )}
              {runs.map((r) => r.note && (
                <p key={`${r.run_id}-note`} className="text-xs text-on-surface-variant mt-2">
                  {r.date}: {r.note}
                </p>
              ))}
            </div>
          )}
        </section>

        {/* Agents on scripted scenarios */}
        <section className="space-y-3" aria-labelledby="eval-agents" data-testid="eval-agents">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="eval-agents" className="text-xl font-bold">{t('quality.evals_agents_title')}</h2>
            <Label>{agents.label}</Label>
          </div>
          <p className="text-sm text-on-surface-variant">{t('quality.evals_agents_desc')}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 text-sm space-y-2">
              <h3 className="font-bold">{t('quality.evals_agents_maintenance')}</h3>
              <p className="text-3xl font-extrabold">
                {agents.maintenance.all_checks}/{agents.maintenance.n}
              </p>
              <p className="text-on-surface-variant">{t('quality.evals_agents_maintenance_desc', { s: agents.maintenance.median_s.toFixed(1) })}</p>
              <ul className="text-xs text-on-surface-variant space-y-0.5">
                <li>{t('quality.evals_agents_check_cause', { n: agents.maintenance.pass.cause_in_guide, total: agents.maintenance.n })}</li>
                <li>{t('quality.evals_agents_check_minutes', { n: agents.maintenance.pass.minutes_from_guide, total: agents.maintenance.n })}</li>
                <li>{t('quality.evals_agents_check_repeat', { n: agents.maintenance.pass.repeat_flag_right, total: agents.maintenance.n })}</li>
                <li>{t('quality.evals_agents_check_safety', { n: agents.maintenance.pass.safety_present, total: agents.maintenance.n })}</li>
              </ul>
            </div>
            <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 text-sm space-y-2">
              <h3 className="font-bold">{t('quality.evals_agents_traceback')}</h3>
              <p className="text-3xl font-extrabold">
                {agents.traceback.pass.holds_exact}/{agents.traceback.n}
              </p>
              <p className="text-on-surface-variant">{t('quality.evals_agents_traceback_desc', { s: agents.traceback.median_s.toFixed(1) })}</p>
              <ul className="text-xs text-on-surface-variant space-y-0.5">
                <li>{t('quality.evals_agents_check_step', { n: agents.traceback.pass.step_right, total: agents.traceback.n })}</li>
                <li>{t('quality.evals_agents_check_holds', { n: agents.traceback.pass.holds_exact, total: agents.traceback.n })}</li>
                <li>{t('quality.evals_agents_check_unsupported', { n: agents.traceback.pass.no_unsupported_hold, total: agents.traceback.n })}</li>
              </ul>
            </div>
          </div>
          <p className="text-xs text-on-surface-variant">{t('quality.evals_agents_method', { date: agents.generated, judge: agents.judge_model })}</p>
        </section>

        {/* 3. Live timings */}
        <section className="space-y-3" aria-labelledby="eval-live">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="eval-live" className="text-xl font-bold">{t('quality.evals_live_title')}</h2>
            <Label>LIVE</Label>
          </div>
          <p className="text-sm text-on-surface-variant">
            {t('quality.evals_live_desc')}
          </p>
          {liveError && <p className="text-sm text-red-400">{t('quality.evals_live_error')}</p>}
          {!live && !liveError && <p className="text-sm text-on-surface-variant">{t('quality.evals_loading')}</p>}
          {live && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[520px]" data-testid="live-table">
                <thead className="text-left text-on-surface-variant">
                  <tr>
                    <th className="py-2 pr-3">{t('quality.evals_col_what')}</th>
                    <th className="py-2 pr-3">{t('quality.evals_col_calls')}</th>
                    <th className="py-2 pr-3">{t('quality.evals_col_median')}</th>
                    <th className="py-2">{t('quality.evals_col_p90')}</th>
                  </tr>
                </thead>
                <tbody>
                  {live.map((r) => (
                    <tr key={r.endpoint} className="border-t border-outline-variant">
                      <td className="py-2 pr-3">{ENDPOINT_NAMES[r.endpoint] ? t(ENDPOINT_NAMES[r.endpoint]) : r.endpoint}</td>
                      <td className="py-2 pr-3">{r.n.toLocaleString(language)}</td>
                      <td className="py-2 pr-3">{secs(r.p50_ms, t)}</td>
                      <td className="py-2">{secs(r.p90_ms, t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer className="text-xs text-on-surface-variant border-t border-outline-variant pt-4">
          {interpolate(t('quality.evals_footer'), {
            dataset: (
              <a className="underline" href={visa.dataset_url} target="_blank" rel="noopener noreferrer">
                VisA (Amazon)
              </a>
            ),
            license: (
              <a className="underline" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">
                CC BY 4.0
              </a>
            ),
          })}
        </footer>
      </main>
    </div>
  );
};

export default EvalsScreen;
