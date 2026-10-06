import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OutputAudioQueue,
  base64ToPCM16,
  arrayBufferToBase64,
  setupMicCapture,
  createSilenceBase64,
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

  it('schedules chunks with 150ms jitter buffer and back to back on the timeline', () => {
    const queue = new OutputAudioQueue(mockContext as unknown as AudioContext);

    // 24000 samples at 24000 Hz = 1.0 second duration
    const chunk1 = new Int16Array(24000);
    const chunk2 = new Int16Array(12000); // 0.5 second duration

    queue.enqueue(chunk1);
    expect(createdSources.length).toBe(1);
    // First chunk of turn starts at currentTime + 0.15s = 10.0 + 0.15 = 10.15
    expect(createdSources[0].start).toHaveBeenCalledWith(10.15);
    expect(queue.getNextStartTime()).toBe(11.15);

    // Advance mock time to 10.2 (while chunk 1 is still scheduled to play)
    mockContext.currentTime = 10.2;
    queue.enqueue(chunk2);
    expect(createdSources.length).toBe(2);
    // Second chunk starts immediately when first chunk finishes at 11.15
    expect(createdSources[1].start).toHaveBeenCalledWith(11.15);
    expect(queue.getNextStartTime()).toBe(11.65);
    expect(queue.getUnderrunCount()).toBe(0);
  });

  it('increments underrun count and restarts at currentTime + 0.05s on underrun', () => {
    const queue = new OutputAudioQueue(mockContext as unknown as AudioContext);

    const chunk1 = new Int16Array(24000); // 1.0 second
    queue.enqueue(chunk1);
    expect(createdSources[0].start).toHaveBeenCalledWith(10.15);
    expect(queue.getNextStartTime()).toBe(11.15);

    // Advance currentTime past nextStartTime (11.15) to simulate an underrun gap
    mockContext.currentTime = 11.5;
    const chunk2 = new Int16Array(12000); // 0.5 second
    queue.enqueue(chunk2);

    expect(queue.getUnderrunCount()).toBe(1);
    // Restarts scheduling at currentTime + 0.05s = 11.5 + 0.05 = 11.55
    expect(createdSources[1].start).toHaveBeenCalledWith(11.55);
    expect(queue.getNextStartTime()).toBe(12.05);
  });

  it('correctly reports isPlayingWithTail with a 300ms tail window', () => {
    const queue = new OutputAudioQueue(mockContext as unknown as AudioContext);

    const chunk = new Int16Array(24000); // 1.0s -> ends at 11.15
    queue.enqueue(chunk);

    // During playback
    mockContext.currentTime = 10.5;
    expect(queue.isPlaying()).toBe(true);
    expect(queue.isPlayingWithTail(0.3)).toBe(true);

    // Right after scheduled audio ends (11.2s: past 11.15, but within 11.15 + 0.3 = 11.45)
    mockContext.currentTime = 11.2;
    expect(queue.isPlaying()).toBe(false);
    expect(queue.isPlayingWithTail(0.3)).toBe(true);

    // Past 300ms tail (11.5s)
    mockContext.currentTime = 11.5;
    expect(queue.isPlaying()).toBe(false);
    expect(queue.isPlayingWithTail(0.3)).toBe(false);
  });

  it('flush() stops active/pending playback and resets the timeline', () => {
    const queue = new OutputAudioQueue(mockContext as unknown as AudioContext);

    const chunk1 = new Int16Array(24000);
    const chunk2 = new Int16Array(24000);

    queue.enqueue(chunk1);
    queue.enqueue(chunk2);

    expect(queue.getActiveSourceCount()).toBe(2);
    expect(queue.getNextStartTime()).toBe(12.15);

    // Interrupt / flush
    queue.flush();

    expect(createdSources[0].stop).toHaveBeenCalled();
    expect(createdSources[0].disconnect).toHaveBeenCalled();
    expect(createdSources[1].stop).toHaveBeenCalled();
    expect(createdSources[1].disconnect).toHaveBeenCalled();

    expect(queue.getActiveSourceCount()).toBe(0);
    expect(queue.getNextStartTime()).toBe(0);
    expect(queue.isPlayingWithTail(0.3)).toBe(false);
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

  it('createSilenceBase64 produces base64 zeros of exact length', () => {
    const b64Silence = createSilenceBase64(64);
    expect(b64Silence.length).toBe(64);
    expect(b64Silence).toBe('A'.repeat(64));

    const pcm = base64ToPCM16(b64Silence);
    for (let i = 0; i < pcm.length; i++) {
      expect(pcm[i]).toBe(0);
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
