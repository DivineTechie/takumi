import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import {
  ApiError,
  createReviewRequest,
  fetchUnitHistory,
  holdUnits,
  releaseUnit,
  runTraceback,
  type TracebackResult,
  type UnitHistory,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { AgentWorking } from '../components/AgentWorking';
import { TraceGraph } from '../components/units/TraceGraph';
import { useI18n } from '../i18n';

// Translation keys; resolved with t() at render time.
const TRACE_TOOLS = ['quality.unit_tool_history', 'quality.unit_tool_same_step', 'quality.unit_tool_work_instruction'];
const TRACE_TOOL_LABEL: Record<string, string> = {
  get_unit_history: 'quality.unit_step_get_unit_history',
  find_similar_units: 'quality.unit_step_find_similar_units',
  get_work_instruction: 'quality.unit_step_get_work_instruction',
};

/**
 * Unit record (P16) and quality trace-back: every station the unit went through (with the evidence
 * frames of any mistake or safety stop) and every inspection. Supervisors can ask the trace-back agent
 * where a defect started; the agent only proposes, and holds happen when the supervisor approves.
 */

const STATUS_STYLE: Record<string, string> = {
  passed: 'bg-green-600 text-white',
  failed: 'bg-red-600 text-white',
  needs_review: 'bg-amber-500 text-black',
  on_hold: 'bg-purple-600 text-white',
  in_progress: 'bg-surface-container-high text-on-surface',
};

const STATUS_LABEL: Record<string, string> = {
  passed: 'quality.unit_status_passed',
  failed: 'quality.unit_status_failed',
  needs_review: 'quality.unit_status_needs_review',
  on_hold: 'quality.unit_status_on_hold',
  in_progress: 'quality.unit_status_in_progress',
};

const ISSUE_LABEL: Record<string, string> = {
  mistake: 'quality.unit_issue_mistake',
  safety_stop: 'quality.unit_issue_safety_stop',
  blocked: 'quality.unit_issue_blocked',
};

const DECISION_LABEL: Record<string, string> = {
  confirmed_defect: 'quality.unit_decision_confirmed_defect',
  overridden_ok: 'quality.unit_decision_overridden_ok',
};

function when(iso: string | null, language: string): string {
  return iso ? new Date(iso).toLocaleString(language) : '—';
}

export const UnitScreen: React.FC = () => {
  const { unitId = '' } = useParams();
  const navigate = useNavigate();
  const { role } = useAuth();
  const { t, language } = useI18n();
  const isSupervisor = role === 'supervisor';
  const [unit, setUnit] = useState<UnitHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<TracebackResult | null>(null);
  const [tracing, setTracing] = useState<number | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [sentToStudio, setSentToStudio] = useState(false);

  const load = useCallback(async () => {
    try {
      setUnit(await fetchUnitHistory(unitId));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'quality.unit_error_not_found' : 'quality.unit_error_load');
    }
  }, [unitId]);

  useEffect(() => {
    load();
  }, [load]);

  const startTrace = async () => {
    setTracing(Date.now());
    setTraceError(null);
    setTrace(null);
    try {
      const result = await runTraceback(unitId);
      setTrace(result);
      setSelected(result.report.hold_unit_ids);
    } catch (e) {
      setTraceError(e instanceof ApiError ? e.message : 'quality.unit_error_trace');
    } finally {
      setTracing(null);
    }
  };

  const approveHold = async () => {
    if (!trace || selected.length === 0) return;
    const reason = trace.report.hold_reason || `Trace-back from unit ${unitId}`;
    try {
      const res = await holdUnits(selected, reason, 'traceback');
      setActionMsg(
        res.skipped.length
          ? t('quality.unit_hold_done_skipped', { held: res.held.length, skipped: res.skipped.length })
          : t('quality.unit_hold_done', { held: res.held.length })
      );
    } catch {
      setActionMsg(t('quality.unit_error_hold'));
    }
  };

  const sendToStudio = async () => {
    const r = trace?.report;
    if (!r || !r.work_instruction_fix || !r.root_cause_skill_id || r.root_cause_step === null) return;
    try {
      await createReviewRequest({
        skill_id: r.root_cause_skill_id,
        step: r.root_cause_step,
        reason: `Quality trace-back of unit ${unitId}: ${r.summary}`.slice(0, 1000),
        suggested_instruction: r.work_instruction_fix.slice(0, 1000),
        source: 'traceback',
        unit_id: unitId,
      });
      setSentToStudio(true);
    } catch {
      setActionMsg(t('quality.unit_error_send_studio'));
    }
  };

  const release = async () => {
    try {
      await releaseUnit(unitId);
      await load();
    } catch {
      setActionMsg(t('quality.unit_error_release'));
    }
  };

  if (error) {
    return (
      <div className="min-h-screen bg-surface text-on-surface p-6">
        <button type="button" onClick={() => navigate(-1)} className="min-h-[44px]">← {t('back')}</button>
        <p className="mt-6">{t(error)}</p>
      </div>
    );
  }
  if (!unit) return <div className="min-h-screen bg-surface text-on-surface p-6">{t('quality.unit_loading')}</div>;

  const hasDefect = unit.status === 'failed' || unit.inspections.some((i) => i.ai_verdict === 'defective');

  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <header className="px-4 py-3 border-b border-outline-variant flex items-center gap-3">
        <button type="button" onClick={() => navigate(-1)} aria-label={t('back')} className="min-w-[44px] min-h-[44px] shrink-0">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold font-mono truncate">{unit.id}</h1>
          <p className="text-xs text-on-surface-variant">
            {t('quality.unit_product_created', { product: unit.product_id ?? t('quality.unit_no_product'), date: when(unit.created_at, language) })}
          </p>
        </div>
        <span className={`text-xs font-bold px-3 py-1 rounded-full text-center ${STATUS_STYLE[unit.status] ?? 'bg-surface-container-high'}`} data-testid="unit-status">
          {STATUS_LABEL[unit.status] ? t(STATUS_LABEL[unit.status]) : unit.status.replace('_', ' ')}
        </span>
      </header>

      <main className="max-w-5xl mx-auto p-4 space-y-6">
        {unit.status === 'on_hold' && (
          <div className="bg-purple-900/30 border border-purple-500/50 rounded-2xl p-4 flex flex-wrap items-center gap-3 justify-between">
            <span className="text-sm">{t('quality.unit_on_hold', { reason: unit.holds[unit.holds.length - 1]?.reason ?? '' })}</span>
            {isSupervisor && (
              <button type="button" onClick={release} className="min-h-[48px] px-4 rounded-xl bg-surface-container-high font-bold">
                {t('quality.unit_release')}
              </button>
            )}
          </div>
        )}

        <section>
          <h2 className="text-base font-bold mb-2">{t('quality.unit_stations')}</h2>
          {unit.station_records.length === 0 && (
            <p className="text-sm text-on-surface-variant">{t('quality.unit_no_stations')}</p>
          )}
          <div className="space-y-3">
            {unit.station_records.map((r) => (
              <div key={r.session_id} className="bg-surface-container-low border border-outline-variant rounded-2xl p-4" data-testid="station-record">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-bold">{r.station}</span>
                  <span className="text-xs text-on-surface-variant">{when(r.ended_at, language)}</span>
                </div>
                <div className="text-sm text-on-surface-variant mt-1">
                  {t('quality.unit_station_summary', { done: r.steps_done, total: r.steps_total, mistakes: r.mistakes, stops: r.safety_stops })}
                  {r.incomplete_steps.length > 0 && ` · ${t('quality.unit_not_verified', { steps: r.incomplete_steps.join(', ') })}`}
                </div>
                {r.issues.length > 0 && (
                  <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                    {r.issues.map((i, k) => (
                      <li key={k} className="flex gap-3 bg-surface-container rounded-xl p-2">
                        {i.frame_url ? (
                          <img src={i.frame_url} alt={t('quality.unit_evidence_alt', { step: i.step ?? '' })} className="w-24 h-24 object-cover rounded-lg shrink-0" />
                        ) : (
                          <div className="w-24 h-24 rounded-lg bg-surface-container-high shrink-0 flex items-center justify-center text-xs text-on-surface-variant">{t('quality.unit_no_frame')}</div>
                        )}
                        <div className="text-sm min-w-0">
                          <div className="font-bold">
                            {t('quality.unit_issue_step', { issue: ISSUE_LABEL[i.type] ? t(ISSUE_LABEL[i.type]) : i.type, step: i.step ?? '' })}
                          </div>
                          {i.step_title && <div className="text-on-surface-variant truncate">{i.step_title}</div>}
                          {i.reason && <div>{i.reason}</div>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-base font-bold mb-2">{t('quality.unit_inspections')}</h2>
          {unit.inspections.length === 0 && <p className="text-sm text-on-surface-variant">{t('quality.unit_not_inspected')}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {unit.inspections.map((i) => (
              <div key={i.id} className="flex gap-3 bg-surface-container-low border border-outline-variant rounded-2xl p-3">
                {i.image_url && <img src={i.image_url} alt={t('quality.unit_inspected_alt')} className="w-24 h-24 object-cover rounded-lg shrink-0" />}
                <div className="text-sm min-w-0">
                  <div className="font-bold">
                    {i.ai_verdict === 'defective'
                      ? t('quality.unit_defect', { defect: i.defect ?? t('quality.unit_defect_unspecified') })
                      : i.ai_verdict === 'ok'
                        ? t('quality.unit_verdict_ok')
                        : t('quality.unit_verdict_needs_review')}
                  </div>
                  {i.where && <div className="text-on-surface-variant">{t('quality.unit_where', { where: i.where })}</div>}
                  <div className="text-on-surface-variant">
                    {t('quality.unit_human_decision', {
                      decision: i.human_decision
                        ? DECISION_LABEL[i.human_decision]
                          ? t(DECISION_LABEL[i.human_decision])
                          : i.human_decision.replace('_', ' ')
                        : t('quality.unit_decision_pending'),
                      source: i.source ?? 'LIVE',
                    })}
                  </div>
                  <div className="text-xs text-on-surface-variant">{when(i.created_at, language)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {isSupervisor && (
          <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold">{t('quality.unit_trace_title')}</h2>
                <p className="text-xs text-on-surface-variant">
                  {t('quality.unit_trace_desc')}
                </p>
              </div>
              <button
                type="button"
                onClick={startTrace}
                disabled={tracing !== null || !hasDefect}
                className="min-h-[56px] px-5 rounded-xl bg-primary text-on-primary font-bold disabled:opacity-40"
              >
                {tracing !== null ? t('quality.unit_tracing') : t('quality.unit_trace_button')}
              </button>
            </div>
            {!hasDefect && <p className="text-sm text-on-surface-variant">{t('quality.unit_trace_needs_defect')}</p>}
            {traceError && <p className="text-sm text-red-400">{t(traceError)}</p>}
            {tracing !== null && <AgentWorking title={t('quality.unit_agent_investigating', { unit: unit.id })} tools={TRACE_TOOLS.map((k) => t(k))} startedAt={tracing} />}

            {trace && (
              <div className="space-y-4" data-testid="traceback-report">
                <TraceGraph unitId={unit.id} defect={unit.inspections.find((i) => i.ai_verdict === 'defective')?.defect ?? null} trace={trace} />
                <ol className="text-xs text-on-surface-variant space-y-1" aria-label={t('quality.unit_agent_steps_label')}>
                  {trace.agent_steps.map((s, k) => (
                    <li key={k} className="flex items-center gap-2 tk-rise" style={{ animationDelay: `${k * 0.25}s` }}>
                      <span className="material-symbols-outlined text-[16px] text-green-500">check_circle</span>
                      <span>
                        {TRACE_TOOL_LABEL[s.tool] ? t(TRACE_TOOL_LABEL[s.tool]) : s.tool}
                        {Object.keys(s.args).length > 0 && <span className="font-mono opacity-70"> ({Object.values(s.args).join(', ')})</span>}
                      </span>
                    </li>
                  ))}
                </ol>
                <p>{trace.report.summary}</p>
                {trace.report.root_cause_station && (
                  <div className="text-sm">
                    <span className="font-bold">{t('quality.unit_likely_start')}</span>{' '}
                    {t('quality.unit_likely_start_detail', {
                      station: trace.report.root_cause_station,
                      step: trace.report.root_cause_step ?? '?',
                      confidence: trace.report.confidence,
                    })}
                  </div>
                )}
                {trace.report.evidence.length > 0 && (
                  <ul className="list-disc pl-5 text-sm">
                    {trace.report.evidence.map((e, k) => (
                      <li key={k}>{e}</li>
                    ))}
                  </ul>
                )}

                <div>
                  <h3 className="font-bold text-sm mb-1">{t('quality.unit_units_at_risk', { count: trace.report.hold_unit_ids.length })}</h3>
                  {trace.report.hold_unit_ids.length === 0 && <p className="text-sm text-on-surface-variant">{t('quality.unit_none_found')}</p>}
                  {trace.report.hold_unit_ids.map((id) => (
                    <label key={id} className="flex items-center gap-2 min-h-[44px] text-sm">
                      <input
                        type="checkbox"
                        checked={selected.includes(id)}
                        onChange={() => setSelected((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
                      />
                      <Link to={`/units/${encodeURIComponent(id)}`} className="font-mono underline">
                        {id}
                      </Link>
                    </label>
                  ))}
                  {trace.report.hold_unit_ids.length > 0 && (
                    <button type="button" onClick={approveHold} disabled={selected.length === 0} className="mt-2 min-h-[56px] px-5 rounded-xl bg-purple-700 text-white font-bold disabled:opacity-40">
                      {t('quality.unit_approve_hold', { count: selected.length })}
                    </button>
                  )}
                </div>

                {trace.report.work_instruction_fix && (
                  <div className="bg-surface-container rounded-xl p-3 text-sm">
                    <h3 className="font-bold mb-1">{t('quality.unit_suggested_change')}</h3>
                    <p>{trace.report.work_instruction_fix}</p>
                    {trace.report.root_cause_skill_id && trace.report.root_cause_step !== null ? (
                      <button
                        type="button"
                        onClick={sendToStudio}
                        disabled={sentToStudio}
                        className="mt-2 min-h-[48px] px-4 rounded-xl bg-surface-container-high font-bold disabled:opacity-60"
                      >
                        {sentToStudio ? t('quality.unit_sent_to_studio') : t('quality.unit_send_to_studio', { step: trace.report.root_cause_step })}
                      </button>
                    ) : (
                      <p className="text-xs text-on-surface-variant mt-1">{t('quality.unit_no_step')}</p>
                    )}
                  </div>
                )}
              </div>
            )}
            {actionMsg && <p className="text-sm" role="status">{actionMsg}</p>}
          </section>
        )}
      </main>
    </div>
  );
};

export default UnitScreen;
