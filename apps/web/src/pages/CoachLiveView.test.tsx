import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CoachLiveView } from './CoachLiveView';
import * as apiModule from '../lib/api';
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
  createSession: vi.fn(),
  postSessionEvent: vi.fn(),
  endSession: vi.fn(),
  liveToken: vi.fn(),
}));

// Mock Live Client
const mockSendText = vi.fn();
const mockManualRetry = vi.fn();
const mockStopGating = vi.fn();
const mockClose = vi.fn();
const mockConnect = vi.fn();
let capturedCallbacks: Partial<LiveClientCallbacks> = {};

vi.mock('../lib/live/client', () => {
  return {
    GeminiLiveClient: vi.fn().mockImplementation((config: { callbacks: LiveClientCallbacks }) => {
      capturedCallbacks = config.callbacks;
      return {
        connect: mockConnect,
        sendAudio: vi.fn(),
        sendVideoFrame: vi.fn(),
        sendText: mockSendText,
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
    expect(apiModule.postSessionEvent).toHaveBeenCalledWith(
      'session-live-123',
      expect.objectContaining({
        step: 1,
        type: 'verify',
        source: 'verify',
      })
    );

    // Check step_done event was posted
    expect(apiModule.postSessionEvent).toHaveBeenCalledWith(
      'session-live-123',
      expect.objectContaining({
        step: 1,
        type: 'step_done',
        source: 'verify',
      })
    );

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

    expect(apiModule.postSessionEvent).toHaveBeenCalledWith(
      'session-live-123',
      expect.objectContaining({
        step: 1,
        type: 'point',
        source: 'system',
        reason: 'terminal 1',
      })
    );
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
    expect(apiModule.endSession).toHaveBeenCalledWith('session-live-123', 'completed');

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
});
