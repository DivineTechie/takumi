import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { GeminiLiveClient, type LiveClientConfig } from './client';
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
  public binaryType = 'blob';
  public readyState: number = MockWebSocket.CONNECTING;
  public sentMessages: string[] = [];
  public onopen: (() => void) | null = null;
  public onmessage: ((e: { data: unknown }) => void) | null = null;
  public onerror: ((e: unknown) => void) | null = null;
  public onclose: ((e: { code: number; reason?: string }) => void) | null = null;

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

  public close(code = 1000, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  public simulateServerMessage(data: unknown) {
    if (
      typeof data === 'string' ||
      data instanceof ArrayBuffer ||
      ArrayBuffer.isView(data) ||
      (typeof Blob !== 'undefined' && data instanceof Blob) ||
      (data && typeof (data as Blob).arrayBuffer === 'function') ||
      (data && typeof (data as ArrayBuffer).byteLength === 'number')
    ) {
      this.onmessage?.({ data });
    } else {
      this.onmessage?.({ data: JSON.stringify(data) });
    }
  }
}

describe('GeminiLiveClient', () => {
  let originalWebSocket: typeof WebSocket;
  let liveTokenSpy: MockInstance;
  let clients: GeminiLiveClient[] = [];

  function createClient(configOverrides: Partial<LiveClientConfig> = {}): GeminiLiveClient {
    const callbacks = {
      onStateChange: vi.fn(),
      onTranscript: vi.fn(),
      onToolCall: vi.fn(),
      onError: vi.fn(),
      ...(configOverrides.callbacks || {}),
    };

    const client = new GeminiLiveClient({
      skill: typedSeedSkill,
      language: 'en',
      getCurrentStep: () => 1,
      callbacks,
      ...configOverrides,
    });
    clients.push(client);
    return client;
  }

  beforeEach(() => {
    clients = [];
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
    clients.forEach((c) => c.close());
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  it('fetches fresh token, sets binaryType arraybuffer, and sends setup message on connect', async () => {
    const onStateChange = vi.fn();
    const client = createClient({
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
    expect(ws.binaryType).toBe('arraybuffer');
    expect(ws.sentMessages.length).toBe(1);

    const setupMsg = JSON.parse(ws.sentMessages[0]);
    expect(setupMsg.setup.model).toBe('models/gemini-3.8-live');
    expect(setupMsg.setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(setupMsg.setup.contextWindowCompression.slidingWindow).toBeDefined();
    expect(setupMsg.setup.tools[0].functionDeclarations.length).toBe(2);

    // Simulate setupComplete
    ws.simulateServerMessage({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 30));

    expect(client.isReady()).toBe(true);
    expect(onStateChange).toHaveBeenCalledWith('connected');
  });

  it('sends kickoff greeting after first setupComplete, but not on reconnects', async () => {
    const client = createClient();

    await client.connect();
    await new Promise((r) => setTimeout(r, 20));

    const ws = MockWebSocket.instances[0];
    ws.simulateServerMessage({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 30));

    expect(ws.sentMessages.length).toBe(2);
    const kickoffMsg = JSON.parse(ws.sentMessages[1]);
    expect(kickoffMsg.realtimeInput.text).toBe(
      '[SESSION START] The trainee is ready at the bench. Greet them briefly and announce step 1.'
    );
  });

  it('decodes setupComplete arriving as ArrayBuffer and as Blob', async () => {
    const encoder = new TextEncoder();

    // 1. ArrayBuffer
    const clientBuffer = createClient();
    await clientBuffer.connect();
    await new Promise((r) => setTimeout(r, 20));

    const wsBuffer = MockWebSocket.instances[0];
    const rawBuffer = encoder.encode(JSON.stringify({ setupComplete: {} })).buffer;
    wsBuffer.simulateServerMessage(rawBuffer);
    await new Promise((r) => setTimeout(r, 50));

    expect(clientBuffer.isReady()).toBe(true);
    expect(clientBuffer.getStats().setupCompleteReceived).toBe(true);
    expect(clientBuffer.getStats().setupCompleteMs).toBeGreaterThanOrEqual(0);

    // 2. Blob
    const clientBlob = createClient();
    await clientBlob.connect();
    await new Promise((r) => setTimeout(r, 20));

    const wsBlob = MockWebSocket.instances[1];
    const blob = new Blob([JSON.stringify({ setupComplete: {} })], { type: 'application/json' });
    wsBlob.simulateServerMessage(blob);
    await new Promise((r) => setTimeout(r, 50));

    expect(clientBlob.isReady()).toBe(true);
    expect(clientBlob.getStats().setupCompleteReceived).toBe(true);
  });

  it('decodes serverContent audio arriving as ArrayBuffer and as Blob', async () => {
    const encoder = new TextEncoder();
    const onAudioChunkBuffer = vi.fn();
    const onAudioChunkBlob = vi.fn();

    const base64Audio = btoa(String.fromCharCode(...new Uint8Array(16)));
    const audioPayload = {
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: base64Audio } }],
        },
      },
    };

    // 1. ArrayBuffer
    const clientBuffer = createClient({
      callbacks: {
        onStateChange: vi.fn(),
        onTranscript: vi.fn(),
        onToolCall: vi.fn(),
        onError: vi.fn(),
        onAudioChunk: onAudioChunkBuffer,
      },
    });
    await clientBuffer.connect();
    await new Promise((r) => setTimeout(r, 20));
    const ws1 = MockWebSocket.instances[0];
    ws1.simulateServerMessage({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 20));

    const arrayBuf = encoder.encode(JSON.stringify(audioPayload)).buffer;
    ws1.simulateServerMessage(arrayBuf);
    await new Promise((r) => setTimeout(r, 50));

    expect(onAudioChunkBuffer).toHaveBeenCalledTimes(1);
    expect(clientBuffer.getStats().audioChunksReceived).toBe(1);

    // 2. Blob
    const clientBlob = createClient({
      callbacks: {
        onStateChange: vi.fn(),
        onTranscript: vi.fn(),
        onToolCall: vi.fn(),
        onError: vi.fn(),
        onAudioChunk: onAudioChunkBlob,
      },
    });
    await clientBlob.connect();
    await new Promise((r) => setTimeout(r, 20));
    const ws2 = MockWebSocket.instances[1];
    ws2.simulateServerMessage({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 20));

    const blob = new Blob([JSON.stringify(audioPayload)], { type: 'application/json' });
    ws2.simulateServerMessage(blob);
    await new Promise((r) => setTimeout(r, 50));

    expect(onAudioChunkBlob).toHaveBeenCalledTimes(1);
    expect(clientBlob.getStats().audioChunksReceived).toBe(1);
  });

  it('decodes toolCall arriving as ArrayBuffer and as Blob', async () => {
    const encoder = new TextEncoder();
    const onToolCall = vi.fn().mockResolvedValue({ status: 'ok' });

    const toolPayloadBuffer = {
      toolCall: {
        functionCalls: [
          {
            id: 'call-buf-1',
            name: 'verify_step',
            args: { step: 1 },
          },
        ],
      },
    };

    // 1. ArrayBuffer
    const clientBuffer = createClient({
      callbacks: {
        onStateChange: vi.fn(),
        onTranscript: vi.fn(),
        onToolCall,
        onError: vi.fn(),
      },
    });
    await clientBuffer.connect();
    await new Promise((r) => setTimeout(r, 20));
    const ws1 = MockWebSocket.instances[0];
    ws1.simulateServerMessage({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 20));

    ws1.simulateServerMessage(encoder.encode(JSON.stringify(toolPayloadBuffer)).buffer);
    await new Promise((r) => setTimeout(r, 50));

    expect(onToolCall).toHaveBeenCalledWith({
      id: 'call-buf-1',
      name: 'verify_step',
      args: { step: 1 },
    });

    // 2. Blob
    const toolPayloadBlob = {
      toolCall: {
        functionCalls: [
          {
            id: 'call-blob-2',
            name: 'point_at',
            args: { target: 'terminal 1' },
          },
        ],
      },
    };

    const clientBlob = createClient({
      callbacks: {
        onStateChange: vi.fn(),
        onTranscript: vi.fn(),
        onToolCall,
        onError: vi.fn(),
      },
    });
    await clientBlob.connect();
    await new Promise((r) => setTimeout(r, 20));
    const ws2 = MockWebSocket.instances[1];
    ws2.simulateServerMessage({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 20));

    ws2.simulateServerMessage(
      new Blob([JSON.stringify(toolPayloadBlob)], { type: 'application/json' })
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(onToolCall).toHaveBeenCalledWith({
      id: 'call-blob-2',
      name: 'point_at',
      args: { target: 'terminal 1' },
    });
  });

  it('triggers setup timeout (error state) if setupComplete is not received within 8 seconds', async () => {
    vi.useFakeTimers();
    try {
      const onStateChange = vi.fn();
      const onError = vi.fn();

      const client = createClient({
        callbacks: {
          onStateChange,
          onTranscript: vi.fn(),
          onToolCall: vi.fn(),
          onError,
        },
      });

      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(30);

      expect(onStateChange).toHaveBeenCalledWith('connecting');

      // Advance past 8 seconds without setupComplete
      await vi.advanceTimersByTimeAsync(8100);
      await connectPromise;

      expect(onStateChange).toHaveBeenCalledWith('error');
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('setup complete timed out') })
      );
      expect(client.getStats().lastCloseCode).toBe(4008);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accurately tracks stats for chunks sent, received, and close info', async () => {
    const client = createClient();

    await client.connect();
    await new Promise((r) => setTimeout(r, 20));
    const ws = MockWebSocket.instances[0];
    ws.simulateServerMessage({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 20));

    // Send audio chunk
    client.sendAudio('AAAA');
    expect(client.getStats().micChunksSent).toBe(1);

    // Send video frame
    client.sendVideoFrame('fakejpeg');
    expect(client.getStats().videoFramesSent).toBe(1);

    // Close socket
    ws.close(1000, 'Normal closure');
    expect(client.getStats().lastCloseCode).toBe(1000);
    expect(client.getStats().lastCloseReason).toBe('Normal closure');
  });

  it('sendCameraEvent formats text with [CAMERA EVENT] prefix', async () => {
    const client = createClient();

    await client.connect();
    await new Promise((r) => setTimeout(r, 20));

    const ws = MockWebSocket.instances[0];
    ws.simulateServerMessage({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 20));

    client.sendCameraEvent('blue wire inserted into terminal 1');

    const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
    expect(lastMsg.realtimeInput.text).toBe(
      '[CAMERA EVENT] blue wire inserted into terminal 1'
    );
  });

  it('reconnect state machine fetches fresh token and resumes at current step', async () => {
    const onStateChange = vi.fn();
    const client = createClient({
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
    await new Promise((r) => setTimeout(r, 20));

    // Simulate unexpected socket disconnect
    ws1.close(1006);

    expect(onStateChange).toHaveBeenCalledWith('reconnecting');

    // Wait for backoff reconnect (500ms) + ws onopen (20ms)
    await new Promise((r) => setTimeout(r, 600));

    expect(liveTokenSpy).toHaveBeenCalledTimes(2); // fresh token fetched!
    expect(MockWebSocket.instances.length).toBe(2);

    const ws2 = MockWebSocket.instances[1];
    ws2.simulateServerMessage({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 20));

    // Resumed session sends resume instruction at step 2
    expect(ws2.sentMessages.length).toBeGreaterThan(1);
    const resumeTextMsg = JSON.parse(ws2.sentMessages[ws2.sentMessages.length - 1]);
    expect(resumeTextMsg.realtimeInput.text).toContain('Resume at step 2:');
    expect(resumeTextMsg.realtimeInput.text).toContain('भूरे तार को टर्मिनल 2 में डालें');
  });

  it('replies to tool calls in Pass 1 with "not available yet"', async () => {
    const onToolCall = vi.fn().mockResolvedValue({ status: 'not available yet' });
    const client = createClient({
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
    await new Promise((r) => setTimeout(r, 20));

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
