import React, { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  closeOrder,
  createOrder,
  fetchMachines,
  fetchOrders,
  runDemandAgent,
  type DemandResult,
  type Machine,
  type OrderStatus,
} from '../../lib/api';

/**
 * Today's orders on the control tower (P19). Projections come from real Machine Watch counts and
 * inspections (computed in code, same numbers as the agent's tools). "Ask the planner" runs the
 * Google ADK demand agent, which explains the risk and suggests actions; nothing changes on its own.
 */

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function defaultDue(): string {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const Chip: React.FC<{ o: OrderStatus }> = ({ o }) =>
  o.on_track === null ? (
    <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-surface-container-high">Not enough data</span>
  ) : o.on_track ? (
    <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-green-600 text-white">On track</span>
  ) : (
    <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-600 text-white">Short by {o.shortfall}</span>
  );

export const OrdersPanel: React.FC = () => {
  const [orders, setOrders] = useState<OrderStatus[] | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState(500);
  const [due, setDue] = useState(defaultDue);
  const [picked, setPicked] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [plan, setPlan] = useState<DemandResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOrders(await fetchOrders());
    } catch {
      setOrders([]);
    }
  }, []);

  useEffect(() => {
    load();
    fetchMachines().then(setMachines).catch(() => setMachines([]));
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!name.trim() || picked.length === 0) {
      setFormError('Give the order a name and pick at least one machine.');
      return;
    }
    try {
      await createOrder({ name: name.trim(), quantity, due_at: new Date(due).toISOString(), machine_ids: picked });
      setShowForm(false);
      setName('');
      setPicked([]);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not create the order.');
    }
  };

  const askPlanner = async () => {
    setPlanning(true);
    setPlanError(null);
    try {
      setPlan(await runDemandAgent());
    } catch (err) {
      setPlanError(err instanceof ApiError ? err.message : 'The planner failed.');
    } finally {
      setPlanning(false);
    }
  };

  return (
    <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 space-y-3" aria-labelledby="orders-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="orders-heading" className="font-bold text-lg">
          Today's orders
        </h2>
        <div className="flex gap-2">
          <button type="button" onClick={() => setShowForm((v) => !v)} className="min-h-[44px] px-3 rounded-xl bg-surface-container-high font-bold text-sm">
            {showForm ? 'Cancel' : 'New order'}
          </button>
          <button
            type="button"
            onClick={askPlanner}
            disabled={planning || !orders?.length}
            className="min-h-[44px] px-3 rounded-xl bg-primary text-on-primary font-bold text-sm disabled:opacity-40"
          >
            {planning ? 'Planning…' : 'Will we make it?'}
          </button>
        </div>
      </div>

      {showForm && (
        <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2 bg-surface-container rounded-xl p-3" aria-label="New order">
          <label className="text-sm">
            Order
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full min-h-[44px] rounded-lg bg-surface px-2" placeholder="e.g. Customer A, brackets" />
          </label>
          <label className="text-sm">
            Quantity
            <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value) || 1)} className="w-full min-h-[44px] rounded-lg bg-surface px-2" />
          </label>
          <label className="text-sm">
            Due
            <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="w-full min-h-[44px] rounded-lg bg-surface px-2" />
          </label>
          <fieldset className="text-sm">
            <legend>Machines making it</legend>
            {machines.length === 0 && <p className="text-on-surface-variant">Set up machines in Machine Watch first.</p>}
            {machines.map((m) => (
              <label key={m.id} className="flex items-center gap-2 min-h-[36px]">
                <input type="checkbox" checked={picked.includes(m.id)} onChange={() => setPicked((p) => (p.includes(m.id) ? p.filter((x) => x !== m.id) : [...p, m.id]))} />
                {m.name}
              </label>
            ))}
          </fieldset>
          {formError && <p className="text-sm text-red-400 sm:col-span-2">{formError}</p>}
          <button type="submit" className="min-h-[48px] rounded-xl bg-primary text-on-primary font-bold sm:col-span-2">
            Add order
          </button>
        </form>
      )}

      {orders === null ? (
        <p className="text-sm text-on-surface-variant">Loading…</p>
      ) : orders.length === 0 ? (
        <p className="text-sm text-on-surface-variant">No open orders. Add one to see whether today's output will cover it.</p>
      ) : (
        <ul className="space-y-2">
          {orders.map((o) => (
            <li key={o.order_id} className="bg-surface-container rounded-xl p-3 text-sm" data-testid={`order-${o.order_id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold">{o.name}</span>
                <span className="flex items-center gap-2">
                  <Chip o={o} />
                  <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded bg-surface-container-high">{o.source}</span>
                </span>
              </div>
              <div className="text-on-surface-variant mt-1">
                {o.good_made} of {o.quantity} good parts · due {hhmm(o.due_at)} ({o.hours_left} h left) · rate {o.rate_per_hour ?? '—'}/h
                {o.rate_needed_per_hour !== null && `, needs ${o.rate_needed_per_hour}/h`}
                {o.projected_good !== null && ` · projected ${o.projected_good}`}
                {o.first_pass_rate !== null && ` · yield ${Math.round(o.first_pass_rate * 100)}%`}
              </div>
              <div className="text-xs text-on-surface-variant mt-1">
                {o.machines.map((m) => `${m.name}: ${m.state ?? 'unknown'}${m.last_alarm ? ` (${m.last_alarm})` : ''}`).join(' · ')}
              </div>
              <button
                type="button"
                onClick={async () => {
                  await closeOrder(o.order_id).catch(() => {});
                  load();
                }}
                className="mt-2 text-xs underline"
              >
                Close order
              </button>
            </li>
          ))}
        </ul>
      )}

      {planError && <p className="text-sm text-red-400">{planError}</p>}
      {plan && (
        <div className="border-t border-outline-variant pt-3 space-y-2" data-testid="demand-plan">
          <ol className="text-xs text-on-surface-variant font-mono">
            {plan.agent_steps.map((s, i) => (
              <li key={i}>
                {i + 1}. {s.agent} → {s.tool}({Object.values(s.args).join(', ')})
              </li>
            ))}
          </ol>
          <p>{plan.report.summary}</p>
          {plan.report.orders.map((v) => (
            <p key={v.order_id} className="text-sm">
              <span className="font-bold">{plan.orders.find((o) => o.order_id === v.order_id)?.name ?? v.order_id}:</span> {v.verdict}
              {v.main_constraint && <span className="text-on-surface-variant"> Constraint: {v.main_constraint}</span>}
            </p>
          ))}
          {plan.report.actions.length > 0 && (
            <div>
              <h3 className="font-bold text-sm">Suggested actions (for you to decide)</h3>
              <ul className="list-disc pl-5 text-sm">
                {plan.report.actions.map((a, i) => (
                  <li key={i}>
                    {a.action} <span className="text-on-surface-variant">{a.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-on-surface-variant">Google ADK planner agent · numbers computed from machine counts and inspections, not by the model.</p>
        </div>
      )}
    </section>
  );
};
