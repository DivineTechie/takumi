import type { ControlFeedItem } from './api';
import { getTranslation } from '../i18n';

/** Translation function, as returned by useI18n(). */
export type TFn = (key: string, params?: Record<string, string | number>) => string;

const KNOWN_STATES = ['running', 'idle', 'stopped'];

/** Translated machine state; unknown values from the API are shown as they are. */
export function stateLabel(t: TFn, state: string | null | undefined): string {
  if (!state) return t('ops.common_state_unknown');
  return KNOWN_STATES.includes(state) ? t(`ops.common_state_${state}`) : state;
}

/** "12s ago" / "3 min ago" / "2 h ago" (hours only when `withHours` is set). */
export function agoText(t: TFn, seconds: number, withHours = false): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < (withHours ? 90 : 60)) return t('ops.common_s_ago', { n: s });
  if (!withHours || s < 5400) return t('ops.common_min_ago', { n: Math.round(s / 60) });
  return t('ops.common_h_ago', { n: Math.round(s / 3600) });
}

const english: TFn = (key, params) => getTranslation('en', key, params);

/** Plain-language line for one control-tower event (English when no `t` is given). */
export function describe(e: ControlFeedItem, t: TFn = english, names: Record<string, string> = {}): string {
  const name = e.kind === 'machine' && e.machine_id ? names[e.machine_id] : undefined;
  const line = describeEvent(e, t, !!name);
  return name ? `${name} · ${line}` : line;
}

function describeEvent(e: ControlFeedItem, t: TFn, named: boolean): string {
  const d = e.detail || {};
  const step = e.step ?? '?';
  switch (`${e.kind}.${e.event_type}`) {
    case 'station.step_done':
      return t('ops.event_step_verified', { step });
    case 'station.mistake':
      return d.reason ? t('ops.event_mistake_reason', { step, reason: String(d.reason) }) : t('ops.event_mistake', { step });
    case 'station.safety_stop':
      return t('ops.event_safety_stop', { step });
    case 'station.blocked':
      return t('ops.event_unit_blocked', { step });
    case 'station.station_completed':
      return t('ops.event_station_finished', {
        done: String(d.steps_done ?? '?'),
        total: String(d.steps_total ?? '?'),
        mistakes: String(d.mistakes ?? 0),
      });
    case 'inspection.inspected':
      return e.status === 'defective'
        ? d.defect
          ? t('ops.event_defect_found_detail', { defect: String(d.defect) })
          : t('ops.event_defect_found')
        : e.status === 'ok'
          ? t('ops.event_inspection_ok')
          : t('ops.event_inspection_review');
    case 'inspection.decision':
      return t('ops.event_supervisor_decision', { decision: String(e.status ?? '').replace('_', ' ') });
    case 'machine.state_change':
      // The first reading of a newly watched machine has no previous state.
      if (!d.from_state) return t('ops.event_machine_first', { to: stateLabel(t, String(d.to_state ?? e.status ?? '')) });
      return t(named ? 'ops.event_state_short' : 'ops.event_machine_state', {
        from: stateLabel(t, String(d.from_state)),
        to: stateLabel(t, String(d.to_state ?? e.status ?? '')),
      });
    case 'machine.alarm':
      return t('ops.event_alarm', { alarm: String(d.alarm_text ?? '') });
    case 'machine.alarm_cleared':
      return t('ops.event_alarm_cleared');
    case 'machine.count':
      return d.flag ? t('ops.event_counter_rejected', { count: String(d.count) }) : t('ops.event_count', { count: String(d.count) });
    case 'machine.work_order_approved':
      return d.title ? t('ops.event_wo_approved_title', { title: String(d.title) }) : t('ops.event_wo_approved');
    case 'machine.work_order_dismissed':
      return d.title ? t('ops.event_wo_dismissed_title', { title: String(d.title) }) : t('ops.event_wo_dismissed');
    case 'unit.hold':
      return d.reason ? t('ops.event_hold_reason', { reason: String(d.reason) }) : t('ops.event_hold');
    case 'unit.release':
      return t('ops.event_released');
    default:
      return `${e.kind} ${e.event_type}`;
  }
}
