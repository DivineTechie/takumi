import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OutputAudioQueue,
  base64ToPCM16,
  arrayBufferToBase64,
  setupMicCapture,
} from './audio';

interface MockAudioBufferSource {
  buffer: AudioBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

interface MockAudioContext {
  currentTime: number;
  destination: Record<string, unknown>;
  createBuffer: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
}

describe('OutputAudioQueue', () => {
  let mockContext: MockAudioContext;
  let createdSources: MockAudioBufferSource[];

  beforeEach(() => {
    createdSources = [];
    mockContext = {
      currentTime: 10.0,
      destination: {},
      createBuffer: vi.fn((_channels, length, sampleRate) => ({
        duration: length / sampleRate, // duration in seconds
        length,
        sampleRate,
        getChannelData: vi.fn(() => new Float32Array(length)),
      })),
      createBufferSource: vi.fn(() => {
        const src: MockAudioBufferSource = {
          buffer: null,
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          disconnect: vi.fn(),
          onended: null,
        };
        createdSources.push(src);
        return src;
      }),
    };
  });

  it('schedules chunks back to back on the timeline', () => {
    const queue = new OutputAudioQueue(mockContext as unknown as AudioContext);

    // 24000 samples at 24000 Hz = 1.0 second duration
    const chunk1 = new Int16Array(24000);
    const chunk2 = new Int16Array(12000); // 0.5 second duration

    queue.enqueue(chunk1);
    expect(createdSources.length).toBe(1);
    // First chunk starts at max(currentTime, nextStartTime) = max(10.0, 0) = 10.0
    expect(createdSources[0].start).toHaveBeenCalledWith(10.0);
    expect(queue.getNextStartTime()).toBe(11.0);

    // Advance mock time to 10.2 (while chunk 1 is still playing)
    mockContext.currentTime = 10.2;
    queue.enqueue(chunk2);
    expect(createdSources.length).toBe(2);
    // Second chunk starts immediately when first chunk finishes at 11.0
    expect(createdSources[1].start).toHaveBeenCalledWith(11.0);
    expect(queue.getNextStartTime()).toBe(11.5);
  });

  it('flush() stops active/pending playback and resets the timeline', () => {
    const queue = new OutputAudioQueue(mockContext as unknown as AudioContext);

    const chunk1 = new Int16Array(24000);
    const chunk2 = new Int16Array(24000);

    queue.enqueue(chunk1);
    queue.enqueue(chunk2);

    expect(queue.getActiveSourceCount()).toBe(2);
    expect(queue.getNextStartTime()).toBe(12.0);

    // Interrupt / flush
    queue.flush();

    expect(createdSources[0].stop).toHaveBeenCalled();
    expect(createdSources[0].disconnect).toHaveBeenCalled();
    expect(createdSources[1].stop).toHaveBeenCalled();
    expect(createdSources[1].disconnect).toHaveBeenCalled();

    expect(queue.getActiveSourceCount()).toBe(0);
    expect(queue.getNextStartTime()).toBe(0);
  });
});

describe('PCM Base64 conversion helpers', () => {
  it('converts Int16Array to base64 and back accurately', () => {
    const original = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const b64 = arrayBufferToBase64(original.buffer);
    const restored = base64ToPCM16(b64);

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBe(original[i]);
    }
  });
});

describe('setupMicCapture fallback path', () => {
  it('falls back to default-rate AudioContext when initial 16kHz context throws in createMediaStreamSource', async () => {
    const mockStream = {
      getAudioTracks: () => [{}],
    } as unknown as MediaStream;

    let fallbackContextCreated = false;

    // Initial 16 kHz context that throws (simulating Firefox rate mismatch)
    const initialContext = {
      sampleRate: 16000,
      createMediaStreamSource: vi.fn(() => {
        throw new Error('Sample rate mismatch between stream and context');
      }),
      close: vi.fn(async () => {}),
    } as unknown as AudioContext;

    // Global AudioContext mock for fallback
    const originalAudioContext = globalThis.AudioContext;
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = vi.fn().mockImplementation(() => {
      fallbackContextCreated = true;
      return {
        sampleRate: 48000,
        resume: vi.fn(async () => {}),
        createMediaStreamSource: vi.fn(() => ({
          connect: vi.fn(),
          disconnect: vi.fn(),
        })),
        audioWorklet: {
          addModule: vi.fn(async () => {}),
        },
      };
    });

    // Mock AudioWorkletNode
    (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = vi.fn().mockImplementation(() => ({
      port: {
        onmessage: null,
        close: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));

    try {
      const handle = await setupMicCapture(mockStream, initialContext, vi.fn());

      expect(initialContext.createMediaStreamSource).toHaveBeenCalledWith(mockStream);
      expect(initialContext.close).toHaveBeenCalled();
      expect(fallbackContextCreated).toBe(true);
      expect(handle.activeContext.sampleRate).toBe(48000);

      handle.stop();
    } finally {
      globalThis.AudioContext = originalAudioContext;
    }
  });
});
