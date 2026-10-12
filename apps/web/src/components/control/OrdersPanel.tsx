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
import { stateLabel } from '../../lib/controlEvents';
import { useI18n } from '../../i18n';
import { usePolling } from '../../lib/usePolling';
import { stampText } from '../../lib/controlEvents';

/**
 * Today's orders on the control tower. Projections come from real Machine Watch counts and
 * inspections (computed in code, same numbers as the agent's tools). "Ask the planner" runs the
 * Google ADK demand agent, which explains the risk and suggests actions; nothing changes on its own.
 */

function dueText(iso: string, language: string): string {
  return stampText(iso, language);
}

function defaultDue(): string {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const Chip: React.FC<{ o: OrderStatus }> = ({ o }) => {
  const { t } = useI18n();
  return o.on_track === null ? (
    <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-surface-container-high">{t('ops.orders_chip_no_data')}</span>
  ) : o.on_track ? (
    <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-green-600 text-white">{t('ops.orders_chip_on_track')}</span>
  ) : (
    <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-600 text-white">{t('ops.orders_chip_short_by', { n: o.shortfall ?? '—' })}</span>
  );
};

export const OrdersPanel: React.FC = () => {
  const { t, language } = useI18n();
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
    fetchMachines().then(setMachines).catch(() => setMachines([]));
  }, []);
  usePolling(load, 30_000);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!name.trim() || picked.length === 0) {
      setFormError(t('ops.orders_form_missing'));
      return;
    }
    try {
      await createOrder({ name: name.trim(), quantity, due_at: new Date(due).toISOString(), machine_ids: picked });
      setShowForm(false);
      setName('');
      setPicked([]);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t('ops.orders_create_error'));
    }
  };

  const askPlanner = async () => {
    setPlanning(true);
    setPlanError(null);
    try {
      setPlan(await runDemandAgent());
    } catch (err) {
      setPlanError(err instanceof ApiError ? err.message : t('ops.orders_planner_error'));
    } finally {
      setPlanning(false);
    }
  };

  return (
    <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 space-y-3" aria-labelledby="orders-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="orders-heading" className="font-bold text-lg">
          {t('ops.orders_title')}
        </h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setShowForm((v) => !v)} className="min-h-[44px] px-3 rounded-xl bg-surface-container-high font-bold text-sm">
            {showForm ? t('ops.common_cancel') : t('ops.orders_new')}
          </button>
          <button
            type="button"
            onClick={askPlanner}
            disabled={planning || !orders?.length}
            className="min-h-[44px] px-3 rounded-xl bg-primary text-on-primary font-bold text-sm disabled:opacity-40"
          >
            {planning ? t('ops.orders_planning') : t('ops.orders_will_we_make_it')}
          </button>
        </div>
      </div>

      {showForm && (
        <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2 bg-surface-container rounded-xl p-3" aria-label={t('ops.orders_new')}>
          <label className="text-sm">
            {t('ops.orders_form_order')}
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full min-h-[44px] rounded-lg bg-surface px-2" placeholder={t('ops.orders_form_order_placeholder')} />
          </label>
          <label className="text-sm">
            {t('ops.orders_form_quantity')}
            <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value) || 1)} className="w-full min-h-[44px] rounded-lg bg-surface px-2" />
          </label>
          <label className="text-sm">
            {t('ops.orders_form_due')}
            <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="w-full min-h-[44px] rounded-lg bg-surface px-2" />
          </label>
          <fieldset className="text-sm">
            <legend>{t('ops.orders_form_machines')}</legend>
            {machines.length === 0 && <p className="text-on-surface-variant">{t('ops.orders_form_no_machines')}</p>}
            {machines.map((m) => (
              <label key={m.id} className="flex items-center gap-2 min-h-[36px]">
                <input type="checkbox" checked={picked.includes(m.id)} onChange={() => setPicked((p) => (p.includes(m.id) ? p.filter((x) => x !== m.id) : [...p, m.id]))} />
                {m.name}
              </label>
            ))}
          </fieldset>
          {formError && <p className="text-sm text-red-400 sm:col-span-2">{formError}</p>}
          <button type="submit" className="min-h-[48px] rounded-xl bg-primary text-on-primary font-bold sm:col-span-2">
            {t('ops.orders_form_add')}
          </button>
        </form>
      )}

      {orders === null ? (
        <p className="text-sm text-on-surface-variant">{t('ops.common_loading')}</p>
      ) : orders.length === 0 ? (
        <p className="text-sm text-on-surface-variant">{t('ops.orders_empty')}</p>
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
                {t('ops.orders_progress', {
                  made: o.good_made,
                  quantity: o.quantity,
                  due: dueText(o.due_at, language),
                  hours: o.hours_left,
                  rate: o.rate_per_hour ?? '—',
                })}
                {o.rate_needed_per_hour !== null && `, ${t('ops.orders_needs_rate', { rate: o.rate_needed_per_hour })}`}
                {o.projected_good !== null && ` · ${t('ops.orders_projected', { n: o.projected_good })}`}
                {o.first_pass_rate !== null && ` · ${t('ops.orders_yield', { pct: Math.round(o.first_pass_rate * 100) })}`}
              </div>
              <div className="text-xs text-on-surface-variant mt-1">
                {o.machines.map((m) => `${m.name}: ${stateLabel(t, m.state)}${m.last_alarm ? ` (${m.last_alarm})` : ''}`).join(' · ')}
              </div>
              <button
                type="button"
                onClick={async () => {
                  await closeOrder(o.order_id).catch(() => {});
                  load();
                }}
                className="mt-2 min-h-[44px] text-xs underline"
              >
                {t('ops.orders_close')}
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
              {v.main_constraint && <span className="text-on-surface-variant"> {t('ops.orders_constraint', { constraint: v.main_constraint })}</span>}
            </p>
          ))}
          {plan.report.actions.length > 0 && (
            <div>
              <h3 className="font-bold text-sm">{t('ops.orders_suggested_actions')}</h3>
              <ul className="list-disc pl-5 text-sm">
                {plan.report.actions.map((a, i) => (
                  <li key={i}>
                    {a.action} <span className="text-on-surface-variant">{a.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-on-surface-variant">{t('ops.orders_footer')}</p>
        </div>
      )}
    </section>
  );
};
