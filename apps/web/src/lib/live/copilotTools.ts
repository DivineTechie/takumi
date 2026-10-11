import {
  fetchControlSummary,
  fetchMachines,
  fetchOrders,
  fetchWorkOrders,
  runDemandAgent,
  type Machine,
  type WorkOrder,
} from '../api';
import type { CopilotTool } from './copilot';
import { visibleMachines } from '../machinesView';

/** Readings older than this are reported as "no camera", the same rule as the control tower. */
const STALE_MS = 15 * 60_000;

function sourceOf(m: Machine): string {
  return m.source === 'VIRTUAL' ? 'HOME RIG' : 'LIVE';
}

export function summariseMachines(machines: Machine[], now = Date.now()) {
  return machines.map((m) => {
    const seen = m.last_seen_at ? Date.parse(m.last_seen_at) : null;
    const stale = seen === null || now - seen > STALE_MS;
    return {
      name: m.name,
      state: stale ? 'no camera watching' : (m.state ?? 'unknown'),
      alarm: stale ? null : (m.last_alarm ?? null),
      parts_counted: m.last_count ?? null,
      minutes_since_last_reading: seen === null ? null : Math.round((now - seen) / 60_000),
      source: sourceOf(m),
    };
  });
}

export function summariseWorkOrders(orders: WorkOrder[]) {
  return orders.slice(0, 5).map((w) => ({
    machine: w.machine_name,
    status: w.status,
    title: w.draft.title,
    priority: w.draft.priority,
    summary: w.draft.summary,
    most_likely_cause: w.draft.likely_causes[0]?.cause ?? null,
    first_steps: w.draft.steps.slice(0, 3),
    source: w.source,
  }));
}

/**
 * Tools for the voice copilot. `draftWorkOrder` hands the request to the work-order panel, which runs
 * the maintenance agent visibly and resolves with the draft (or null).
 */
export function buildCopilotTools(draftWorkOrder: (machine: Machine) => Promise<WorkOrder | null>): CopilotTool[] {
  return [
    {
      name: 'get_machines_now',
      description: 'Current state of every watched machine: running, idle, stopped or no camera; alarm text; parts counted; source label.',
      run: async () => ({ machines: summariseMachines(visibleMachines(await fetchMachines()).shown) }),
    },
    {
      name: 'get_orders',
      description: "Today's open orders projected from real machine counts and inspection yield: good parts made, projected at due time, shortfall, on track or not.",
      run: async () => ({
        orders: (await fetchOrders()).map((o) => ({
          name: o.name,
          quantity: o.quantity,
          good_made: o.good_made,
          projected_good_at_due_time: o.projected_good,
          shortfall: o.shortfall,
          on_track: o.on_track,
          hours_left: Math.round(o.hours_left * 10) / 10,
          machines: o.machines.map((m) => ({ name: m.name, state: m.state, alarm: m.last_alarm })),
          source: o.source,
        })),
      }),
    },
    {
      name: 'get_quality',
      description: 'Quality and operations totals for the last 24 hours per source label: units inspected, first-pass rate, confirmed defects, units on hold, station mistakes, safety stops, machine stops.',
      run: async () => {
        const s = await fetchControlSummary(24);
        return { hours: s.hours, by_source: s.by_source, last_event_at: s.last_event_at };
      },
    },
    {
      name: 'get_work_orders',
      description: 'The latest maintenance work orders drafted by the maintenance agent, with status, likely cause and first steps.',
      run: async () => ({ work_orders: summariseWorkOrders(await fetchWorkOrders()) }),
    },
    {
      name: 'draft_work_order',
      description: 'Ask the maintenance agent to investigate a stopped machine and draft a work order. Takes about 20 seconds. The supervisor approves it on screen.',
      parameters: {
        type: 'OBJECT',
        properties: { machine_name: { type: 'STRING', description: 'Machine name as returned by get_machines_now, e.g. "Press 2".' } },
        required: ['machine_name'],
      },
      run: async (args) => {
        const wanted = String(args.machine_name ?? '').trim().toLowerCase();
        const machines = await fetchMachines();
        const now = Date.now();
        const fresh = machines
          .filter((m) => m.name.toLowerCase() === wanted || m.name.toLowerCase().includes(wanted))
          .filter((m) => m.last_seen_at && now - Date.parse(m.last_seen_at) <= STALE_MS)
          .sort((a, b) => Date.parse(b.last_seen_at as string) - Date.parse(a.last_seen_at as string));
        const machine = fresh.find((m) => m.state === 'stopped') ?? fresh[0];
        if (!machine) return { error: `No watched machine called "${args.machine_name}".` };
        if (machine.state !== 'stopped') return { error: `${machine.name} is ${machine.state}, not stopped; no work order needed.` };
        const wo = await draftWorkOrder(machine);
        if (!wo) return { error: 'The maintenance agent could not draft a work order.' };
        return { drafted: summariseWorkOrders([wo])[0], note: 'Waiting for the supervisor to approve on screen.' };
      },
    },
    {
      name: 'ask_planner',
      description: "Ask the production planner agent whether today's orders will be met and what actions to take. Takes 15 to 30 seconds.",
      run: async () => {
        const r = await runDemandAgent();
        return { summary: r.report.summary, actions: r.report.actions, confidence: r.report.confidence };
      },
    },
  ];
}
