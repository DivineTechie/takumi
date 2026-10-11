import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Machine, WorkOrder } from '../../lib/api';
import { CopilotSession, type CopilotState } from '../../lib/live/copilot';
import { buildCopilotTools } from '../../lib/live/copilotTools';

/**
 * "Ask TAKUMI": the supervisor talks to the factory. Gemini Live listens and answers by voice in the
 * supervisor's language; every fact comes from tools over TAKUMI's own data, shown here as they run.
 */

interface Line {
  who: 'user' | 'takumi';
  text: string;
  final: boolean;
}

const TOOL_LABEL: Record<string, string> = {
  get_machines_now: 'Machines',
  get_orders: 'Orders',
  get_quality: 'Quality',
  get_work_orders: 'Work orders',
  draft_work_order: 'Maintenance agent',
  ask_planner: 'Planner agent',
};

const SUGGESTIONS = ["Will we make today's orders?", 'Which machine is stopped, and why?', 'How is quality today?'];

const MAX_SESSION_MS = 9 * 60_000;

export const CopilotPanel: React.FC<{ draftWorkOrder: (m: Machine) => Promise<WorkOrder | null> }> = ({ draftWorkOrder }) => {
  const [state, setState] = useState<CopilotState>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [tools, setTools] = useState<{ name: string; phase: 'start' | 'done' | 'error'; at: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<CopilotSession | null>(null);
  const pendingAsk = useRef<string | null>(null);
  const draftRef = useRef(draftWorkOrder);
  draftRef.current = draftWorkOrder;
  const toolDefs = useMemo(() => buildCopilotTools((m) => draftRef.current(m)), []);

  const upsert = (who: Line['who'], text: string, final: boolean) => {
    if (!text) return;
    setLines((prev) => {
      const last = prev[prev.length - 1];
      const next = last && last.who === who && !last.final ? [...prev.slice(0, -1), { who, text, final }] : [...prev, { who, text, final }];
      return next.slice(-8);
    });
  };

  const start = () => {
    if (session.current) return;
    setError(null);
    setTools([]);
    const s = new CopilotSession(toolDefs, {
      onState: (st) => {
        setState(st);
        if (st === 'listening' && pendingAsk.current) {
          const q = pendingAsk.current;
          pendingAsk.current = null;
          s.ask(q);
        }
        if (st === 'closed' || st === 'error') session.current = null;
      },
      onUserText: (t, f) => upsert('user', t, f),
      onModelText: (t, f) => upsert('takumi', t, f),
      onTool: (name, phase) =>
        setTools((prev) => [...prev.filter((x) => !(x.name === name && x.phase === 'start' && phase !== 'start')), { name, phase, at: Date.now() }].slice(-6)),
      onError: (m) => setError(m),
    });
    session.current = s;
    void s.start();
  };

  const stop = () => session.current?.stop();

  const ask = (q: string) => {
    if (session.current && (state === 'listening' || state === 'speaking')) session.current.ask(q);
    else {
      pendingAsk.current = q;
      start();
    }
  };

  // End the session before the single-use token's 10-minute limit, and when leaving the page.
  useEffect(() => {
    if (state !== 'listening' && state !== 'speaking') return;
    const t = setTimeout(() => session.current?.stop(), MAX_SESSION_MS);
    return () => clearTimeout(t);
  }, [state === 'listening' || state === 'speaking']); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => session.current?.stop(), []);

  const live = state === 'listening' || state === 'speaking' || state === 'connecting';
  const running = tools.filter((t) => t.phase === 'start');
  const status =
    state === 'connecting'
      ? 'Connecting…'
      : running.length > 0
        ? `Checking ${running.map((t) => TOOL_LABEL[t.name] ?? t.name).join(', ')}…`
        : state === 'speaking'
          ? 'TAKUMI is answering'
          : state === 'listening'
            ? 'Listening — ask in any language'
            : 'Ask TAKUMI about machines, orders and quality';

  return (
    <section className="relative overflow-hidden bg-surface-container-low border border-outline-variant rounded-2xl p-4 space-y-3" aria-labelledby="copilot-title">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={live ? stop : start}
          aria-pressed={live}
          aria-label={live ? 'End voice session' : 'Talk to TAKUMI'}
          className={`relative shrink-0 w-16 h-16 rounded-full flex items-center justify-center text-white shadow-lg transition-colors ${live ? 'bg-red-600' : 'bg-primary'}`}
        >
          {state === 'listening' && (
            <>
              <span className="absolute inset-0 rounded-full bg-primary tk-halo" aria-hidden="true" />
              <span className="absolute inset-0 rounded-full bg-primary tk-halo" style={{ animationDelay: '0.9s' }} aria-hidden="true" />
            </>
          )}
          {state === 'speaking' ? (
            <span className="relative flex items-center gap-[3px] h-7" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className="w-[4px] h-7 rounded-full bg-white tk-bar" style={{ animationDelay: `${i * 0.12}s` }} />
              ))}
            </span>
          ) : (
            <span className={`relative material-symbols-outlined text-[32px] ${state === 'connecting' ? 'animate-pulse' : ''}`}>{live ? 'stop' : 'mic'}</span>
          )}
        </button>
        <div className="min-w-0 flex-1">
          <h2 id="copilot-title" className="font-bold text-lg">Ask TAKUMI</h2>
          <p className="text-sm text-on-surface-variant" role="status" aria-live="polite">
            {status}
          </p>
          <p className="text-[11px] text-on-surface-variant mt-0.5">Gemini Live · answers only from TAKUMI’s data · cannot approve anything</p>
        </div>
      </div>

      {tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Data TAKUMI checked">
          {tools.map((t, i) => (
            <span
              key={`${t.name}-${t.at}-${i}`}
              className={`text-xs px-2 py-1 rounded-full flex items-center gap-1 tk-rise ${t.phase === 'error' ? 'bg-red-500/15 text-red-500' : 'bg-surface-container-high'}`}
            >
              <span className={`material-symbols-outlined text-[14px] ${t.phase === 'start' ? 'animate-spin' : 'text-green-500'}`}>
                {t.phase === 'start' ? 'progress_activity' : t.phase === 'error' ? 'error' : 'check_circle'}
              </span>
              {TOOL_LABEL[t.name] ?? t.name}
            </span>
          ))}
        </div>
      )}

      {lines.length > 0 && (
        <ol className="space-y-2 max-h-72 overflow-y-auto" aria-label="Conversation">
          {lines.map((l, i) => (
            <li key={i} className={`flex ${l.who === 'user' ? 'justify-end' : 'justify-start'} tk-rise`}>
              <span
                className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                  l.who === 'user' ? 'bg-primary text-on-primary rounded-br-sm' : 'bg-surface-container-high rounded-bl-sm'
                } ${l.final ? '' : 'opacity-80'}`}
              >
                {l.text}
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => ask(q)}
            disabled={state === 'connecting'}
            className="min-h-[44px] px-3 rounded-full border border-outline-variant text-sm hover:bg-surface-container disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>
      {error && (
        <p className="text-sm text-red-500" role="alert">
          {error}
        </p>
      )}
    </section>
  );
};
