import React, { useEffect, useState } from 'react';

/** Live "agent is working" card: elapsed time and the read-only tools the agent can call. */
export const AgentWorking: React.FC<{ title: string; tools: string[]; startedAt: number; model?: string }> = ({
  title,
  tools,
  startedAt,
  model = 'gemini-3.8-flash',
}) => {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  return (
    <div className="relative overflow-hidden rounded-xl border border-primary/40 bg-surface-container p-4 tk-rise" role="status" aria-live="polite">
      <div className="absolute inset-0 tk-shimmer pointer-events-none" aria-hidden="true" />
      <div className="flex items-center gap-2 font-bold">
        <span className="material-symbols-outlined text-primary animate-spin [animation-duration:2.4s]">settings</span>
        <span className="min-w-0">{title}</span>
        <span className="ml-auto font-mono text-sm text-on-surface-variant tabular-nums">{secs}s</span>
      </div>
      <p className="text-xs text-on-surface-variant mt-1">Google ADK · {model} · read-only tools:</p>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {tools.map((t, i) => (
          <span key={t} className="text-xs px-2 py-1 rounded-full bg-surface-container-high animate-pulse" style={{ animationDelay: `${i * 0.3}s` }}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
};
