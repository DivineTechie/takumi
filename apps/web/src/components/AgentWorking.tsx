import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

/** Live "agent is working" card: elapsed time and the read-only tools the agent can call. */
export const AgentWorking: React.FC<{ title: string; tools: string[]; startedAt: number; model?: string }> = ({
  title,
  tools,
  startedAt,
  model = 'gemini-3.8-flash',
}) => {
  const { t } = useI18n();
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, []);
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  return (
    <div className="relative overflow-hidden rounded-xl border border-primary/40 bg-surface-container p-4 tk-rise" role="status" aria-live="polite">
      <div className="absolute inset-0 tk-shimmer pointer-events-none" aria-hidden="true" />
      <div className="flex items-center gap-2 font-bold">
        <span className="material-symbols-outlined text-primary animate-spin [animation-duration:2.4s]">settings</span>
        <span className="min-w-0">{title}</span>
        <span className="ml-auto shrink-0 font-mono text-sm text-on-surface-variant tabular-nums">{t('quality.agent_elapsed', { secs })}</span>
      </div>
      <p className="text-xs text-on-surface-variant mt-1">{t('quality.agent_tools_line', { model })}</p>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {tools.map((tool, i) => (
          <span key={tool} className="text-xs px-2 py-1 rounded-full bg-surface-container-high animate-pulse" style={{ animationDelay: `${i * 0.3}s` }}>
            {tool}
          </span>
        ))}
      </div>
    </div>
  );
};
