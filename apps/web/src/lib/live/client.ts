import { liveToken } from '../api';
import type { Skill } from '../../../../../shared/schema/ts/skills';
import type { LanguageCode } from '../../i18n';
import { buildLiveSystemInstruction, cleanTranscript } from './prompt';
import type {
  LiveClientCallbacks,
  LiveConnectionState,
} from './types';
import { base64ToPCM16 } from './audio';

const WS_BASE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

export interface LiveClientConfig {
  skill: Skill;
  language: LanguageCode;
  getCurrentStep: () => number;
  callbacks: LiveClientCallbacks;
  maxReconnectAttempts?: number;
}

export class GeminiLiveClient {
  private config: LiveClientConfig;
  private ws: WebSocket | null = null;
  private state: LiveConnectionState = 'idle';
  private explicitlyClosed = false;
  private setupDone = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts: number;
  private reconnectTimeoutId: number | null = null;
  private lastVideoSentTime = 0;

  constructor(config: LiveClientConfig) {
    this.config = config;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 3;
  }

  public getState(): LiveConnectionState {
    return this.state;
  }

  public isReady(): boolean {
    return this.state === 'connected' && this.setupDone;
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

    try {
      // 1. Fetch fresh single-use token from backend takumi-api
      const tokenResp = await liveToken('coach');
      const token = tokenResp.token;

      if (this.explicitlyClosed) return;

      // 2. Open WebSocket
      const wsUrl = `${WS_BASE_URL}?access_token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.sendSetupMessage(isReconnect);
      };

      ws.onmessage = (event: MessageEvent) => {
        if (this.ws !== ws) return;
        this.handleMessage(event.data);
      };

      ws.onerror = (err) => {
        console.error('Gemini Live WebSocket error:', err);
      };

      ws.onclose = (event) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.setupDone = false;

        if (!this.explicitlyClosed) {
          console.warn(`WebSocket closed unexpectedly (code: ${event.code}), scheduling reconnect...`);
          this.scheduleReconnect();
        } else {
          this.setState('closed');
        }
      };
    } catch (err) {
      console.error('Failed to establish Live session connection:', err);
      if (!this.explicitlyClosed) {
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

  private handleMessage(data: string | Blob): void {
    if (typeof data !== 'string') {
      console.warn('Received non-string WebSocket message, ignoring');
      return;
    }

    try {
      const msg = JSON.parse(data);

      // 1. Setup complete confirmation
      if (msg.setupComplete) {
        this.setupDone = true;
        const wasReconnecting = this.state === 'reconnecting';
        this.reconnectAttempts = 0;
        this.setState('connected');

        if (wasReconnecting) {
          const currentStep = this.config.getCurrentStep();
          const stepObj = this.config.skill.steps.find((s) => s.n === currentStep) || this.config.skill.steps[0];
          const instruction =
            stepObj.translations?.[this.config.language]?.instruction || stepObj.instruction;
          this.sendText(`Resume at step ${currentStep}: ${instruction}`);
        }
        return;
      }

      // 2. GoAway / server graceful close -> trigger reconnect
      if (msg.goAway) {
        console.warn('Server sent goAway, reconnecting...');
        this.ws?.close();
        return;
      }

      // 3. Server content: Audio, transcripts, interruption
      if (msg.serverContent) {
        const sc = msg.serverContent;

        if (sc.interrupted) {
          this.config.callbacks.onInterrupted?.();
        }

        // Output audio from modelTurn
        if (sc.modelTurn?.parts) {
          for (const part of sc.modelTurn.parts) {
            if (part.inlineData?.data) {
              const pcm16 = base64ToPCM16(part.inlineData.data);
              this.config.callbacks.onAudioChunk?.(pcm16.buffer);
            }
          }
        }

        // Output transcription (coach speech)
        if (sc.outputTranscription?.text) {
          const cleaned = cleanTranscript(sc.outputTranscription.text);
          if (cleaned) {
            this.config.callbacks.onTranscript({
              id: `coach-${Date.now()}-${Math.random()}`,
              source: 'coach',
              text: cleaned,
              timestamp: Date.now(),
            });
          }
        }

        // Input transcription (trainee speech)
        if (sc.inputTranscription?.text) {
          const cleaned = cleanTranscript(sc.inputTranscription.text);
          if (cleaned) {
            this.config.callbacks.onTranscript({
              id: `trainee-${Date.now()}-${Math.random()}`,
              source: 'trainee',
              text: cleaned,
              timestamp: Date.now(),
            });
          }
        }
      }

      // 4. Tool calls
      if (msg.toolCall?.functionCalls) {
        this.handleToolCalls(msg.toolCall.functionCalls);
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

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`Max reconnect attempts (${this.maxReconnectAttempts}) reached.`);
      this.setState('error');
      return;
    }

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
    this.reconnectAttempts = 0;
    this.connect(true);
  }

  /**
   * Streams a ~40ms chunk of 16 kHz PCM16 audio.
   */
  public sendAudio(base64PCM16: string): void {
    if (!this.isReady() || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const payload = {
      realtimeInput: {
        audio: {
          data: base64PCM16,
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
