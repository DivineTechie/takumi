import { liveToken } from '../api';
import type { Skill } from '../../../../../shared/schema/ts/skills';
import type { LanguageCode } from '../../i18n';
import { buildLiveSystemInstruction, cleanTranscript } from './prompt';
import type {
  LiveClientCallbacks,
  LiveClientStats,
  LiveConnectionState,
} from './types';
import { base64ToPCM16, createSilencePcmBase64, OutputAudioQueue } from './audio';

const WS_BASE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

export interface LiveClientConfig {
  skill: Skill;
  language: LanguageCode;
  getCurrentStep: () => number;
  callbacks: LiveClientCallbacks;
  maxReconnectAttempts?: number;
  speakerMode?: boolean;
  audioQueue?: OutputAudioQueue;
}

export async function decodeWebSocketData(
  data: unknown
): Promise<string> {
  if (typeof data === 'string') {
    return data;
  }
  if (!data) {
    return '';
  }
  // Check for Blob / Blob-like
  const isBlobLike =
    (typeof Blob !== 'undefined' && data instanceof Blob) ||
    (data !== null &&
      typeof data === 'object' &&
      typeof (data as { size?: number }).size === 'number' &&
      typeof (data as { type?: string }).type === 'string');

  if (isBlobLike) {
    if (typeof (data as Blob).text === 'function') {
      return await (data as Blob).text();
    }
    if (typeof (data as Blob).arrayBuffer === 'function') {
      const arrayBuffer = await (data as Blob).arrayBuffer();
      return new TextDecoder('utf-8').decode(arrayBuffer);
    }
    if (typeof FileReader !== 'undefined') {
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(data as Blob, 'utf-8');
      });
    }
  }

  // Check for ArrayBuffer, TypedArray, DataView, Buffer, or ArrayBufferView
  if (
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data) ||
    Object.prototype.toString.call(data) === '[object ArrayBuffer]' ||
    typeof (data as ArrayBuffer).byteLength === 'number'
  ) {
    return new TextDecoder('utf-8').decode(data as BufferSource);
  }
  throw new Error(`Unsupported WebSocket data type: ${typeof data} [${Object.prototype.toString.call(data)}]`);
}

export function computeMedian(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

export class GeminiLiveClient {
  private config: LiveClientConfig;
  private ws: WebSocket | null = null;
  private state: LiveConnectionState = 'idle';
  private explicitlyClosed = false;
  private setupDone = false;
  private hasCompletedFirstSetup = false;
  private reconnectAttempts = 0;
  private reconnectTimestamps: number[] = [];
  private readonly maxReconnectAttempts: number;
  private reconnectTimeoutId: number | null = null;
  private setupTimeoutId: number | null = null;
  private connectStartTime = 0;
  private lastVideoSentTime = 0;
  private speakerMode = true;
  private audioQueue?: OutputAudioQueue;
  private gatingOverridden = false;
  private turnEnded = true;
  private simulatedAudioEndMs = 0;
  private simulatedGatingUntil = 0;
  private verifyLatencies: number[] = [];
  private pointLatencies: number[] = [];
  private toolLatencies: number[] = [];
  private stats: LiveClientStats = {
    setupCompleteReceived: false,
    setupCompleteMs: null,
    kickoffSentCount: 0,
    micChunksSent: 0,
    videoFramesSent: 0,
    audioChunksReceived: 0,
    transcriptsReceived: 0,
    lastCloseCode: null,
    lastCloseReason: '',
    interruptedCount: 0,
    playbackUnderruns: 0,
    isGating: false,
    tokenFetchMs: null,
    timeToFirstAudioMs: null,
    lastVerifyLatencyMs: null,
    medianVerifyLatencyMs: null,
    lastPointLatencyMs: null,
    medianPointLatencyMs: null,
    lastToolLatencyMs: null,
    medianToolLatencyMs: null,
  };

  constructor(config: LiveClientConfig) {
    this.config = config;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 3;
    this.speakerMode = config.speakerMode ?? true;
    this.audioQueue = config.audioQueue;
  }

  public getState(): LiveConnectionState {
    return this.state;
  }

  public isReady(): boolean {
    return this.state === 'connected' && this.setupDone;
  }

  public setSpeakerMode(enabled: boolean): void {
    this.speakerMode = enabled;
    this.notifyStats();
  }

  public getSpeakerMode(): boolean {
    return this.speakerMode;
  }

  public stopGating(): void {
    this.gatingOverridden = true;
    if (this.audioQueue && typeof this.audioQueue.flush === 'function') {
      this.audioQueue.flush();
    }
    this.simulatedAudioEndMs = 0;
    this.simulatedGatingUntil = 0;
    this.notifyStats();
  }

  public isGating(): boolean {
    if (!this.speakerMode) {
      return false;
    }
    if (this.gatingOverridden) {
      return false;
    }
    if (this.audioQueue) {
      return this.audioQueue.isPlayingWithTail(0.3);
    }
    return Date.now() < this.simulatedGatingUntil;
  }

  public recordVerifyLatency(ms: number): void {
    this.verifyLatencies.push(ms);
    this.stats.lastVerifyLatencyMs = ms;
    this.stats.medianVerifyLatencyMs = computeMedian(this.verifyLatencies);
    this.recordToolLatency(ms);
  }

  public recordPointLatency(ms: number): void {
    this.pointLatencies.push(ms);
    this.stats.lastPointLatencyMs = ms;
    this.stats.medianPointLatencyMs = computeMedian(this.pointLatencies);
    this.recordToolLatency(ms);
  }

  public recordToolLatency(ms: number): void {
    this.toolLatencies.push(ms);
    this.stats.lastToolLatencyMs = ms;
    this.stats.medianToolLatencyMs = computeMedian(this.toolLatencies);
    this.notifyStats();
  }

  public getStats(): LiveClientStats {
    return {
      ...this.stats,
      playbackUnderruns: this.audioQueue ? this.audioQueue.getUnderrunCount() : 0,
      isGating: this.isGating(),
    };
  }

  private notifyStats(): void {
    this.config.callbacks.onStatsUpdate?.(this.getStats());
  }

  private clearSetupTimeout(): void {
    if (this.setupTimeoutId !== null) {
      clearTimeout(this.setupTimeoutId);
      this.setupTimeoutId = null;
    }
  }

  private setState(newState: LiveConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.config.callbacks.onStateChange(newState);
    }
  }

  /**
   * Connects to the Gemini Live WebSocket endpoint.
   * Fetches a fresh single-use token on every connection/reconnection attempt.
   */
  public async connect(isReconnect = false): Promise<void> {
    if (this.explicitlyClosed) return;

    this.setState(isReconnect ? 'reconnecting' : 'connecting');
    this.setupDone = false;
    this.connectStartTime = Date.now();

    // 8-second setup timeout: if setupComplete hasn't arrived within 8s, transition to error
    this.clearSetupTimeout();
    this.setupTimeoutId = window.setTimeout(() => {
      if (!this.setupDone && !this.explicitlyClosed) {
        console.error('Gemini Live connection timed out: setupComplete not received within 8s');
        this.stats.lastCloseCode = 4008;
        this.stats.lastCloseReason = 'Setup complete timed out (8s)';
        const socketToClose = this.ws;
        this.ws = null;
        if (socketToClose) {
          try {
            socketToClose.close();
          } catch {
            // ignore
          }
        }
        this.setState('error');
        this.notifyStats();
        this.config.callbacks.onError(new Error("Couldn't connect: setup complete timed out"));
      }
    }, 8000);

    try {
      // 1. Fetch fresh single-use token from backend takumi-api
      const tokenStart = Date.now();
      const tokenResp = await liveToken('coach');
      this.stats.tokenFetchMs = Date.now() - tokenStart;
      const token = tokenResp.token;

      if (this.explicitlyClosed) return;

      // 2. Open WebSocket
      const wsUrl = `${WS_BASE_URL}?access_token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.sendSetupMessage(isReconnect);
      };

      ws.onmessage = (event: MessageEvent) => {
        if (this.ws !== ws) return;
        void this.handleMessage(event.data);
      };

      ws.onerror = (err) => {
        console.error('Gemini Live WebSocket error:', err);
      };

      ws.onclose = (event) => {
        if (this.ws !== ws) return;
        this.clearSetupTimeout();
        this.ws = null;
        this.setupDone = false;
        this.stats.lastCloseCode = event.code;
        this.stats.lastCloseReason = event.reason || '';
        this.notifyStats();

        console.warn(
          `WebSocket closed by server (code: ${event.code}${event.reason ? `, reason: "${event.reason}"` : ''})`
        );

        if (!this.explicitlyClosed) {
          this.config.callbacks.onClose?.(event.code, event.reason || '');
          console.warn(`WebSocket closed unexpectedly (code: ${event.code}), scheduling reconnect...`);
          this.scheduleReconnect();
        } else {
          this.setState('closed');
        }
      };
    } catch (err) {
      console.error('Failed to establish Live session connection:', err);
      this.clearSetupTimeout();
      this.stats.lastCloseCode = 5000;
      this.stats.lastCloseReason = err instanceof Error ? err.message : String(err);
      this.notifyStats();
      if (!this.explicitlyClosed) {
        this.config.callbacks.onClose?.(5000, this.stats.lastCloseReason);
        this.scheduleReconnect();
      } else {
        this.setState('error');
      }
    }
  }

  private sendSetupMessage(isReconnect: boolean): void {
    const currentStep = this.config.getCurrentStep();
    const systemInstruction = buildLiveSystemInstruction(
      this.config.skill,
      this.config.language,
      {
        currentStep,
        resumed: isReconnect,
      }
    );

    const setupPayload = {
      setup: {
        model: 'models/gemini-3.8-live',
        generationConfig: {
          responseModalities: ['AUDIO'],
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
            silenceDurationMs: 800,
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: {
          slidingWindow: {},
        },
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'verify_step',
                description:
                  'Verify whether the current step is completed correctly and safely according to the success criteria.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    step: {
                      type: 'INTEGER',
                      description: 'The step number to verify',
                    },
                  },
                  required: ['step'],
                },
              },
              {
                name: 'point_at',
                description:
                  'Point at a specific target, component, or location in the visual workspace when the trainee needs visual assistance.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    target: {
                      type: 'STRING',
                      description: 'Short description of the visual target to point at',
                    },
                  },
                  required: ['target'],
                },
              },
            ],
          },
        ],
      },
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(setupPayload));
    }
  }

  public async handleMessage(data: unknown): Promise<void> {
    let rawText: string;
    try {
      rawText = await decodeWebSocketData(data);
    } catch (err) {
      console.error('Failed to decode WebSocket message:', err);
      return;
    }

    try {
      const msg = JSON.parse(rawText);

      // 1. Setup complete confirmation
      if (msg.setupComplete) {
        this.clearSetupTimeout();
        this.stats.setupCompleteReceived = true;
        this.stats.setupCompleteMs = Date.now() - this.connectStartTime;
        this.setupDone = true;
        this.setState('connected');
        this.notifyStats();

        if (!this.hasCompletedFirstSetup) {
          this.hasCompletedFirstSetup = true;
          this.stats.kickoffSentCount++;
          this.notifyStats();
          this.sendText(
            '[SESSION START] The trainee is ready at the bench. Greet them briefly and announce step 1.'
          );
        } else {
          // Reconnect continuity
          const currentStep = this.config.getCurrentStep();
          const stepObj =
            this.config.skill.steps.find((s) => s.n === currentStep) ||
            this.config.skill.steps[0];
          const rawInstruction =
            stepObj.translations?.[this.config.language]?.instruction ||
            stepObj.instruction;
          const instruction = rawInstruction.trim().replace(/\.+$/, '');
          this.sendText(
            `[RESUME] The connection dropped. Do NOT greet again. Continue from step ${currentStep}: ${instruction}.`
          );
        }
        return;
      }

      // 2. GoAway / server graceful close -> trigger reconnect
      if (msg.goAway) {
        console.warn('Server sent goAway, reconnecting...');
        this.stats.lastCloseReason = 'Server goAway';
        this.notifyStats();
        this.ws?.close();
        return;
      }

      // 3. Server content: Audio, transcripts, interruption
      if (msg.serverContent) {
        const sc = msg.serverContent;

        if (sc.interrupted) {
          this.stats.interruptedCount++;
          this.simulatedAudioEndMs = 0;
          this.simulatedGatingUntil = 0;
          this.turnEnded = true;
          this.gatingOverridden = false;
          this.config.callbacks.onInterrupted?.();
          this.notifyStats();
        }

        if (sc.turnComplete) {
          this.turnEnded = true;
        }

        // Output audio from modelTurn
        if (sc.modelTurn?.parts) {
          if (this.turnEnded) {
            this.turnEnded = false;
            this.gatingOverridden = false;
          }
          for (const part of sc.modelTurn.parts) {
            if (part.inlineData?.data) {
              this.stats.audioChunksReceived++;
              if (this.stats.timeToFirstAudioMs === null && this.connectStartTime > 0) {
                this.stats.timeToFirstAudioMs = Date.now() - this.connectStartTime;
              }
              if (!this.gatingOverridden) {
                const pcm16 = base64ToPCM16(part.inlineData.data);
                const durationMs = (pcm16.length / 24000) * 1000;
                const now = Date.now();
                const currentScheduledEnd = Math.max(this.simulatedAudioEndMs, now);
                this.simulatedAudioEndMs = currentScheduledEnd + durationMs;
                this.simulatedGatingUntil = this.simulatedAudioEndMs + 300;
                this.config.callbacks.onAudioChunk?.(pcm16.buffer);
              }
            }
          }
          this.notifyStats();
        }

        // Output transcription (coach speech)
        if (sc.outputTranscription?.text) {
          this.stats.transcriptsReceived++;
          const cleaned = cleanTranscript(sc.outputTranscription.text);
          if (cleaned) {
            this.config.callbacks.onTranscript({
              id: `coach-${Date.now()}-${Math.random()}`,
              source: 'coach',
              text: cleaned,
              timestamp: Date.now(),
            });
          }
          this.notifyStats();
        }

        // Input transcription (trainee speech)
        if (sc.inputTranscription?.text) {
          this.stats.transcriptsReceived++;
          const cleaned = cleanTranscript(sc.inputTranscription.text);
          if (cleaned) {
            this.config.callbacks.onTranscript({
              id: `trainee-${Date.now()}-${Math.random()}`,
              source: 'trainee',
              text: cleaned,
              timestamp: Date.now(),
            });
          }
          this.notifyStats();
        }
      }

      // 4. Tool calls
      if (msg.toolCall?.functionCalls) {
        this.handleToolCalls(msg.toolCall.functionCalls);
        this.notifyStats();
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  }

  private async handleToolCalls(
    calls: Array<{ id: string; name: string; args: Record<string, unknown> }>
  ): Promise<void> {
    const responses = [];

    for (const call of calls) {
      const toolStart = Date.now();
      let result: Record<string, unknown>;
      try {
        result = await this.config.callbacks.onToolCall({
          id: call.id,
          name: call.name,
          args: call.args || {},
        });
      } catch (err) {
        console.error(`Tool call ${call.name} failed:`, err);
        result = { error: 'Tool execution failed' };
      }
      const toolElapsed = Date.now() - toolStart;
      if (call.name === 'verify_step') {
        this.recordVerifyLatency(toolElapsed);
      } else if (call.name === 'point_at') {
        this.recordPointLatency(toolElapsed);
      } else {
        this.recordToolLatency(toolElapsed);
      }

      responses.push({
        id: call.id,
        name: call.name,
        response: { result },
      });
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          toolResponse: {
            functionResponses: responses,
          },
        })
      );
    }
  }

  private scheduleReconnect(): void {
    if (this.explicitlyClosed) return;

    const now = Date.now();
    // Rolling 60s window: prune timestamps older than 60s
    this.reconnectTimestamps = this.reconnectTimestamps.filter((t) => now - t < 60000);

    const maxReconnectsInWindow = this.maxReconnectAttempts || 3;
    if (this.reconnectTimestamps.length >= maxReconnectsInWindow) {
      console.error(
        `Connection keeps dropping (${this.reconnectTimestamps.length} reconnects within rolling 60s). Last close code: ${this.stats.lastCloseCode}, reason: "${this.stats.lastCloseReason}"`
      );
      this.setState('error');
      this.config.callbacks.onError(new Error('Connection keeps dropping'));
      return;
    }

    this.reconnectTimestamps.push(now);
    this.reconnectAttempts++;
    this.setState('reconnecting');

    // Exponential backoff: 500ms, 1500ms, 3000ms
    const delay = Math.min(500 * Math.pow(2, this.reconnectAttempts - 1), 3000);
    console.log(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms...`);

    if (this.reconnectTimeoutId !== null) {
      clearTimeout(this.reconnectTimeoutId);
    }

    this.reconnectTimeoutId = window.setTimeout(() => {
      this.reconnectTimeoutId = null;
      this.connect(true);
    }, delay);
  }

  public manualRetry(): void {
    this.clearSetupTimeout();
    this.reconnectAttempts = 0;
    this.reconnectTimestamps = [];
    this.connect(this.hasCompletedFirstSetup);
  }

  /**
   * Streams a ~40ms chunk of 16 kHz PCM16 audio.
   */
  public sendAudio(base64PCM16: string, byteLength?: number): void {
    if (!this.isReady() || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.stats.micChunksSent++;
    this.notifyStats();

    let dataToSend = base64PCM16;
    if (this.isGating()) {
      const actualByteLength =
        byteLength !== undefined
          ? byteLength
          : base64ToPCM16(base64PCM16).byteLength;
      dataToSend = createSilencePcmBase64(actualByteLength);
    }

    const payload = {
      realtimeInput: {
        audio: {
          data: dataToSend,
          mimeType: 'audio/pcm;rate=16000',
        },
      },
    };

    this.ws.send(JSON.stringify(payload));
  }

  /**
   * Streams a JPEG frame (at most 1 frame per second).
   */
  public sendVideoFrame(base64Jpeg: string): boolean {
    if (!this.isReady() || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const now = Date.now();
    // Enforce max 1 frame per second
    if (now - this.lastVideoSentTime < 1000) {
      return false;
    }

    this.lastVideoSentTime = now;
    this.stats.videoFramesSent++;
    this.notifyStats();

    const payload = {
      realtimeInput: {
        video: {
          data: base64Jpeg,
          mimeType: 'image/jpeg',
        },
      },
    };

    this.ws.send(JSON.stringify(payload));
    return true;
  }

  /**
   * Sends text input to the session.
   */
  public sendText(text: string): void {
    if (!this.isReady() || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const payload = {
      realtimeInput: {
        text,
      },
    };

    this.ws.send(JSON.stringify(payload));
  }

  /**
   * Injects a camera event into the live coaching session.
   * Ready for P5 Step Watcher integration.
   */
  public sendCameraEvent(eventText: string): void {
    this.sendText(`[CAMERA EVENT] ${eventText}`);
  }

  /**
   * Closes the connection and cancels reconnect timers.
   */
  public close(): void {
    this.explicitlyClosed = true;
    this.clearSetupTimeout();
    this.reconnectTimestamps = [];
    if (this.reconnectTimeoutId !== null) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.setState('closed');
  }
}
