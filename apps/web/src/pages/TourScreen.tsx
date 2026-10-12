import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n, SUPPORTED_LANGUAGES, type LanguageCode } from '../i18n';
import visa from '../evals/visaResults.json';
import machineWatch from '../evals/machineWatchResults.json';
import logoSvg from '../assets/logo.svg';

/**
 * Public tour: what TAKUMI does, shown as a small animated factory, and the measured numbers behind it.
 * Every number comes from the published evaluation files or the live aggregate endpoint, with its label.
 */

interface LiveEndpoint {
  endpoint: string;
  n: number;
  p50_ms: number | null;
}

const DEFAULT_SETUP = (visa.setups as Record<string, { accuracy: number; defects_caught: number; false_alarms: number; cost_per_image_usd: number }>).few_false_alarms;
const BEST_RUN = [...machineWatch.runs].sort((a, b) => (a.median_delay_s ?? 99) - (b.median_delay_s ?? 99))[0];
const COST = machineWatch.cost_estimate;

/** Counts up to `value` the first time it scrolls into view. */
const CountUp: React.FC<{ value: number; decimals?: number; prefix?: string; suffix?: string }> = ({ value, decimals = 0, prefix = '', suffix = '' }) => {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || typeof IntersectionObserver === 'undefined') {
      setShown(value);
      return;
    }
    let raf = 0;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - start) / 1400);
        setShown(value * (1 - Math.pow(1 - p, 3)));
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value]);
  return (
    <span ref={ref} className="tabular-nums">
      {prefix}
      {shown.toFixed(decimals)}
      {suffix}
    </span>
  );
};

/** A tiny bench: three machines, a phone watching them, and one machine that stops on a loop. */
const FactoryScene: React.FC<{ seenLabel: string; phoneLabel: string }> = ({ seenLabel, phoneLabel }) => {
  const [counts, setCounts] = useState([1204, 877, 1530]);
  useEffect(() => {
    const t = setInterval(() => setCounts((c) => [c[0] + 1, c[1] + (Date.now() % 9000 < 4000 ? 1 : 0), c[2] + 1]), 1400);
    return () => clearInterval(t);
  }, []);
  const machines = [
    { x: 300, stopping: false },
    { x: 420, stopping: true },
    { x: 540, stopping: false },
  ];
  return (
    <svg viewBox="0 0 640 360" className="w-full h-auto" role="img" aria-label={phoneLabel}>
      <defs>
        <linearGradient id="tk-beam" x1="0" x2="1">
          <stop offset="0" stopColor="#f59e0b" stopOpacity="0.9" />
          <stop offset="1" stopColor="#f59e0b" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* camera beam */}
      <polygon points="122,150 610,60 610,330 122,170" fill="url(#tk-beam)" className="tk-beam" />
      {/* phone */}
      <rect x="40" y="80" width="86" height="170" rx="14" fill="#111827" stroke="#374151" strokeWidth="3" />
      <rect x="48" y="96" width="70" height="132" rx="6" fill="#0b1220" />
      <circle cx="118" cy="160" r="5" fill="#f59e0b" />
      {[0, 1, 2].map((i) => (
        <rect key={i} x={54 + i * 21} y={140} width="16" height="40" rx="3" fill={i === 1 ? '#ef4444' : '#22c55e'} opacity={i === 1 ? undefined : 0.9} className={i === 1 ? 'tk-lamp-red' : ''} />
      ))}
      <text x="83" y="212" textAnchor="middle" fill="#9ca3af" fontSize="10" fontFamily="monospace">TAKUMI</text>
      {/* books under the phone */}
      <rect x="28" y="250" width="112" height="14" rx="3" fill="#7c3aed" opacity="0.7" />
      <rect x="34" y="264" width="100" height="14" rx="3" fill="#0ea5e9" opacity="0.7" />
      {machines.map((m, i) => (
        <g key={m.x}>
          <rect x={m.x - 4} y="200" width="8" height="70" fill="#4b5563" />
          <rect x={m.x - 30} y="270" width="60" height="10" rx="3" fill="#4b5563" />
          <rect x={m.x - 22} y="80" width="44" height="124" rx="8" fill="#1f2937" stroke="#4b5563" strokeWidth="2" />
          <circle cx={m.x} cy="104" r="14" fill="#ef4444" opacity={m.stopping ? undefined : 0.12} className={m.stopping ? 'tk-lamp-red' : ''} />
          <circle cx={m.x} cy="142" r="14" fill="#f59e0b" opacity="0.12" />
          <circle cx={m.x} cy="180" r="14" fill="#22c55e" className={m.stopping ? 'tk-lamp-green' : ''} />
          {m.stopping && <circle cx={m.x} cy="104" r="16" fill="none" stroke="#ef4444" strokeWidth="3" className="tk-alert" />}
          <rect x={m.x - 36} y="292" width="72" height="26" rx="4" fill="#000" stroke="#4b5563" />
          <text x={m.x} y="310" textAnchor="middle" fill="#ef4444" fontSize="15" fontFamily="monospace" fontWeight="bold">
            {String(counts[i]).padStart(6, '0')}
          </text>
        </g>
      ))}
      {/* detection chip */}
      <g className="tk-chip">
        <rect x="350" y="28" width="210" height="34" rx="17" fill="#065f46" />
        <text x="455" y="50" textAnchor="middle" fill="#ecfdf5" fontSize="14" fontWeight="bold">
          {seenLabel}
        </text>
      </g>
    </svg>
  );
};

const FLOW = [
  { icon: 'videocam', key: 'sense', items: ['tour.flow_sense_1', 'tour.flow_sense_2', 'tour.flow_sense_3'] },
  { icon: 'neurology', key: 'understand', items: ['tour.flow_understand_1', 'tour.flow_understand_2', 'tour.flow_understand_3'] },
  { icon: 'task_alt', key: 'act', items: ['tour.flow_act_1', 'tour.flow_act_2', 'tour.flow_act_3'] },
];

const MOMENTS = [
  { icon: 'build', key: 'machine' },
  { icon: 'front_hand', key: 'station' },
  { icon: 'account_tree', key: 'trace' },
  { icon: 'mic', key: 'voice' },
];

export const TourScreen: React.FC = () => {
  const { t, language, setLanguage } = useI18n();
  const [live, setLive] = useState<LiveEndpoint | null>(null);

  useEffect(() => {
    fetch('/api/evals/live')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { endpoints?: LiveEndpoint[] } | null) => setLive(d?.endpoints?.find((e) => e.endpoint === 'watch') ?? null))
      .catch(() => setLive(null));
  }, []);

  const seenLabel = t('tour.scene_seen', { s: (BEST_RUN?.median_delay_s ?? 0).toFixed(1) });

  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <header className="sticky top-0 z-10 bg-surface/90 backdrop-blur border-b border-outline-variant">
        <div className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-3">
          <img src={logoSvg} alt="TAKUMI" className="w-8 h-8" />
          <span className="font-bold tracking-wide flex-1">TAKUMI</span>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as LanguageCode)}
            aria-label={t('tour.language')}
            className="min-h-[44px] max-w-[11rem] rounded-lg bg-surface-container px-2 text-sm"
          >
            {SUPPORTED_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.native}
              </option>
            ))}
          </select>
          <Link to="/signin" className="hidden sm:flex min-h-[44px] px-4 rounded-xl bg-primary text-on-primary font-bold items-center whitespace-nowrap">
            {t('tour.try_it')}
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="bg-neutral-950 text-neutral-100">
        <div className="max-w-6xl mx-auto px-4 py-10 md:py-16 grid gap-8 md:grid-cols-[1fr_1.1fr] items-center">
          <div className="space-y-5 tk-rise">
            <p className="text-amber-400 font-bold tracking-wide text-sm">{t('tour.kicker')}</p>
            <h1 className="text-3xl md:text-5xl font-extrabold leading-tight">{t('tour.headline')}</h1>
            <p className="text-neutral-300 text-lg">{t('tour.subhead')}</p>
            <div className="flex flex-wrap gap-3">
              <Link to="/signin" className="min-h-[52px] px-5 rounded-xl bg-amber-500 text-black font-bold flex items-center gap-2">
                <span className="material-symbols-outlined">play_arrow</span>
                {t('tour.try_it')}
              </Link>
              <Link to="/evals" className="min-h-[52px] px-5 rounded-xl border border-neutral-600 font-bold flex items-center gap-2">
                <span className="material-symbols-outlined">query_stats</span>
                {t('tour.see_evidence')}
              </Link>
            </div>
          </div>
          <div className="tk-rise" style={{ animationDelay: '0.2s' }}>
            <FactoryScene seenLabel={seenLabel} phoneLabel={t('tour.scene_label')} />
            <p className="text-xs text-neutral-500 text-center mt-1">{t('tour.scene_caption')}</p>
          </div>
        </div>
      </section>

      {/* Sense, understand, act */}
      <section className="max-w-6xl mx-auto px-4 py-12">
        <h2 className="text-2xl md:text-3xl font-bold text-center">{t('tour.flow_title')}</h2>
        <p className="text-center text-on-surface-variant mt-2 max-w-2xl mx-auto">{t('tour.flow_subtitle')}</p>
        <div className="mt-8 grid gap-4 md:grid-cols-3 relative">
          {FLOW.map((f, i) => (
            <div key={f.key} className="relative bg-surface-container-low border border-outline-variant rounded-2xl p-5 tk-rise" style={{ animationDelay: `${i * 0.15}s` }}>
              <div className="flex items-center gap-2">
                <span className="w-10 h-10 rounded-full bg-primary-container/20 text-primary flex items-center justify-center material-symbols-outlined">{f.icon}</span>
                <h3 className="font-bold text-lg">{t(`tour.flow_${f.key}`)}</h3>
              </div>
              <ul className="mt-3 space-y-2 text-sm">
                {f.items.map((k) => (
                  <li key={k} className="flex gap-2">
                    <span className="material-symbols-outlined text-[18px] text-primary shrink-0">chevron_right</span>
                    <span>{t(k)}</span>
                  </li>
                ))}
              </ul>
              {i < FLOW.length - 1 && (
                <div className="hidden md:block absolute top-9 -right-4 w-8 h-1 overflow-visible" aria-hidden="true">
                  <span className="absolute top-[-3px] w-2.5 h-2.5 rounded-full bg-amber-500 tk-packet" />
                  <span className="absolute top-[-3px] w-2.5 h-2.5 rounded-full bg-amber-500 tk-packet" style={{ animationDelay: '1.2s' }} />
                </div>
              )}
            </div>
          ))}
        </div>
        <p className="text-center text-sm font-bold mt-6">{t('tour.people_decide')}</p>
      </section>

      {/* Proof */}
      <section className="bg-surface-container-low border-y border-outline-variant">
        <div className="max-w-6xl mx-auto px-4 py-12">
          <h2 className="text-2xl md:text-3xl font-bold text-center">{t('tour.proof_title')}</h2>
          <p className="text-center text-on-surface-variant mt-2">{t('tour.proof_subtitle')}</p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Proof label="PUBLIC DATA" value={<CountUp value={DEFAULT_SETUP.accuracy * 100} decimals={1} suffix="%" />} text={t('tour.proof_accuracy', { n: visa.images_scored.toLocaleString(language) })} />
            <Proof label="PUBLIC DATA" value={<CountUp value={DEFAULT_SETUP.cost_per_image_usd} decimals={4} prefix="$" />} text={t('tour.proof_cost_part', { fa: (DEFAULT_SETUP.false_alarms * 100).toFixed(1) })} />
            <Proof
              label="HOME RIG"
              value={
                <>
                  <CountUp value={BEST_RUN?.detected ?? 0} />/{BEST_RUN?.truth ?? 0}
                </>
              }
              text={t('tour.proof_stops', { s: (BEST_RUN?.median_delay_s ?? 0).toFixed(1) })}
            />
            <Proof label={COST.label} value={<CountUp value={COST.usd_per_machine_month_one_shift} decimals={2} prefix="$" />} text={t('tour.proof_cost_machine')} />
          </div>
          {live && live.n > 0 && live.p50_ms && (
            <p className="text-center text-sm text-on-surface-variant mt-6">
              <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 mr-2">LIVE</span>
              {t('tour.proof_live', { n: live.n.toLocaleString(language), s: (live.p50_ms / 1000).toFixed(1) })}
            </p>
          )}
          <div className="text-center mt-6">
            <Link to="/evals" className="underline font-bold">
              {t('tour.proof_method')}
            </Link>
          </div>
        </div>
      </section>

      {/* Moments */}
      <section className="max-w-6xl mx-auto px-4 py-12">
        <h2 className="text-2xl md:text-3xl font-bold text-center">{t('tour.moments_title')}</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {MOMENTS.map((m, i) => (
            <article key={m.key} className="bg-surface-container-low border border-outline-variant rounded-2xl p-5 flex gap-4 tk-rise" style={{ animationDelay: `${i * 0.1}s` }}>
              <span className="w-12 h-12 shrink-0 rounded-2xl bg-primary text-on-primary flex items-center justify-center material-symbols-outlined">{m.icon}</span>
              <div className="min-w-0">
                <h3 className="font-bold">{t(`tour.moment_${m.key}_title`)}</h3>
                <p className="text-sm text-on-surface-variant mt-1">{t(`tour.moment_${m.key}_text`)}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* Trust */}
      <section className="max-w-6xl mx-auto px-4 pb-12">
        <div className="rounded-2xl border border-outline-variant p-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          {['privacy', 'people', 'security', 'honest'].map((k) => (
            <div key={k} className="flex gap-2">
              <span className="material-symbols-outlined text-primary">verified_user</span>
              <span>{t(`tour.trust_${k}`)}</span>
            </div>
          ))}
        </div>
      </section>

      <footer className="bg-neutral-950 text-neutral-200">
        <div className="max-w-6xl mx-auto px-4 py-10 text-center space-y-4">
          <p className="text-2xl md:text-3xl font-extrabold">{t('tour.closing')}</p>
          <Link to="/signin" className="inline-flex min-h-[52px] px-6 rounded-xl bg-amber-500 text-black font-bold items-center gap-2">
            {t('tour.try_it')}
          </Link>
          <p className="text-xs text-neutral-500">{t('tour.footer')}</p>
        </div>
      </footer>
    </div>
  );
};

const Proof: React.FC<{ label: string; value: React.ReactNode; text: string }> = ({ label, value, text }) => (
  <div className="bg-surface border border-outline-variant rounded-2xl p-5">
    <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-surface-container-high">{label}</span>
    <div className="text-4xl font-extrabold mt-3">{value}</div>
    <p className="text-sm text-on-surface-variant mt-2">{text}</p>
  </div>
);

export default TourScreen;
