/**
 * Base64 to Int16Array and ArrayBuffer conversions.
 */
export function base64ToPCM16(base64: string): Int16Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Creates and resumes both AudioContexts synchronously before any await.
 * Essential for Safari / iOS where user gesture context is lost across microtasks.
 */
export function createAndResumeAudioContexts(): {
  outputContext: AudioContext;
  micContext: AudioContext;
} {
  // Device default sample rate for output
  const outputContext = new AudioContext();

  // Try 16 kHz for mic input to let browser do the resampling if possible
  let micContext: AudioContext;
  try {
    micContext = new AudioContext({ sampleRate: 16000 });
  } catch {
    micContext = new AudioContext();
  }

  // Resume immediately inside user gesture
  outputContext.resume().catch(() => {});
  micContext.resume().catch(() => {});

  return { outputContext, micContext };
}

/**
 * Output audio queue for 24 kHz PCM received from Gemini Live model turns.
 * AudioBuffers are created at 24000 Hz, while output AudioContext is at the device's native rate.
 * Scheduled back-to-back with immediate flush() capability on model interruption.
 */
export class OutputAudioQueue {
  private audioContext: AudioContext;
  private nextStartTime: number = 0;
  private activeSources: Set<AudioBufferSourceNode> = new Set();

  constructor(audioContext: AudioContext) {
    this.audioContext = audioContext;
  }

  /**
   * Enqueues a chunk of 24 kHz PCM16 data and schedules playback.
   */
  public enqueue(pcm16: Int16Array | ArrayBuffer): void {
    const int16 = pcm16 instanceof Int16Array ? pcm16 : new Int16Array(pcm16);
    if (int16.length === 0) return;

    // Convert Int16 [-32768, 32767] to Float32 [-1.0, 1.0]
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      const s = int16[i];
      float32[i] = s < 0 ? s / 32768.0 : s / 32767.0;
    }

    // AudioBuffer sample rate is 24000 Hz; browser automatically resamples to context rate
    const audioBuffer = this.audioContext.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);

    const currentTime = this.audioContext.currentTime;
    const startTime = Math.max(currentTime, this.nextStartTime);
    source.start(startTime);
    this.nextStartTime = startTime + audioBuffer.duration;

    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
    };
  }

  /**
   * Enqueues base64-encoded 24 kHz PCM audio chunk.
   */
  public enqueueBase64(base64: string): void {
    const pcm16 = base64ToPCM16(base64);
    this.enqueue(pcm16);
  }

  /**
   * Immediately stops playback of all pending/active chunks and resets the timeline.
   */
  public flush(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Source might have already finished
      }
    }
    this.activeSources.clear();
    this.nextStartTime = 0;
  }

  public getNextStartTime(): number {
    return this.nextStartTime;
  }

  public getActiveSourceCount(): number {
    return this.activeSources.size;
  }
}

export interface MicCaptureHandle {
  activeContext: AudioContext;
  stop: () => void;
}

/**
 * Connects microphone MediaStream to AudioWorklet pcm-processor.
 * Handles Firefox / browser rate mismatch fallback gracefully.
 */
export async function setupMicCapture(
  stream: MediaStream,
  initialMicContext: AudioContext,
  onChunk: (base64Chunk: string) => void
): Promise<MicCaptureHandle> {
  let activeContext = initialMicContext;
  let sourceNode: MediaStreamAudioSourceNode | null = null;

  // Attempt to create media stream source on the initial mic context
  try {
    sourceNode = activeContext.createMediaStreamSource(stream);
  } catch (err) {
    console.warn('Initial micContext.createMediaStreamSource failed, falling back to default rate context:', err);
    try {
      activeContext.close().catch(() => {});
    } catch {
      // ignore
    }
    activeContext = new AudioContext();
    activeContext.resume().catch(() => {});
    sourceNode = activeContext.createMediaStreamSource(stream);
  }

  // Load the downsampling AudioWorklet processor
  await activeContext.audioWorklet.addModule('/pcm-processor.js');

  const workletNode = new AudioWorkletNode(activeContext, 'pcm-processor');

  workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    if (event.data && event.data.byteLength > 0) {
      const b64 = arrayBufferToBase64(event.data);
      onChunk(b64);
    }
  };

  sourceNode.connect(workletNode);

  return {
    activeContext,
    stop: () => {
      try {
        sourceNode?.disconnect();
        workletNode.disconnect();
        workletNode.port.close();
      } catch {
        // ignore cleanup errors
      }
    },
  };
}
