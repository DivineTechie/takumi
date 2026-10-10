import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import {
  ApiError,
  fetchUnitHistory,
  holdUnits,
  releaseUnit,
  runTraceback,
  type TracebackResult,
  type UnitHistory,
} from '../lib/api';
import { useAuth } from '../lib/auth';

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

const ISSUE_LABEL: Record<string, string> = { mistake: 'Mistake', safety_stop: 'Safety stop', blocked: 'Blocked' };

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export const UnitScreen: React.FC = () => {
  const { unitId = '' } = useParams();
  const navigate = useNavigate();
  const { role } = useAuth();
  const isSupervisor = role === 'supervisor';
  const [unit, setUnit] = useState<UnitHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<TracebackResult | null>(null);
  const [tracing, setTracing] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUnit(await fetchUnitHistory(unitId));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'No unit with this serial.' : 'Could not load this unit.');
    }
  }, [unitId]);

  useEffect(() => {
    load();
  }, [load]);

  const startTrace = async () => {
    setTracing(true);
    setTraceError(null);
    setTrace(null);
    try {
      const result = await runTraceback(unitId);
      setTrace(result);
      setSelected(result.report.hold_unit_ids);
    } catch (e) {
      setTraceError(e instanceof ApiError ? e.message : 'The trace-back agent failed.');
    } finally {
      setTracing(false);
    }
  };

  const approveHold = async () => {
    if (!trace || selected.length === 0) return;
    const reason = trace.report.hold_reason || `Trace-back from unit ${unitId}`;
    try {
      const res = await holdUnits(selected, reason, 'traceback');
      setActionMsg(`Put ${res.held.length} unit(s) on hold.${res.skipped.length ? ` Skipped ${res.skipped.length}.` : ''}`);
    } catch {
      setActionMsg('Could not put the units on hold.');
    }
  };

  const release = async () => {
    try {
      await releaseUnit(unitId);
      await load();
    } catch {
      setActionMsg('Could not release this unit.');
    }
  };

  if (error) {
    return (
      <div className="min-h-screen bg-surface text-on-surface p-6">
        <button type="button" onClick={() => navigate(-1)} className="min-h-[44px]">← Back</button>
        <p className="mt-6">{error}</p>
      </div>
    );
  }
  if (!unit) return <div className="min-h-screen bg-surface text-on-surface p-6">Loading…</div>;

  const hasDefect = unit.status === 'failed' || unit.inspections.some((i) => i.ai_verdict === 'defective');

  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <header className="px-4 py-3 border-b border-outline-variant flex items-center gap-3">
        <button type="button" onClick={() => navigate(-1)} aria-label="Back" className="min-w-[44px] min-h-[44px]">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold font-mono truncate">{unit.id}</h1>
          <p className="text-xs text-on-surface-variant">
            {unit.product_id ?? 'No product'} · created {when(unit.created_at)}
          </p>
        </div>
        <span className={`text-xs font-bold px-3 py-1 rounded-full ${STATUS_STYLE[unit.status] ?? 'bg-surface-container-high'}`} data-testid="unit-status">
          {unit.status.replace('_', ' ')}
        </span>
      </header>

      <main className="max-w-5xl mx-auto p-4 space-y-6">
        {unit.status === 'on_hold' && (
          <div className="bg-purple-900/30 border border-purple-500/50 rounded-2xl p-4 flex flex-wrap items-center gap-3 justify-between">
            <span className="text-sm">On hold: {unit.holds[unit.holds.length - 1]?.reason}</span>
            {isSupervisor && (
              <button type="button" onClick={release} className="min-h-[48px] px-4 rounded-xl bg-surface-container-high font-bold">
                Release
              </button>
            )}
          </div>
        )}

        <section>
          <h2 className="text-base font-bold mb-2">Stations</h2>
          {unit.station_records.length === 0 && (
            <p className="text-sm text-on-surface-variant">No Station Watch session has been recorded for this serial yet.</p>
          )}
          <div className="space-y-3">
            {unit.station_records.map((r) => (
              <div key={r.session_id} className="bg-surface-container-low border border-outline-variant rounded-2xl p-4" data-testid="station-record">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-bold">{r.station}</span>
                  <span className="text-xs text-on-surface-variant">{when(r.ended_at)}</span>
                </div>
                <div className="text-sm text-on-surface-variant mt-1">
                  {r.steps_done} of {r.steps_total} steps verified · {r.mistakes} mistake(s) · {r.safety_stops} safety stop(s)
                  {r.incomplete_steps.length > 0 && ` · not verified: step ${r.incomplete_steps.join(', ')}`}
                </div>
                {r.issues.length > 0 && (
                  <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                    {r.issues.map((i, k) => (
                      <li key={k} className="flex gap-3 bg-surface-container rounded-xl p-2">
                        {i.frame_url ? (
                          <img src={i.frame_url} alt={`Evidence for step ${i.step}`} className="w-24 h-24 object-cover rounded-lg shrink-0" />
                        ) : (
                          <div className="w-24 h-24 rounded-lg bg-surface-container-high shrink-0 flex items-center justify-center text-xs text-on-surface-variant">No frame</div>
                        )}
                        <div className="text-sm min-w-0">
                          <div className="font-bold">
                            {ISSUE_LABEL[i.type] ?? i.type} · step {i.step}
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
          <h2 className="text-base font-bold mb-2">Inspections</h2>
          {unit.inspections.length === 0 && <p className="text-sm text-on-surface-variant">Not inspected yet.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {unit.inspections.map((i) => (
              <div key={i.id} className="flex gap-3 bg-surface-container-low border border-outline-variant rounded-2xl p-3">
                {i.image_url && <img src={i.image_url} alt="Inspected unit" className="w-24 h-24 object-cover rounded-lg shrink-0" />}
                <div className="text-sm">
                  <div className="font-bold">{i.ai_verdict === 'defective' ? `Defect: ${i.defect ?? 'unspecified'}` : i.ai_verdict === 'ok' ? 'OK' : 'Needs review'}</div>
                  {i.where && <div className="text-on-surface-variant">Where: {i.where}</div>}
                  <div className="text-on-surface-variant">
                    Human decision: {i.human_decision ? i.human_decision.replace('_', ' ') : 'pending'} · {i.source ?? 'LIVE'}
                  </div>
                  <div className="text-xs text-on-surface-variant">{when(i.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {isSupervisor && (
          <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold">Quality trace-back</h2>
                <p className="text-xs text-on-surface-variant">
                  A Google ADK agent reads this unit's records, finds the likely station and step, and lists other units at risk. It changes nothing on its own.
                </p>
              </div>
              <button
                type="button"
                onClick={startTrace}
                disabled={tracing || !hasDefect}
                className="min-h-[56px] px-5 rounded-xl bg-primary text-on-primary font-bold disabled:opacity-40"
              >
                {tracing ? 'Tracing…' : 'Trace back'}
              </button>
            </div>
            {!hasDefect && <p className="text-sm text-on-surface-variant">Trace-back is for units with a defect.</p>}
            {traceError && <p className="text-sm text-red-400">{traceError}</p>}

            {trace && (
              <div className="space-y-4" data-testid="traceback-report">
                <ol className="text-xs text-on-surface-variant space-y-1">
                  {trace.agent_steps.map((s, k) => (
                    <li key={k} className="font-mono">
                      {k + 1}. {s.agent} → {s.tool}({Object.values(s.args).join(', ')})
                    </li>
                  ))}
                </ol>
                <p>{trace.report.summary}</p>
                {trace.report.root_cause_station && (
                  <div className="text-sm">
                    <span className="font-bold">Likely start:</span> {trace.report.root_cause_station}, step {trace.report.root_cause_step} · confidence{' '}
                    {trace.report.confidence}
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
                  <h3 className="font-bold text-sm mb-1">Units at risk ({trace.report.hold_unit_ids.length})</h3>
                  {trace.report.hold_unit_ids.length === 0 && <p className="text-sm text-on-surface-variant">None found.</p>}
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
                      Approve: hold {selected.length} unit(s)
                    </button>
                  )}
                </div>

                {trace.report.work_instruction_fix && (
                  <div className="bg-surface-container rounded-xl p-3 text-sm">
                    <h3 className="font-bold mb-1">Suggested work-instruction change</h3>
                    <p>{trace.report.work_instruction_fix}</p>
                    <p className="text-xs text-on-surface-variant mt-1">Apply it in the Standard Work Studio after review.</p>
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
