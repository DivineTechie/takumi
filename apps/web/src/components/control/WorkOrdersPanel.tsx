import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  decideWorkOrder,
  draftWorkOrder,
  fetchWorkOrders,
  speakWorkOrder,
  type SpeechLanguage,
  type WorkOrder,
} from '../../lib/api';
import { AgentWorking } from '../AgentWorking';
import { useI18n } from '../../i18n';

/**
 * Maintenance work orders (control tower). When a machine stops, the Google ADK maintenance agent
 * reads its status, 7-day history, the alarm guide and past work orders, and drafts a work order.
 * The supervisor approves or dismisses it; the operator alert can be spoken in the floor's language.
 */

export interface DraftRequest {
  machineId: string;
  name: string;
  nonce: number;
  /** Called with the draft (or null on failure), e.g. by the voice copilot waiting for the answer. */
  onDone?: (wo: WorkOrder | null) => void;
}

const LANGS: { code: SpeechLanguage; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'ja', label: '日本語' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'fil', label: 'Filipino' },
];

/** Translation keys for the maintenance agent's tool calls. */
const TOOL_LABEL: Record<string, string> = {
  get_machine_status: 'ops.work_orders_tool_machine_status',
  get_machine_history: 'ops.work_orders_tool_machine_history',
  lookup_alarm_guide: 'ops.work_orders_tool_alarm_guide',
  get_past_work_orders: 'ops.work_orders_tool_past_orders',
};

const AGENT_TOOLS = [
  'ops.work_orders_agent_tool_status',
  'ops.work_orders_agent_tool_history',
  'ops.work_orders_agent_tool_alarm_guide',
  'ops.work_orders_agent_tool_past_orders',
];

const PRIORITY_KEYS = ['urgent', 'high', 'medium', 'low'];
const STATUS_KEYS = ['draft', 'approved', 'dismissed'];

const PRIORITY_TONE: Record<string, string> = {
  urgent: 'bg-red-600 text-white tk-ring',
  high: 'bg-red-500/15 text-red-500',
  medium: 'bg-amber-400/20 text-amber-600 dark:text-amber-300',
  low: 'bg-surface-container-high text-on-surface-variant',
};

function readLang(): SpeechLanguage {
  try {
    const v = localStorage.getItem('takumi.alertLang');
    if (v && LANGS.some((l) => l.code === v)) return v as SpeechLanguage;
  } catch {
    // storage unavailable
  }
  return 'en';
}

const WorkOrderCard: React.FC<{
  wo: WorkOrder;
  fresh: boolean;
  lang: SpeechLanguage;
  onDecided: () => void;
}> = ({ wo, fresh, lang, onDecided }) => {
  const { t, language } = useI18n();
  const d = wo.draft;
  const [busy, setBusy] = useState<string | null>(null);
  const [spoken, setSpoken] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [shownSteps, setShownSteps] = useState(fresh ? 0 : wo.agent_steps.length);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  // Reveal the agent's real tool calls one by one when the draft has just been made.
  useEffect(() => {
    if (shownSteps >= wo.agent_steps.length) return;
    const t = setTimeout(() => setShownSteps((n) => n + 1), 450);
    return () => clearTimeout(t);
  }, [shownSteps, wo.agent_steps.length]);

  const speak = useCallback(async () => {
    setBusy('speak');
    setMsg(null);
    const tr = tRef.current;
    try {
      const { audio, text } = await speakWorkOrder(wo.id, lang);
      setSpoken(text);
      const url = URL.createObjectURL(audio);
      audioRef.current?.pause();
      const a = new Audio(url);
      audioRef.current = a;
      a.onended = () => URL.revokeObjectURL(url);
      await a.play().catch(() => setMsg(tr('ops.work_orders_tap_speak')));
    } catch {
      setMsg(tr('ops.work_orders_speak_error'));
    } finally {
      setBusy(null);
    }
  }, [wo.id, lang]);

  const decide = async (decision: 'approve' | 'dismiss') => {
    setBusy(decision);
    setMsg(null);
    try {
      await decideWorkOrder(wo.id, decision);
      onDecided();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : t('ops.work_orders_decide_error'));
    } finally {
      setBusy(null);
    }
  };

  const allShown = shownSteps >= wo.agent_steps.length;

  // A work order the agent has just drafted is announced once, in the chosen floor language.
  const announced = useRef(false);
  useEffect(() => {
    if (fresh && allShown && !announced.current) {
      announced.current = true;
      void speak();
    }
  }, [fresh, allShown, speak]);

  return (
    <article className={`rounded-xl border border-outline-variant bg-surface-container p-4 space-y-3 ${fresh ? 'tk-pop' : ''}`} data-testid={`work-order-${wo.id}`}>
      <div className="flex flex-wrap items-start gap-2">
        <span className={`text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${PRIORITY_TONE[d.priority] ?? PRIORITY_TONE.medium}`}>{PRIORITY_KEYS.includes(d.priority) ? t(`ops.work_orders_priority_${d.priority}`) : d.priority}</span>
        {d.repeat_issue && <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-purple-500/15 text-purple-500">{t('ops.work_orders_repeat_issue')}</span>}
        <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-surface-container-high">{wo.source}</span>
        {wo.status !== 'draft' && (
          <span className={`text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${wo.status === 'approved' ? 'bg-green-600 text-white' : 'bg-surface-container-high'}`}>
            {STATUS_KEYS.includes(wo.status) ? t(`ops.work_orders_status_${wo.status}`) : wo.status}
          </span>
        )}
      </div>
      <div>
        <h3 className="font-bold text-on-surface">{d.title}</h3>
        <p className="text-xs text-on-surface-variant">
          {wo.machine_name ?? wo.machine_id}
          {wo.alarm_text ? ` · ${wo.alarm_text}` : ''} · {t('ops.work_orders_drafted_at', { time: new Date(wo.created_at).toLocaleTimeString(language) })}
          {wo.agent_ms ? ` ${t('ops.work_orders_drafted_in', { s: (wo.agent_ms / 1000).toFixed(1) })}` : ''}
        </p>
      </div>

      {wo.agent_steps.length > 0 && (
        <ol className="space-y-1" aria-label={t('ops.work_orders_agent_did')}>
          {wo.agent_steps.slice(0, shownSteps).map((s, i) => (
            <li key={i} className="flex items-center gap-2 text-xs text-on-surface-variant tk-rise">
              <span className="material-symbols-outlined text-[16px] text-green-500">check_circle</span>
              {TOOL_LABEL[s.tool] ? t(TOOL_LABEL[s.tool]) : s.tool}
              {s.tool === 'lookup_alarm_guide' && typeof s.args.alarm_text === 'string' ? ` (${s.args.alarm_text})` : ''}
            </li>
          ))}
        </ol>
      )}

      {allShown && (
        <div className="space-y-3 tk-rise">
          <p className="text-sm">{d.summary}</p>
          {d.likely_causes.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase text-on-surface-variant mb-1">{t('ops.work_orders_likely_causes')}</h4>
              <ol className="space-y-1">
                {d.likely_causes.map((c, i) => (
                  <li key={i} className="text-sm flex gap-2">
                    <span className="font-bold text-primary">{i + 1}.</span>
                    <span>
                      {c.cause}
                      <span className="block text-xs text-on-surface-variant">{c.evidence}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {d.steps.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase text-on-surface-variant mb-1">{t('ops.work_orders_steps')}</h4>
              <ol className="list-decimal pl-5 text-sm space-y-0.5">
                {d.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}
          {d.safety.length > 0 && (
            <div className="rounded-lg bg-amber-400/15 border border-amber-500/40 p-2 text-sm">
              <span className="font-bold">{t('ops.work_orders_safety')} </span>
              {d.safety.join(' · ')}
            </div>
          )}
          <p className="text-xs text-on-surface-variant">
            {d.parts.length > 0 && <>{t('ops.work_orders_parts', { parts: d.parts.join(', ') })} · </>}
            {d.estimated_minutes ? t('ops.work_orders_about_min', { n: d.estimated_minutes }) : t('ops.work_orders_time_not_estimated')}
          </p>

          <div className="rounded-lg bg-surface-container-high p-2 text-sm">
            <div className="text-xs font-bold uppercase text-on-surface-variant">{t('ops.work_orders_floor_alert')}</div>
            <p>“{spoken ?? d.operator_alert}”</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={speak} disabled={busy !== null} className="min-h-[48px] px-4 rounded-xl bg-surface-container-highest font-bold flex items-center gap-1 disabled:opacity-50">
              <span className="material-symbols-outlined text-[20px]">{busy === 'speak' ? 'hourglass_top' : 'volume_up'}</span>
              {t('ops.work_orders_speak')}
            </button>
            {wo.status === 'draft' && (
              <>
                <button type="button" onClick={() => decide('approve')} disabled={busy !== null} className="min-h-[48px] px-4 rounded-xl bg-green-600 text-white font-bold disabled:opacity-50">
                  {t('ops.work_orders_approve')}
                </button>
                <button type="button" onClick={() => decide('dismiss')} disabled={busy !== null} className="min-h-[48px] px-4 rounded-xl bg-surface-container-high disabled:opacity-50">
                  {t('ops.work_orders_dismiss')}
                </button>
              </>
            )}
          </div>
          {msg && <p className="text-sm text-red-500" role="alert">{msg}</p>}
        </div>
      )}
    </article>
  );
};

export const WorkOrdersPanel: React.FC<{
  request: DraftRequest | null;
  autoDraft: boolean;
  onAutoDraftChange: (v: boolean) => void;
}> = ({ request, autoDraft, onAutoDraftChange }) => {
  const { t } = useI18n();
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [running, setRunning] = useState<{ name: string; startedAt: number } | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; name: string } | null>(null);
  const [lang, setLang] = useState<SpeechLanguage>(readLang);
  const queue = useRef<DraftRequest[]>([]);
  const busy = useRef(false);
  const lastNonce = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setOrders(await fetchWorkOrders());
    } catch {
      // keep what is shown
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const runNext = useCallback(async () => {
    if (busy.current) return;
    const next = queue.current.shift();
    if (!next) return;
    busy.current = true;
    setError(null);
    setRunning({ name: next.name, startedAt: Date.now() });
    try {
      const wo = await draftWorkOrder(next.machineId);
      setFreshId(wo.existing ? null : wo.id);
      setOrders((prev) => [wo, ...prev.filter((o) => o.id !== wo.id)]);
      next.onDone?.(wo);
    } catch (e) {
      next.onDone?.(null);
      setError({ key: e instanceof ApiError && e.status === 409 ? 'ops.work_orders_running_again' : 'ops.work_orders_draft_error', name: next.name });
    } finally {
      busy.current = false;
      setRunning(null);
      void runNext();
    }
  }, []);

  useEffect(() => {
    if (!request || request.nonce === lastNonce.current) return;
    lastNonce.current = request.nonce;
    if (request.onDone || !queue.current.some((q) => q.machineId === request.machineId)) queue.current.push(request);
    void runNext();
  }, [request, runNext]);

  const changeLang = (v: SpeechLanguage) => {
    setLang(v);
    try {
      localStorage.setItem('takumi.alertLang', v);
    } catch {
      // storage unavailable
    }
  };

  const drafts = orders.filter((o) => o.status === 'draft');
  const decided = orders.filter((o) => o.status !== 'draft').slice(0, 3);

  return (
    <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 space-y-3" aria-labelledby="work-orders">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="work-orders" className="font-bold text-lg flex-1">
          {t('ops.work_orders_title')} {drafts.length > 0 && <span className="text-amber-500">· {t('ops.work_orders_to_approve', { n: drafts.length })}</span>}
        </h2>
        <label className="text-sm flex items-center gap-1">
          <span className="material-symbols-outlined text-[18px]">translate</span>
          <select value={lang} onChange={(e) => changeLang(e.target.value as SpeechLanguage)} aria-label={t('ops.work_orders_alert_language')} className="min-h-[44px] rounded-lg bg-surface-container px-2">
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm flex items-center gap-2 min-h-[44px] cursor-pointer">
          <input type="checkbox" checked={autoDraft} onChange={(e) => onAutoDraftChange(e.target.checked)} className="w-5 h-5" />
          {t('ops.work_orders_auto_draft')}
        </label>
      </div>
      {running && (
        <AgentWorking title={t('ops.work_orders_investigating', { name: running.name })} tools={AGENT_TOOLS.map((k) => t(k))} startedAt={running.startedAt} />
      )}
      {error && <p className="text-sm text-red-500">{t(error.key, { name: error.name })}</p>}
      {!running && drafts.length === 0 && (
        <p className="text-sm text-on-surface-variant">{t('ops.work_orders_empty')}</p>
      )}
      {drafts.map((wo) => (
        <WorkOrderCard key={wo.id} wo={wo} fresh={wo.id === freshId} lang={lang} onDecided={load} />
      ))}
      {decided.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-on-surface-variant min-h-[44px] flex items-center">{t('ops.work_orders_recently_decided')}</summary>
          <ul className="space-y-1 mt-1">
            {decided.map((wo) => (
              <li key={wo.id} className="flex gap-2">
                <span className={wo.status === 'approved' ? 'text-green-500' : 'text-on-surface-variant'}>
                  {STATUS_KEYS.includes(wo.status) ? t(`ops.work_orders_status_${wo.status}`) : wo.status}
                </span>
                <span className="truncate">{wo.draft.title}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
};
