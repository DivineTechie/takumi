import type { ControlFeedItem } from './api';

/** Plain-language line for one control-tower event. */
export function describe(e: ControlFeedItem): string {
  const d = e.detail || {};
  switch (`${e.kind}.${e.event_type}`) {
    case 'station.step_done':
      return `Step ${e.step} verified`;
    case 'station.mistake':
      return `Mistake at step ${e.step}${d.reason ? `: ${d.reason}` : ''}`;
    case 'station.safety_stop':
      return `Safety stop at step ${e.step}`;
    case 'station.blocked':
      return `Unit blocked at step ${e.step}`;
    case 'station.station_completed':
      return `Station finished: ${d.steps_done ?? '?'} of ${d.steps_total ?? '?'} steps, ${d.mistakes ?? 0} mistake(s)`;
    case 'inspection.inspected':
      return e.status === 'defective' ? `Defect found${d.defect ? `: ${d.defect}` : ''}` : e.status === 'ok' ? 'Inspection OK' : 'Inspection needs review';
    case 'inspection.decision':
      return `Supervisor ${String(e.status ?? '').replace('_', ' ')}`;
    case 'machine.state_change':
      return `Machine ${d.from_state ?? '?'} → ${d.to_state ?? e.status}`;
    case 'machine.alarm':
      return `Alarm: ${d.alarm_text ?? ''}`;
    case 'machine.alarm_cleared':
      return 'Alarm cleared';
    case 'machine.count':
      return d.flag ? `Counter misread rejected (${d.count})` : `Count ${d.count}`;
    case 'machine.work_order_approved':
      return `Work order approved${d.title ? `: ${d.title}` : ''}`;
    case 'machine.work_order_dismissed':
      return `Work order dismissed${d.title ? `: ${d.title}` : ''}`;
    case 'unit.hold':
      return `Put on hold${d.reason ? `: ${d.reason}` : ''}`;
    case 'unit.release':
      return 'Released from hold';
    default:
      return `${e.kind} ${e.event_type}`;
  }
}
