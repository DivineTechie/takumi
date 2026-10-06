import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { GeminiLiveClient } from './client';
import type { Skill } from '../../../../../shared/schema/ts/skills';
import * as apiModule from '../api';
import seedSkill from '../../../../../shared/seed/skill_terminal_wiring_v1.json';

const typedSeedSkill = seedSkill as unknown as Skill;

class MockWebSocket {
  public static instances: MockWebSocket[] = [];
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;

  public readonly CONNECTING = 0;
  public readonly OPEN = 1;
  public readonly CLOSING = 2;
  public readonly CLOSED = 3;

  public url: string;
  public readyState: number = MockWebSocket.CONNECTING;
  public sentMessages: string[] = [];
  public onopen: (() => void) | null = null;
  public onmessage: ((e: { data: string }) => void) | null = null;
  public onerror: ((e: unknown) => void) | null = null;
  public onclose: ((e: { code: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 10);
  }

  public send(msg: string) {
    this.sentMessages.push(msg);
  }

  public close(code = 1000) {
    this.readyState = 3; // CLOSED
    this.onclose?.({ code });
  }

  public simulateServerMessage(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe('GeminiLiveClient', () => {
  let originalWebSocket: typeof WebSocket;
  let liveTokenSpy: MockInstance;

  beforeEach(() => {
    MockWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;

    liveTokenSpy = vi.spyOn(apiModule, 'liveToken').mockImplementation(async () => ({
      token: `token-${Math.random()}`,
      model: 'models/gemini-3.8-live',
      max_minutes: 10,
    }));
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  it('fetches fresh token and sends setup message on connect', async () => {
    const onStateChange = vi.fn();
    const client = new GeminiLiveClient({
      skill: typedSeedSkill,
      language: 'en',
      getCurrentStep: () => 1,
      callbacks: {
        onStateChange,
        onTranscript: vi.fn(),
        onToolCall: vi.fn(),
        onError: vi.fn(),
      },
    });

    await client.connect();

    expect(liveTokenSpy).toHaveBeenCalledWith('coach');
    expect(onStateChange).toHaveBeenCalledWith('connecting');

    // Wait for mock WebSocket onopen
    await new Promise((r) => setTimeout(r, 20));

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    expect(ws.sentMessages.length).toBe(1);

    const setupMsg = JSON.parse(ws.sentMessages[0]);
    expect(setupMsg.setup.model).toBe('models/gemini-3.8-live');
    expect(setupMsg.setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(setupMsg.setup.contextWindowCompression.slidingWindow).toBeDefined();
    expect(setupMsg.setup.tools[0].functionDeclarations.length).toBe(2);

    // Simulate setupComplete
    ws.simulateServerMessage({ setupComplete: {} });
    expect(client.isReady()).toBe(true);
    expect(onStateChange).toHaveBeenCalledWith('connected');
  });

  it('sendCameraEvent formats text with [CAMERA EVENT] prefix', async () => {
    const client = new GeminiLiveClient({
      skill: typedSeedSkill,
      language: 'en',
      getCurrentStep: () => 1,
      callbacks: {
        onStateChange: vi.fn(),
        onTranscript: vi.fn(),
        onToolCall: vi.fn(),
        onError: vi.fn(),
      },
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 20));

    const ws = MockWebSocket.instances[0];
    ws.simulateServerMessage({ setupComplete: {} });

    client.sendCameraEvent('blue wire inserted into terminal 1');

    const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
    expect(lastMsg.realtimeInput.text).toBe(
      '[CAMERA EVENT] blue wire inserted into terminal 1'
    );
  });

  it('reconnect state machine fetches fresh token and resumes at current step', async () => {
    const onStateChange = vi.fn();
    const client = new GeminiLiveClient({
      skill: typedSeedSkill,
      language: 'hi',
      getCurrentStep: () => 2,
      callbacks: {
        onStateChange,
        onTranscript: vi.fn(),
        onToolCall: vi.fn(),
        onError: vi.fn(),
      },
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 20));

    const ws1 = MockWebSocket.instances[0];
    ws1.simulateServerMessage({ setupComplete: {} });

    // Simulate unexpected socket disconnect
    ws1.close(1006);

    expect(onStateChange).toHaveBeenCalledWith('reconnecting');

    // Wait for backoff reconnect (500ms) + ws onopen (20ms)
    await new Promise((r) => setTimeout(r, 600));

    expect(liveTokenSpy).toHaveBeenCalledTimes(2); // fresh token fetched!
    expect(MockWebSocket.instances.length).toBe(2);

    const ws2 = MockWebSocket.instances[1];
    ws2.simulateServerMessage({ setupComplete: {} });

    // Resumed session sends resume instruction at step 2
    expect(ws2.sentMessages.length).toBeGreaterThan(1);
    const resumeTextMsg = JSON.parse(ws2.sentMessages[ws2.sentMessages.length - 1]);
    expect(resumeTextMsg.realtimeInput.text).toContain('Resume at step 2:');
    expect(resumeTextMsg.realtimeInput.text).toContain('भूरे तार को टर्मिनल 2 में डालें');
  });

  it('replies to tool calls in Pass 1 with "not available yet"', async () => {
    const onToolCall = vi.fn().mockResolvedValue({ status: 'not available yet' });
    const client = new GeminiLiveClient({
      skill: typedSeedSkill,
      language: 'en',
      getCurrentStep: () => 1,
      callbacks: {
        onStateChange: vi.fn(),
        onTranscript: vi.fn(),
        onToolCall,
        onError: vi.fn(),
      },
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 20));

    const ws = MockWebSocket.instances[0];
    ws.simulateServerMessage({ setupComplete: {} });

    // Simulate model tool call
    ws.simulateServerMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'call-123',
            name: 'verify_step',
            args: { step: 1 },
          },
        ],
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(onToolCall).toHaveBeenCalledWith({
      id: 'call-123',
      name: 'verify_step',
      args: { step: 1 },
    });

    const responseMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
    expect(responseMsg.toolResponse.functionResponses[0].response.result.status).toBe(
      'not available yet'
    );
  });
});
