import { describe, it, expect } from 'vitest';
import {
  watcherReducer,
  INITIAL_WATCHER_STATE,
  type WatcherStreakState,
} from './watcher';
import type { WatchResponse } from '../api';

function makeResponse(
  state: WatchResponse['state'],
  overrides?: Partial<WatchResponse>
): WatchResponse {
  return {
    state,
    reason: `Reason for ${state}`,
    fix: state === 'mistake' ? 'Fix it' : '',
    rule: state === 'hazard' ? 'No bare copper outside terminal' : null,
    secs: 0.5,
    ...overrides,
  };
}

describe('watcherReducer pure state machine', () => {
  it('done x1 produces NONE, done x2 produces ADVANCE_STEP, done x3 produces NONE', () => {
    let s: WatcherStreakState = { ...INITIAL_WATCHER_STATE, currentStep: 1 };

    // 1st done
    const r1 = watcherReducer(s, {
      type: 'READ',
      step: 1,
      watchResponse: makeResponse('done'),
      now: 1000,
    });
    expect(r1.state.consecutiveCount).toBe(1);
    expect(r1.effect.type).toBe('NONE');
    s = r1.state;

    // 2nd done
    const r2 = watcherReducer(s, {
      type: 'READ',
      step: 1,
      watchResponse: makeResponse('done'),
      now: 1500,
    });
    expect(r2.state.consecutiveCount).toBe(2);
    expect(r2.effect.type).toBe('ADVANCE_STEP');
    expect(r2.effect.step).toBe(1);
    s = r2.state;

    // 3rd done (should not re-trigger while step transition is pending)
    const r3 = watcherReducer(s, {
      type: 'READ',
      step: 1,
      watchResponse: makeResponse('done'),
      now: 2000,
    });
    expect(r3.state.consecutiveCount).toBe(3);
    expect(r3.effect.type).toBe('NONE');
  });

  it('mistake x2 triggers WARN_MISTAKE, then enforces 8s cooldown before next warning', () => {
    let s: WatcherStreakState = { ...INITIAL_WATCHER_STATE, currentStep: 2 };

    // 1st mistake -> NONE
    const r1 = watcherReducer(s, {
      type: 'READ',
      step: 2,
      watchResponse: makeResponse('mistake'),
      now: 1000,
    });
    expect(r1.effect.type).toBe('NONE');
    s = r1.state;

    // 2nd mistake at t=2000 -> WARN_MISTAKE
    const r2 = watcherReducer(s, {
      type: 'READ',
      step: 2,
      watchResponse: makeResponse('mistake'),
      now: 2000,
    });
    expect(r2.effect.type).toBe('WARN_MISTAKE');
    expect(r2.state.lastMistakeWarningTime).toBe(2000);
    s = r2.state;

    // 3rd mistake at t=5000 (only 3s later, under 8s cooldown) -> NONE
    const r3 = watcherReducer(s, {
      type: 'READ',
      step: 2,
      watchResponse: makeResponse('mistake'),
      now: 5000,
    });
    expect(r3.effect.type).toBe('NONE');
    s = r3.state;

    // 4th mistake at t=10001 (8001ms later) -> WARN_MISTAKE
    const r4 = watcherReducer(s, {
      type: 'READ',
      step: 2,
      watchResponse: makeResponse('mistake'),
      now: 10001,
    });
    expect(r4.effect.type).toBe('WARN_MISTAKE');
    expect(r4.state.lastMistakeWarningTime).toBe(10001);
  });

  it('not_visible x4 triggers NUDGE_NOT_VISIBLE and enforces 12s cooldown; never triggers mistake', () => {
    let s: WatcherStreakState = { ...INITIAL_WATCHER_STATE, currentStep: 1 };

    // 1st, 2nd, 3rd not_visible -> NONE
    for (let i = 1; i <= 3; i++) {
      const r = watcherReducer(s, {
        type: 'READ',
        step: 1,
        watchResponse: makeResponse('not_visible'),
        now: i * 500,
      });
      expect(r.effect.type).toBe('NONE');
      s = r.state;
    }
    expect(s.consecutiveCount).toBe(3);

    // 4th not_visible at t=2000 -> NUDGE_NOT_VISIBLE
    const r4 = watcherReducer(s, {
      type: 'READ',
      step: 1,
      watchResponse: makeResponse('not_visible'),
      now: 2000,
    });
    expect(r4.effect.type).toBe('NUDGE_NOT_VISIBLE');
    expect(r4.state.lastNotVisibleNudgeTime).toBe(2000);
    s = r4.state;

    // 5th not_visible at t=8000 (under 12s cooldown) -> NONE
    const r5 = watcherReducer(s, {
      type: 'READ',
      step: 1,
      watchResponse: makeResponse('not_visible'),
      now: 8000,
    });
    expect(r5.effect.type).toBe('NONE');
    s = r5.state;

    // 6th not_visible at t=14001 (12001ms later) -> NUDGE_NOT_VISIBLE
    const r6 = watcherReducer(s, {
      type: 'READ',
      step: 1,
      watchResponse: makeResponse('not_visible'),
      now: 14001,
    });
    expect(r6.effect.type).toBe('NUDGE_NOT_VISIBLE');
    expect(r6.state.lastNotVisibleNudgeTime).toBe(14001);
  });

  it('hazard x1 immediately triggers SAFETY_STOP with the rule', () => {
    const s: WatcherStreakState = { ...INITIAL_WATCHER_STATE, currentStep: 3 };

    const r = watcherReducer(s, {
      type: 'READ',
      step: 3,
      watchResponse: makeResponse('hazard', { rule: 'Disconnect power before servicing' }),
      now: 1000,
    });

    expect(r.effect.type).toBe('SAFETY_STOP');
    expect(r.effect.rule).toBe('Disconnect power before servicing');
    expect(r.state.consecutiveCount).toBe(1);
    expect(r.state.lastState).toBe('hazard');
  });

  it('error state resets consecutive streak and clears lastState', () => {
    const s: WatcherStreakState = {
      currentStep: 1,
      lastState: 'done',
      consecutiveCount: 1,
      lastMistakeWarningTime: 0,
      lastNotVisibleNudgeTime: 0,
    };

    const r = watcherReducer(s, {
      type: 'READ',
      step: 1,
      watchResponse: makeResponse('error', { reason: 'TimeoutError' }),
      now: 2000,
    });

    expect(r.state.consecutiveCount).toBe(0);
    expect(r.state.lastState).toBeNull();
    expect(r.effect.type).toBe('NONE');
  });

  it('step change resets streak count to 1 for the new step', () => {
    const s: WatcherStreakState = {
      currentStep: 1,
      lastState: 'done',
      consecutiveCount: 2,
      lastMistakeWarningTime: 0,
      lastNotVisibleNudgeTime: 0,
    };

    // New read arrives on step 2
    const r = watcherReducer(s, {
      type: 'READ',
      step: 2,
      watchResponse: makeResponse('in_progress'),
      now: 3000,
    });

    expect(r.state.currentStep).toBe(2);
    expect(r.state.lastState).toBe('in_progress');
    expect(r.state.consecutiveCount).toBe(1);
    expect(r.effect.type).toBe('NONE');
  });

  it('RESET action resets streak and state for given step', () => {
    const s: WatcherStreakState = {
      currentStep: 2,
      lastState: 'mistake',
      consecutiveCount: 3,
      lastMistakeWarningTime: 5000,
      lastNotVisibleNudgeTime: 5000,
    };

    const r = watcherReducer(s, {
      type: 'RESET',
      step: 2,
    });

    expect(r.state.consecutiveCount).toBe(0);
    expect(r.state.lastState).toBeNull();
    expect(r.effect.type).toBe('NONE');
  });
});
