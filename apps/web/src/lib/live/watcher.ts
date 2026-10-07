import type { WatchResponse } from '../api';

export type WatcherState =
  | 'done'
  | 'in_progress'
  | 'mistake'
  | 'not_visible'
  | 'hazard'
  | 'error';

export interface WatcherStreakState {
  currentStep: number;
  lastState: WatcherState | null;
  consecutiveCount: number;
  lastMistakeWarningTime: number; // ms timestamp
  lastNotVisibleNudgeTime: number; // ms timestamp
}

export type WatcherEffectType =
  | 'NONE'
  | 'ADVANCE_STEP'
  | 'WARN_MISTAKE'
  | 'NUDGE_NOT_VISIBLE'
  | 'SAFETY_STOP';

export interface WatcherEffect {
  type: WatcherEffectType;
  step: number;
  reason: string;
  fix: string;
  rule?: string | null;
}

export type WatcherAction =
  | {
      type: 'READ';
      step: number;
      watchResponse: WatchResponse;
      now: number; // deterministic timestamp ms
    }
  | {
      type: 'RESET';
      step: number;
    };

export const INITIAL_WATCHER_STATE: WatcherStreakState = {
  currentStep: 1,
  lastState: null,
  consecutiveCount: 0,
  lastMistakeWarningTime: -Infinity,
  lastNotVisibleNudgeTime: -Infinity,
};

export interface WatcherReducerResult {
  state: WatcherStreakState;
  effect: WatcherEffect;
}

/**
 * Pure reducer for step watcher frame decisions.
 * Tracks consecutive state streaks per step and emits high-level coach effects.
 */
export function watcherReducer(
  state: WatcherStreakState,
  action: WatcherAction
): WatcherReducerResult {
  if (action.type === 'RESET') {
    return {
      state: {
        ...state,
        currentStep: action.step,
        lastState: null,
        consecutiveCount: 0,
      },
      effect: {
        type: 'NONE',
        step: action.step,
        reason: '',
        fix: '',
        rule: null,
      },
    };
  }

  const { step, watchResponse, now } = action;
  const readState = watchResponse.state;

  // 1. Any step change resets streak to count 1 of new read or 0 on error
  let consecutiveCount = 1;
  const isSameStep = step === state.currentStep;

  if (!isSameStep) {
    // Step changed
    if (readState === 'error') {
      return {
        state: {
          ...state,
          currentStep: step,
          lastState: null,
          consecutiveCount: 0,
        },
        effect: {
          type: 'NONE',
          step,
          reason: watchResponse.reason,
          fix: watchResponse.fix,
          rule: watchResponse.rule ?? null,
        },
      };
    }
    consecutiveCount = 1;
  } else {
    // Same step
    if (readState === 'error') {
      // Error read resets streak
      return {
        state: {
          ...state,
          lastState: null,
          consecutiveCount: 0,
        },
        effect: {
          type: 'NONE',
          step,
          reason: watchResponse.reason,
          fix: watchResponse.fix,
          rule: watchResponse.rule ?? null,
        },
      };
    }

    if (readState === state.lastState) {
      consecutiveCount = state.consecutiveCount + 1;
    } else {
      consecutiveCount = 1;
    }
  }

  const newState: WatcherStreakState = {
    ...state,
    currentStep: step,
    lastState: readState,
    consecutiveCount,
  };

  // 2. Evaluate streak rules:
  // - hazard x1 -> SAFETY STOP immediately
  if (readState === 'hazard') {
    return {
      state: newState,
      effect: {
        type: 'SAFETY_STOP',
        step,
        reason: watchResponse.reason,
        fix: watchResponse.fix,
        rule: watchResponse.rule ?? null,
      },
    };
  }

  // - done x2 -> ADVANCE_STEP (only on the 2nd consecutive read to avoid duplicate triggers)
  if (readState === 'done') {
    if (consecutiveCount === 2) {
      return {
        state: newState,
        effect: {
          type: 'ADVANCE_STEP',
          step,
          reason: watchResponse.reason,
          fix: watchResponse.fix,
        },
      };
    }
    return {
      state: newState,
      effect: {
        type: 'NONE',
        step,
        reason: watchResponse.reason,
        fix: watchResponse.fix,
      },
    };
  }

  // - mistake x2 -> WARN_MISTAKE if at least 8s since previous warning
  if (readState === 'mistake') {
    if (consecutiveCount >= 2 && now - state.lastMistakeWarningTime >= 8000) {
      return {
        state: {
          ...newState,
          lastMistakeWarningTime: now,
        },
        effect: {
          type: 'WARN_MISTAKE',
          step,
          reason: watchResponse.reason,
          fix: watchResponse.fix,
        },
      };
    }
    return {
      state: newState,
      effect: {
        type: 'NONE',
        step,
        reason: watchResponse.reason,
        fix: watchResponse.fix,
      },
    };
  }

  // - not_visible x4 -> NUDGE_NOT_VISIBLE if at least 12s since previous nudge
  if (readState === 'not_visible') {
    if (consecutiveCount >= 4 && now - state.lastNotVisibleNudgeTime >= 12000) {
      return {
        state: {
          ...newState,
          lastNotVisibleNudgeTime: now,
        },
        effect: {
          type: 'NUDGE_NOT_VISIBLE',
          step,
          reason: watchResponse.reason,
          fix: watchResponse.fix,
        },
      };
    }
    return {
      state: newState,
      effect: {
        type: 'NONE',
        step,
        reason: watchResponse.reason,
        fix: watchResponse.fix,
      },
    };
  }

  // - in_progress -> no action
  return {
    state: newState,
    effect: {
      type: 'NONE',
      step,
      reason: watchResponse.reason,
      fix: watchResponse.fix,
    },
  };
}
