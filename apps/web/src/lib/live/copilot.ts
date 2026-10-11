import { liveToken } from '../api';
import { cleanTranscript } from './prompt';
import { createAndResumeAudioContexts, createSilencePcmBase64, OutputAudioQueue, setupMicCapture, type MicCaptureHandle } from './audio';

/**
 * Voice operations copilot (control tower). A Gemini Live session the supervisor talks to; every fact
 * comes from tools that the browser runs against TAKUMI's own API with the supervisor's sign-in, so
 * the model never sees data it could not have read in the app, and it cannot approve anything.
 */

const WS_BASE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

export type CopilotState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error' | 'closed';

export interface CopilotTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface CopilotCallbacks {
  onState: (s: CopilotState) => void;
  onUserText: (text: string, final: boolean) => void;
  onModelText: (text: string, final: boolean) => void;
  onTool: (name: string, phase: 'start' | 'done' | 'error') => void;
  onError: (message: string) => void;
}

export const COPILOT_INSTRUCTION = `You are TAKUMI, the voice operations copilot for the supervisor of a small factory.
Rules:
- Before answering any question about machines, orders, quality, units or work orders, call the matching tool.
  Every number you say must come from a tool result in this conversation. If a tool has no data, say so.
- Say where a number comes from when it matters: LIVE (this factory), HOME RIG (our camera test bench) or PUBLIC DATA.
- Answer in the language the supervisor speaks. Keep answers to two or three short spoken sentences, then stop.
- You can ask the maintenance agent to draft a work order or the planner to analyse orders, but you cannot approve,
  hold, release or change anything: tell the supervisor to approve it on screen.
- Never guess machine causes yourself; use the maintenance agent's draft when the supervisor asks why a machine stopped.
- No personal data: never mention people's names or emails.`;

export class CopilotSession {
  private ws: WebSocket | null = null;
  private queue: OutputAudioQueue | null = null;
  private outCtx: AudioContext | null = null;
  private micCtx: AudioContext | null = null;
  private mic: MicCaptureHandle | null = null;
  private stream: MediaStream | null = null;
  private closed = false;
  private userLine = '';
  private modelLine = '';
  private speakingTimer: number | null = null;

  constructor(private tools: CopilotTool[], private cb: CopilotCallbacks) {}

  /** Must be called from a user gesture (audio contexts are created synchronously first). */
  async start(): Promise<void> {
    const { outputContext, micContext } = createAndResumeAudioContexts();
    this.outCtx = outputContext;
    this.micCtx = micContext;
    this.queue = new OutputAudioQueue(outputContext);
    this.cb.onState('connecting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const { token } = await liveToken('copilot');
      if (this.closed) return this.stop();
      const ws = new WebSocket(`${WS_BASE_URL}?access_token=${encodeURIComponent(token)}`);
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify(this.setupMessage()));
      ws.onmessage = (e) => void this.onMessage(e.data);
      ws.onerror = () => this.fail('The voice connection failed.');
      ws.onclose = (e) => {
        if (!this.closed) this.fail(e.code === 1008 ? 'The voice session expired. Tap to start again.' : 'The voice session ended.');
      };
    } catch (e) {
      this.fail(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Allow the microphone to talk to TAKUMI.' : 'Could not start the voice copilot.');
    }
  }

  /** Sends a typed question (also used by the suggestion chips). */
  ask(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.queue?.flush();
    this.cb.onUserText(text, true);
    this.ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }));
  }

  stop(): void {
    this.closed = true;
    try {
      this.mic?.stop();
      this.stream?.getTracks().forEach((t) => t.stop());
      this.queue?.flush();
      this.ws?.close();
      void this.outCtx?.close().catch(() => {});
      void this.micCtx?.close().catch(() => {});
    } catch {
      // closing anyway
    }
    if (this.speakingTimer) window.clearInterval(this.speakingTimer);
    this.ws = null;
    this.cb.onState('closed');
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.cb.onError(message);
    this.stop();
    this.cb.onState('error');
  }

  private setupMessage(): unknown {
    return {
      setup: {
        model: 'models/gemini-3.8-live',
        generationConfig: { responseModalities: ['AUDIO'] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
        realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 700 } },
        systemInstruction: { parts: [{ text: COPILOT_INSTRUCTION }] },
        tools: [
          {
            functionDeclarations: this.tools.map((t) => ({
              name: t.name,
              description: t.description,
              ...(t.parameters ? { parameters: t.parameters } : {}),
            })),
          },
        ],
      },
    };
  }

  private async startMic(): Promise<void> {
    if (!this.stream || !this.micCtx) return;
    this.mic = await setupMicCapture(this.stream, this.micCtx, (b64, byteLength) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      // While TAKUMI is speaking, send silence so the speaker is not heard as the supervisor.
      const data = this.queue?.isPlayingWithTail(0.3) ? createSilencePcmBase64(byteLength ?? 1280) : b64;
      this.ws.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } }));
    });
    this.speakingTimer = window.setInterval(() => {
      if (!this.closed) this.cb.onState(this.queue?.isPlayingWithTail(0.2) ? 'speaking' : 'listening');
    }, 200);
  }

  private async onMessage(raw: unknown): Promise<void> {
    const text = typeof raw === 'string' ? raw : raw instanceof Blob ? await raw.text() : new TextDecoder().decode(raw as ArrayBuffer);
    let msg: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.setupComplete) {
      await this.startMic();
      this.cb.onState('listening');
      return;
    }
    const sc = msg.serverContent;
    if (sc) {
      if (sc.interrupted) this.queue?.flush();
      for (const part of sc.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) this.queue?.enqueueBase64(part.inlineData.data);
      }
      if (sc.inputTranscription?.text) {
        this.userLine += sc.inputTranscription.text;
        this.cb.onUserText(cleanTranscript(this.userLine), false);
      }
      if (sc.outputTranscription?.text) {
        if (this.userLine) {
          this.cb.onUserText(cleanTranscript(this.userLine), true);
          this.userLine = '';
        }
        this.modelLine += sc.outputTranscription.text;
        this.cb.onModelText(cleanTranscript(this.modelLine), false);
      }
      if (sc.turnComplete) {
        if (this.modelLine) this.cb.onModelText(cleanTranscript(this.modelLine), true);
        this.modelLine = '';
      }
    }
    if (msg.toolCall?.functionCalls) {
      if (this.userLine) {
        this.cb.onUserText(cleanTranscript(this.userLine), true);
        this.userLine = '';
      }
      const responses = await Promise.all(
        (msg.toolCall.functionCalls as { id: string; name: string; args?: Record<string, unknown> }[]).map(async (call) => {
          const tool = this.tools.find((t) => t.name === call.name);
          this.cb.onTool(call.name, 'start');
          try {
            const result = tool ? await tool.run(call.args ?? {}) : { error: `unknown tool ${call.name}` };
            this.cb.onTool(call.name, 'done');
            return { id: call.id, name: call.name, response: { result } };
          } catch {
            this.cb.onTool(call.name, 'error');
            return { id: call.id, name: call.name, response: { result: { error: 'The tool failed; tell the supervisor the data is unavailable.' } } };
          }
        })
      );
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    }
  }
}
