import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CoachLiveView } from './CoachLiveView';
import * as apiModule from '../lib/api';
import { GeminiLiveClient } from '../lib/live/client';
import type { LiveClientCallbacks } from '../lib/live/types';
import type { Skill } from '../../../../shared/schema/ts/skills';
import type { Session } from '../../../../shared/schema/ts/sessions';
import type { SessionEvent } from '../../../../shared/schema/ts/session_events';
import seedSkill from '../../../../shared/seed/skill_terminal_wiring_v1.json';

const typedSkill = seedSkill as unknown as Skill;

// Mock APIs
vi.mock('../lib/api', () => ({
  verify: vi.fn(),
  point: vi.fn(),
  watch: vi.fn().mockResolvedValue({
    state: 'in_progress',
    reason: 'in progress',
    fix: '',
    secs: 0.5,
  }),
  createSession: vi.fn(),
  postSessionEvent: vi.fn(),
  endSession: vi.fn(),
  liveToken: vi.fn(),
}));

// Mock Live Client
const mockSendText = vi.fn();
const mockSendCameraEvent = vi.fn();
const mockManualRetry = vi.fn();
const mockStopGating = vi.fn();
const mockClose = vi.fn();
const mockConnect = vi.fn().mockImplementation(() => {
  capturedCallbacks.onStateChange?.('connected');
  mockSendText(
    '[SESSION START] The trainee is ready at the bench. Greet them briefly and announce step 1.'
  );
});
let capturedCallbacks: Partial<LiveClientCallbacks> = {};

vi.mock('../lib/live/client', () => {
  return {
    computeMedian: vi.fn(() => 500),
    GeminiLiveClient: vi.fn().mockImplementation((config: { callbacks: LiveClientCallbacks }) => {
      capturedCallbacks = config.callbacks;
      return {
        connect: mockConnect,
        sendAudio: vi.fn(),
        sendVideoFrame: vi.fn(),
        sendText: mockSendText,
        sendCameraEvent: mockSendCameraEvent,
        stopGating: mockStopGating,
        manualRetry: mockManualRetry,
        setSpeakerMode: vi.fn(),
        getSpeakerMode: vi.fn(() => true),
        isGating: vi.fn(() => false),
        getState: vi.fn(() => 'connected'),
        getStats: vi.fn(() => ({
          setupCompleteReceived: true,
          setupCompleteMs: 250,
          micChunksSent: 10,
          videoFramesSent: 2,
          audioChunksReceived: 5,
          transcriptsReceived: 2,
          lastCloseCode: null,
          lastCloseReason: '',
          interruptedCount: 0,
          playbackUnderruns: 0,
          isGating: false,
          tokenFetchMs: 120,
          timeToFirstAudioMs: 450,
          lastVerifyLatencyMs: 850,
          medianVerifyLatencyMs: 850,
          lastPointLatencyMs: 400,
          medianPointLatencyMs: 400,
          lastToolLatencyMs: 850,
          medianToolLatencyMs: 625,
        })),
        close: mockClose,
      };
    }),
  };
});

// Mock audio
vi.mock('../lib/live/audio', () => ({
  OutputAudioQueue: vi.fn().mockImplementation(() => ({
    enqueue: vi.fn(),
    flush: vi.fn(),
    endTurn: vi.fn(),
    isPlayingWithTail: vi.fn(() => false),
    getUnderrunCount: vi.fn(() => 0),
  })),
  setupMicCapture: vi.fn().mockResolvedValue({
    activeContext: {},
    stop: vi.fn(),
  }),
}));

// Mock video
vi.mock('../lib/live/video', () => ({
  isCameraMirrored: vi.fn(() => false),
  captureVideoFrame: vi.fn(() => 'fake_1280_frame'),
  captureVideoFrameAsync: vi.fn().mockResolvedValue('fake_768_frame'),
}));

describe('CoachLiveView Pass 2 Tools & Session Workflow', () => {
  let mockStream: MediaStream;
  let mockAudioContext: AudioContext;

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, '', '?debug=1');

    HTMLMediaElement.prototype.play = vi.fn().mockImplementation(() => Promise.resolve());
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      measureText: vi.fn(() => ({ width: 50 })),
      fillText: vi.fn(),
      roundRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
    } as unknown as CanvasRenderingContext2D);

    mockStream = {
      getVideoTracks: vi.fn(() => [{ getSettings: () => ({ facingMode: 'environment' }) }]),
      getAudioTracks: vi.fn(() => [
        {
          getSettings: () => ({
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }),
        },
      ]),
    } as unknown as MediaStream;

    mockAudioContext = {
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      currentTime: 0,
      destination: {},
      createOscillator: vi.fn().mockReturnValue({
        type: 'sine',
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }),
      createGain: vi.fn().mockReturnValue({
        gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      }),
    } as unknown as AudioContext;

    vi.mocked(apiModule.createSession).mockResolvedValue({
      id: 'session-live-123',
      skill_id: typedSkill.id,
      trainee_uid: 'uid-test',
      language: 'en',
      started_at: new Date().toISOString(),
      status: 'active',
      steps: [],
    } as unknown as Session);

    vi.mocked(apiModule.postSessionEvent).mockResolvedValue({
      id: 'event-1',
      session_id: 'session-live-123',
      step: 1,
      type: 'verify',
      source: 'verify',
      created_at: new Date().toISOString(),
    } as unknown as SessionEvent);

    vi.mocked(apiModule.endSession).mockResolvedValue({
      id: 'session-live-123',
      status: 'completed',
    } as unknown as Session);
  });

  it('initializes session document on mount with skill_id and language', async () => {
    render(
      <MemoryRouter>
        <CoachLiveView
          skill={typedSkill}
          language="en"
          stream={mockStream}
          outputAudioContext={mockAudioContext}
          micAudioContext={mockAudioContext}
          onEnd={vi.fn()}
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(apiModule.createSession).toHaveBeenCalledWith({
        skill_id: typedSkill.id,
        language: 'en',
      });
    });
  });

  it('verify_step tool call verifies image, logs verify event, and advances step when passed', async () => {
    vi.mocked(apiModule.verify).mockResolvedValue({
      passed: true,
      visible: true,
      reason: 'Blue wire ferrule correctly inserted into terminal 1',
      fix: '',
      secs: 1.2,
    });

    render(
      <MemoryRouter>
        <CoachLiveView
          skill={typedSkill}
          language="en"
          stream={mockStream}
          outputAudioContext={mockAudioContext}
          micAudioContext={mockAudioContext}
          onEnd={vi.fn()}
        />
      </MemoryRouter>
    );

    // Wait for session initialization
    await waitFor(() => {
      expect(apiModule.createSession).toHaveBeenCalled();
    });

    // Initial step is 1
    expect(screen.getByText('Step 1 of 4')).toBeDefined();

    // Trigger verify_step tool call
    const result = await capturedCallbacks.onToolCall!({
      id: 'call-v1',
      name: 'verify_step',
      args: { step: 1 },
    });

    expect(result).toEqual({
      passed: true,
      visible: true,
      reason: 'Blue wire ferrule correctly inserted into terminal 1',
      fix: '',
    });

    // Check verify event was posted
    await waitFor(() => {
      expect(apiModule.postSessionEvent).toHaveBeenCalledWith(
        'session-live-123',
        expect.objectContaining({
          step: 1,
          type: 'verify',
          source: 'verify',
        })
      );
    });

    // Check step_done event was posted
    await waitFor(() => {
      expect(apiModule.postSessionEvent).toHaveBeenCalledWith(
        'session-live-123',
        expect.objectContaining({
          step: 1,
          type: 'step_done',
          source: 'verify',
        })
      );
    });

    // Step has advanced to step 2!
    await waitFor(() => {
      expect(screen.getByText('Step 2 of 4')).toBeDefined();
    });
  });

  it('point_at tool call requests points from /api/point and logs point event', async () => {
    vi.mocked(apiModule.point).mockResolvedValue({
      points: [{ point: [350, 420], label: 'terminal 1' }],
      secs: 0.8,
    });

    render(
      <MemoryRouter>
        <CoachLiveView
          skill={typedSkill}
          language="en"
          stream={mockStream}
          outputAudioContext={mockAudioContext}
          micAudioContext={mockAudioContext}
          onEnd={vi.fn()}
        />
      </MemoryRouter>
    );

    // Wait for session initialization
    await waitFor(() => {
      expect(apiModule.createSession).toHaveBeenCalled();
    });

    const result = await capturedCallbacks.onToolCall!({
      id: 'call-p1',
      name: 'point_at',
      args: { target: 'terminal 1' },
    });

    expect(result).toEqual({ result: { shown: 1 } });

    expect(apiModule.point).toHaveBeenCalledWith({
      target: 'terminal 1',
      image_b64: 'fake_1280_frame',
    });

    await waitFor(() => {
      expect(apiModule.postSessionEvent).toHaveBeenCalledWith(
        'session-live-123',
        expect.objectContaining({
          step: 1,
          type: 'point',
          source: 'coach',
          reason: 'terminal 1',
        })
      );
    });
  });

  it('shows 06_lesson_complete screen and marks session completed on final step verification', async () => {
    vi.mocked(apiModule.verify).mockResolvedValue({
      passed: true,
      visible: true,
      reason: 'Grey wire ferrule correctly inserted into terminal 4',
      fix: '',
      secs: 1.1,
    });

    render(
      <MemoryRouter>
        <CoachLiveView
          skill={typedSkill}
          language="en"
          stream={mockStream}
          outputAudioContext={mockAudioContext}
          micAudioContext={mockAudioContext}
          onEnd={vi.fn()}
        />
      </MemoryRouter>
    );

    // Wait for session initialization
    await waitFor(() => {
      expect(apiModule.createSession).toHaveBeenCalled();
    });

    // Simulate advancing to step 4
    const devWindow = window as unknown as { __TAKUMI_ADVANCE_STEP__?: () => void };
    devWindow.__TAKUMI_ADVANCE_STEP__?.(); // -> 2
    devWindow.__TAKUMI_ADVANCE_STEP__?.(); // -> 3
    devWindow.__TAKUMI_ADVANCE_STEP__?.(); // -> 4

    // Final step verification
    await capturedCallbacks.onToolCall?.({
      id: 'call-v4',
      name: 'verify_step',
      args: { step: 4 },
    });

    // Session completed called
    await waitFor(() => {
      expect(apiModule.endSession).toHaveBeenCalledWith('session-live-123', 'completed');
    });

    // Lesson complete screen appears
    await waitFor(() => {
      expect(screen.getByText('All 4 steps done')).toBeDefined();
      expect(screen.getByText('4 OF 4 STEPS VERIFIED')).toBeDefined();
    });
  });

  it('Ask Why button sends text to coach and logs ask_why session event', async () => {
    render(
      <MemoryRouter>
        <CoachLiveView
          skill={typedSkill}
          language="en"
          stream={mockStream}
          outputAudioContext={mockAudioContext}
          micAudioContext={mockAudioContext}
          onEnd={vi.fn()}
        />
      </MemoryRouter>
    );

    // Wait for session document creation so sessionIdRef is set
    await waitFor(() => {
      expect(apiModule.createSession).toHaveBeenCalled();
    });

    const whyBtn = screen.getByRole('button', { name: /Why\?/i });
    fireEvent.click(whyBtn);

    expect(mockSendText).toHaveBeenCalledWith(
      'The trainee asks: why is this step done this way?'
    );

    expect(apiModule.postSessionEvent).toHaveBeenCalledWith(
      'session-live-123',
      expect.objectContaining({
        step: 1,
        type: 'ask_why',
        source: 'trainee',
      })
    );
  });

  it('0a: verify_step always checks current step regardless of step arg and returns current_step on mismatch', async () => {
    vi.mocked(apiModule.verify).mockResolvedValue({
      passed: false,
      visible: true,
      reason: 'Bare wire still loose',
      fix: 'Tighten screw completely',
      secs: 0.9,
    });

    render(
      <MemoryRouter>
        <CoachLiveView
          skill={typedSkill}
          language="en"
          stream={mockStream}
          outputAudioContext={mockAudioContext}
          micAudioContext={mockAudioContext}
          onEnd={vi.fn()}
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(apiModule.createSession).toHaveBeenCalled();
    });

    // Model attempts to verify step 3 while user is actually on step 1
    const result = await capturedCallbacks.onToolCall!({
      id: 'call-mismatch',
      name: 'verify_step',
      args: { step: 3 },
    });

    // verify API was called with step 1's instruction, not step 3
    expect(apiModule.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 1,
        instruction: typedSkill.steps[0].instruction,
      })
    );

    // tool result includes current_step: 1 indicating mismatch
    expect(result).toEqual({
      passed: false,
      visible: true,
      reason: 'Bare wire still loose',
      fix: 'Tighten screw completely',
      current_step: 1,
    });
  });

  it('0b: advanceStep is idempotent and logs step_done only when actually advancing', async () => {
    vi.mocked(apiModule.verify).mockResolvedValue({
      passed: true,
      visible: true,
      reason: 'Done',
      fix: '',
      secs: 0.8,
    });

    render(
      <MemoryRouter>
        <CoachLiveView
          skill={typedSkill}
          language="en"
          stream={mockStream}
          outputAudioContext={mockAudioContext}
          micAudioContext={mockAudioContext}
          onEnd={vi.fn()}
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(apiModule.createSession).toHaveBeenCalled();
    });

    // First verification on step 1 passes and advances
    await capturedCallbacks.onToolCall!({
      id: 'call-adv-1',
      name: 'verify_step',
      args: { step: 1 },
    });

    await waitFor(() => {
      expect(screen.getByText(/Step\s+2\s+of\s+4/i)).toBeDefined();
    });

    // Call advanceStep with old step (1) again via debug hook
    const devWindow = window as unknown as { __TAKUMI_ADVANCE_STEP__?: (from?: number) => boolean };
    const secondAdvanceResult = devWindow.__TAKUMI_ADVANCE_STEP__?.(1);

    expect(secondAdvanceResult).toBe(false);
    // Still on step 2
    expect(screen.getByText(/Step\s+2\s+of\s+4/i)).toBeDefined();
  });

  it('A4: Safety Sentinel triggers STOP overlay and resumes on Made Safe button tap', async () => {
    render(
      <MemoryRouter>
        <CoachLiveView
          skill={typedSkill}
          language="en"
          stream={mockStream}
          outputAudioContext={mockAudioContext}
          micAudioContext={mockAudioContext}
          onEnd={vi.fn()}
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(apiModule.createSession).toHaveBeenCalled();
    });

    // Trigger simulated hazard
    const devWindow = window as unknown as { __TAKUMI_SIMULATE_HAZARD__?: () => void };
    devWindow.__TAKUMI_SIMULATE_HAZARD__?.();

    // Alert dialog STOP is displayed
    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeDefined();
    });
    expect(screen.getByText('STOP')).toBeDefined();
    expect(screen.getByText("I've made it safe")).toBeDefined();

    // Verify safety_stop session event was logged
    expect(apiModule.postSessionEvent).toHaveBeenCalledWith(
      'session-live-123',
      expect.objectContaining({
        type: 'safety_stop',
        source: 'watcher',
      })
    );

    // Tap "I've made it safe"
    const safeBtn = screen.getByRole('button', { name: "I've made it safe" });
    fireEvent.click(safeBtn);

    // Overlay is removed
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  it('A4: Safety Sentinel displays localized Unsafe condition when hazard rule is null', async () => {
    render(
      <MemoryRouter>
        <CoachLiveView
          skill={{ ...typedSkill, safety_rules: [] }}
          language="en"
          stream={mockStream}
          outputAudioContext={mockAudioContext}
          micAudioContext={mockAudioContext}
          onEnd={vi.fn()}
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(apiModule.createSession).toHaveBeenCalled();
    });

    const devWindow = window as unknown as { __TAKUMI_SIMULATE_HAZARD__?: () => void };
    devWindow.__TAKUMI_SIMULATE_HAZARD__?.();

    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeDefined();
    });
    expect(screen.getByText('Unsafe condition')).toBeDefined();
  });

  it('A3: Step Watcher status chip is displayed in DOM', async () => {
    render(
      <MemoryRouter>
        <CoachLiveView
          skill={typedSkill}
          language="en"
          stream={mockStream}
          outputAudioContext={mockAudioContext}
          micAudioContext={mockAudioContext}
          onEnd={vi.fn()}
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(apiModule.createSession).toHaveBeenCalled();
    });

    // Watcher status chip is present
    await waitFor(() => {
      expect(screen.getByTestId('watcher-status-chip')).toBeDefined();
    });
    const chip = screen.getByTestId('watcher-status-chip');
    expect(chip.textContent).toMatch(/Step 1: in progress|checking…|Can't see the work area/i);
  });

  it('creates GeminiLiveClient once per session and sends kickoff once across re-renders', async () => {
    let onEndFn = vi.fn();
    let handleTranscriptFn = vi.fn();

    const { rerender } = render(
      <MemoryRouter>
        <CoachLiveView
          skill={typedSkill}
          language="en"
          stream={mockStream}
          outputAudioContext={mockAudioContext}
          micAudioContext={mockAudioContext}
          onEnd={onEndFn}
          handleTranscript={handleTranscriptFn}
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(apiModule.createSession).toHaveBeenCalled();
    });

    // Re-render 3 times with new onEnd and handleTranscript identities and a new-but-equal skill object
    for (let i = 1; i <= 3; i++) {
      onEndFn = vi.fn();
      handleTranscriptFn = vi.fn();
      const clonedSkill = JSON.parse(JSON.stringify(typedSkill));
      rerender(
        <MemoryRouter>
          <CoachLiveView
            skill={clonedSkill}
            language="en"
            stream={mockStream}
            outputAudioContext={mockAudioContext}
            micAudioContext={mockAudioContext}
            onEnd={onEndFn}
            handleTranscript={handleTranscriptFn}
          />
        </MemoryRouter>
      );
    }

    expect(GeminiLiveClient).toHaveBeenCalledTimes(1);

    const kickoffCalls = mockSendText.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('[SESSION START]')
    );
    expect(kickoffCalls).toHaveLength(1);
  });

  it('server close logs blocked event with reason live_closed:<code>:<reason>', async () => {
    render(
      <MemoryRouter>
        <CoachLiveView
          skill={typedSkill}
          language="en"
          stream={mockStream}
          outputAudioContext={mockAudioContext}
          micAudioContext={mockAudioContext}
          onEnd={vi.fn()}
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(apiModule.createSession).toHaveBeenCalled();
    });

    // Simulate server-side socket close
    capturedCallbacks.onClose?.(1006, 'Abnormal closure');

    await waitFor(() => {
      expect(apiModule.postSessionEvent).toHaveBeenCalledWith(
        'session-live-123',
        expect.objectContaining({
          type: 'blocked',
          source: 'coach',
          reason: 'live_closed:1006:Abnormal closure',
        })
      );
    });
  });

  it('shows "Connection keeps dropping" with Retry button on repeated connection drops', async () => {
    render(
      <MemoryRouter>
        <CoachLiveView
          skill={typedSkill}
          language="en"
          stream={mockStream}
          outputAudioContext={mockAudioContext}
          micAudioContext={mockAudioContext}
          onEnd={vi.fn()}
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(apiModule.createSession).toHaveBeenCalled();
    });

    capturedCallbacks.onStateChange?.('error');
    capturedCallbacks.onError?.(new Error('Connection keeps dropping'));

    await waitFor(() => {
      expect(screen.getByText('Connection keeps dropping')).toBeDefined();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
    });
  });
});


