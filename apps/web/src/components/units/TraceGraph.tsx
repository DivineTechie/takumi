import React, { useEffect, useState } from 'react';
import type { TracebackResult } from '../../lib/api';
import { useI18n } from '../../i18n';

/**
 * Animated picture of a trace-back result: the failed unit, the station and step where the agent
 * found the defect started, the other units that went through that step, and the fix for the Studio.
 * Edges draw one after another so the reasoning reads left to right (top to bottom on phones).
 */

const MAX_UNITS = 8;

interface Node {
  x: number;
  y: number;
  w: number;
  h: number;
}

function useNarrow(): boolean {
  const query = '(max-width: 639px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

function edge(a: Node, b: Node, vertical: boolean): string {
  if (vertical) {
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
    const my = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
  }
  const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

const Box: React.FC<{ n: Node; tone: string; title: string; sub?: string; delay: number; mono?: boolean }> = ({ n, tone, title, sub, delay, mono }) => (
  <g className={`tk-pop ${tone.split(' ').filter((c) => c.startsWith('text-')).join(' ')}`} style={{ animationDelay: `${delay}s`, transformBox: 'fill-box', transformOrigin: 'center' }}>
    <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={12} className={tone.split(' ').filter((c) => c.startsWith('fill-')).join(' ')} />
    <text x={n.x + n.w / 2} y={n.y + (sub ? n.h / 2 - 3 : n.h / 2 + 5)} textAnchor="middle" className={`fill-current text-[14px] font-bold ${mono ? 'font-mono' : ''}`}>
      {title.length > 26 ? `${title.slice(0, 25)}…` : title}
    </text>
    {sub && (
      <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 15} textAnchor="middle" className="fill-current text-[11px] opacity-80">
        {sub.length > 32 ? `${sub.slice(0, 31)}…` : sub}
      </text>
    )}
  </g>
);

export const TraceGraph: React.FC<{ unitId: string; defect: string | null; trace: TracebackResult }> = ({ unitId, defect, trace }) => {
  const narrow = useNarrow();
  const { t } = useI18n();
  const r = trace.report;
  const units = r.hold_unit_ids.slice(0, MAX_UNITS);
  const more = r.hold_unit_ids.length - units.length;
  const hasCause = !!r.root_cause_station;
  const hasFix = !!r.work_instruction_fix && hasCause;

  let width: number, height: number, unit: Node, cause: Node, fix: Node, holds: Node[];
  if (narrow) {
    width = 340;
    unit = { x: 70, y: 10, w: 200, h: 56 };
    cause = { x: 50, y: 110, w: 240, h: 64 };
    holds = units.map((_, i) => ({ x: i % 2 ? 180 : 20, y: 240 + Math.floor(i / 2) * 52, w: 140, h: 40 }));
    const holdsBottom = holds.length ? holds[holds.length - 1].y + 40 : 174;
    fix = { x: 50, y: holdsBottom + (more > 0 ? 50 : 30), w: 240, h: 52 };
    height = (hasFix ? fix.y + fix.h : holdsBottom + (more > 0 ? 30 : 0)) + 12;
  } else {
    const rows = Math.max(units.length, 1);
    height = Math.max(250, rows * 50 + 40 + (more > 0 ? 24 : 0));
    width = 800;
    unit = { x: 10, y: height / 2 - 32, w: 190, h: 64 };
    cause = { x: 290, y: hasFix ? height / 2 - 70 : height / 2 - 34, w: 230, h: 68 };
    fix = { x: 290, y: height / 2 + 24, w: 230, h: 54 };
    const top = (height - (rows * 50 - 10) - (more > 0 ? 24 : 0)) / 2;
    holds = units.map((_, i) => ({ x: 620, y: top + i * 50, w: 170, h: 40 }));
  }

  return (
    <figure className="bg-surface-container rounded-2xl p-2 overflow-hidden" aria-label={t('quality.trace_graph_label')}>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto text-on-surface" role="img">
        <title>
          {t(r.root_cause_step ? 'quality.trace_svg_title_step' : 'quality.trace_svg_title', {
            unit: unitId,
            station: r.root_cause_station ?? t('quality.trace_unknown_station'),
            step: r.root_cause_step ?? '',
            count: r.hold_unit_ids.length,
          })}
        </title>
        {hasCause && <path d={edge(unit, cause, narrow)} className="tk-draw stroke-red-500 fill-none" strokeWidth={3} style={{ animationDelay: '0.4s' }} />}
        {hasCause && narrow && holds.length > 0 && (
          <>
            <path d={`M${cause.x + cause.w / 2},${cause.y + cause.h} L${cause.x + cause.w / 2},${holds[0].y - 22}`} className="tk-draw stroke-purple-500 fill-none" strokeWidth={2} style={{ animationDelay: '1.5s' }} />
            <text x={width / 2 + 8} y={holds[0].y - 8} className="fill-current text-[12px] font-bold tk-rise" style={{ animationDelay: '1.6s' }}>
              {t('quality.trace_at_risk', { count: r.hold_unit_ids.length })}
            </text>
          </>
        )}
        {hasCause &&
          !narrow &&
          holds.map((h, i) => (
            <path key={i} d={edge(cause, h, narrow)} className="tk-draw stroke-purple-500 fill-none" strokeWidth={2} style={{ animationDelay: `${1.5 + i * 0.15}s` }} />
          ))}
        {hasFix && (!narrow || holds.length === 0) && (
          <path
            d={`M${cause.x + cause.w / 2},${cause.y + cause.h} L${fix.x + fix.w / 2},${fix.y}`}
            className="tk-draw stroke-emerald-500 fill-none"
            strokeWidth={2}
            style={{ animationDelay: `${1.8 + holds.length * 0.15}s` }}
          />
        )}

        <Box n={unit} tone="fill-red-600 text-white" title={unitId} sub={defect ? t('quality.trace_defect', { defect }) : t('quality.trace_failed_unit')} delay={0} mono />
        {hasCause ? (
          <Box n={cause} tone="fill-amber-400 text-black" title={r.root_cause_station as string} sub={t('quality.trace_step_confidence', { step: r.root_cause_step ?? '?', confidence: r.confidence })} delay={1.1} />
        ) : (
          <Box n={cause} tone="fill-surface-container-high text-on-surface" title={t('quality.trace_no_station')} sub={t('quality.trace_not_enough_records')} delay={1.1} />
        )}
        {holds.map((h, i) => (
          <Box key={units[i]} n={h} tone="fill-purple-600 text-white" title={units[i]} delay={1.8 + i * 0.15} mono />
        ))}
        {more > 0 && (
          <text
            x={narrow ? width / 2 : holds[holds.length - 1].x + 85}
            y={holds[holds.length - 1].y + (narrow ? 64 : 62)}
            textAnchor="middle"
            className="fill-current text-[12px] opacity-70"
          >
            {t('quality.trace_more_at_risk', { count: more })}
          </text>
        )}
        {hasFix && <Box n={fix} tone="fill-emerald-600 text-white" title={t('quality.trace_fix_title')} sub={t('quality.trace_fix_sub')} delay={2.2 + holds.length * 0.15} />}
      </svg>
      <figcaption className="sr-only">
        {t(hasFix ? 'quality.trace_caption_fix' : 'quality.trace_caption', { count: r.hold_unit_ids.length })}
      </figcaption>
    </figure>
  );
};
