import { useState, useRef, useCallback, useEffect } from 'react';
import { fetchLiveToken } from '../../../lib/api';
import type { CaptureMessage } from './useCameraStream';

export interface TranscriptItem {
  t: number;
  speaker: 'interviewer' | 'master';
  text: string;
}

export interface UseGeminiLiveOptions {
  sourceLanguage: string;
  onQuestionAsked?: (question: string) => void;
}

export interface UseGeminiLiveResult {
  isConnected: boolean;
  isConnecting: boolean;
  currentQuestion: string | null;
  questionCount: number;
  transcript: TranscriptItem[];
  error: CaptureMessage | null;
  startLiveSession: (mediaStream: MediaStream, captureFrameFn: () => string | null) => Promise<boolean>;
  stopLiveSession: () => void;
}

function cleanTranscriptText(raw: string): string {
  return raw
    .replace(/<no\s*speech>/gi, '')
    .replace(/\{pause\}/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export function useGeminiLive(options: UseGeminiLiveOptions): UseGeminiLiveResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [currentQuestion, setCurrentQuestion] = useState<string | null>(null);
  const [questionCount, setQuestionCount] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [error, setError] = useState<CaptureMessage | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextPlayTimeRef = useRef<number>(0);
  const videoIntervalRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const shouldStayConnectedRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const captureFrameRef = useRef<(() => string | null) | null>(null);

  // Stop 24 kHz playback immediately on interruption
  const stopPlayback = useCallback(() => {
    scheduledSourcesRef.current.forEach((source) => {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // ignore if already finished
      }
    });
    scheduledSourcesRef.current = [];
    if (playbackContextRef.current) {
      nextPlayTimeRef.current = playbackContextRef.current.currentTime;
    }
  }, []);

  // Play 24 kHz mono 16-bit PCM audio chunks from Gemini Live
  const playPcmAudio = useCallback(
    (base64Pcm: string) => {
      try {
        if (!playbackContextRef.current) {
          const AudioContextClass =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          playbackContextRef.current = new AudioContextClass({ sampleRate: 24000 });
        }

        const ctx = playbackContextRef.current;
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }

        const buffer = base64ToArrayBuffer(base64Pcm);
        const pcm16 = new Int16Array(buffer);
        const float32 = new Float32Array(pcm16.length);

        for (let i = 0; i < pcm16.length; i++) {
          float32[i] = pcm16[i] / 32768.0;
        }

        const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
        audioBuffer.copyToChannel(float32, 0);

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);

        const now = ctx.currentTime;
        if (nextPlayTimeRef.current < now) {
          nextPlayTimeRef.current = now;
        }

        source.start(nextPlayTimeRef.current);
        nextPlayTimeRef.current += audioBuffer.duration;

        scheduledSourcesRef.current.push(source);
        source.onended = () => {
          scheduledSourcesRef.current = scheduledSourcesRef.current.filter((s) => s !== source);
        };
      } catch (err) {
        console.warn('Error playing live interviewer audio:', err);
      }
    },
    []
  );

  // Connects WebSocket to Gemini Live
  const connectWebSocket = useCallback(
    async (token: string): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(
          token
        )}`;

        const ws = new WebSocket(url);
        socketRef.current = ws;

        ws.onopen = () => {
          setIsConnected(true);
          setIsConnecting(false);

          // Language-specific instruction
          const langPrompt =
            options.sourceLanguage === 'ja'
              ? '日本語で話してください。'
              : options.sourceLanguage === 'vi'
              ? 'Nói bằng tiếng Việt.'
              : options.sourceLanguage === 'hi'
              ? 'हिंदी में बोलें।'
              : options.sourceLanguage === 'id'
              ? 'Bicara dalam bahasa Indonesia.'
              : options.sourceLanguage === 'fil'
              ? 'Magsalita sa Tagalog/Filipino.'
              : 'Speak in English.';

          // 1. Initial Setup Message
          const setupMsg = {
            setup: {
              model: 'models/gemini-3.8-live',
              generationConfig: {
                responseModalities: ['AUDIO'],
              },
              systemInstruction: {
                parts: [
                  {
                    text: `You are a curious apprentice watching a master craftsman. ${langPrompt} Speak only in the master's language; ask one question at a time, under 12 words, only at natural pauses; ask WHY they do things, how they know a step is right, what beginners get wrong, and what is dangerous; never interrupt while their hands are busy; 4-8 questions per session; otherwise stay silent.`,
                  },
                ],
              },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              contextWindowCompression: {
                slidingWindow: {},
              },
            },
          };

          ws.send(JSON.stringify(setupMsg));
          resolve(true);
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            const serverContent = data.serverContent;
            if (!serverContent) return;

            // Handle interruption
            if (serverContent.interrupted) {
              stopPlayback();
            }

            // Audio output from modelTurn
            if (serverContent.modelTurn?.parts) {
              for (const part of serverContent.modelTurn.parts) {
                if (part.inlineData?.data) {
                  playPcmAudio(part.inlineData.data);
                }
              }
            }

            // Transcriptions
            const elapsed = Math.max(
              0,
              Math.round(((Date.now() - startTimeRef.current) / 1000) * 10) / 10
            );

            // Output transcription (interviewer)
            if (serverContent.outputTranscription?.text) {
              const cleaned = cleanTranscriptText(serverContent.outputTranscription.text);
              if (cleaned) {
                setCurrentQuestion(cleaned);
                setQuestionCount((c) => c + 1);
                options.onQuestionAsked?.(cleaned);
                setTranscript((prev) => [
                  ...prev,
                  { t: elapsed, speaker: 'interviewer', text: cleaned },
                ]);
              }
            }

            // Input transcription (master)
            if (serverContent.inputTranscription?.text) {
              const cleaned = cleanTranscriptText(serverContent.inputTranscription.text);
              if (cleaned) {
                setTranscript((prev) => [
                  ...prev,
                  { t: elapsed, speaker: 'master', text: cleaned },
                ]);
              }
            }
          } catch (e) {
            console.error('Error parsing live socket message:', e);
          }
        };

        ws.onerror = (e) => {
          console.error('Gemini Live WebSocket error:', e);
          setError({ key: 'app.capture_live_socket_error' });
        };

        ws.onclose = async () => {
          setIsConnected(false);
          stopPlayback();

          // Auto-reconnect if recording is still active
          if (shouldStayConnectedRef.current) {
            try {
              const tokenRes = await fetchLiveToken('interview');
              await connectWebSocket(tokenRes.token);
            } catch (err) {
              console.warn('Reconnection failed:', err);
            }
          }
        };
      });
    },
    [options, playPcmAudio, stopPlayback]
  );

  // Start the entire live session
  const startLiveSession = useCallback(
    async (
      mediaStream: MediaStream,
      captureFrameFn: () => string | null
    ): Promise<boolean> => {
      setIsConnecting(true);
      setError(null);
      shouldStayConnectedRef.current = true;
      streamRef.current = mediaStream;
      captureFrameRef.current = captureFrameFn;
      startTimeRef.current = Date.now();

      // Acquire screen wake lock
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
        }
      } catch (err) {
        console.warn('Screen wake lock not granted:', err);
      }

      try {
        // 1. Fetch Live token
        const tokenRes = await fetchLiveToken('interview');

        // 2. Setup AudioWorklet for 16 kHz PCM microphone capture
        const AudioContextClass =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const audioCtx = new AudioContextClass();
        audioContextRef.current = audioCtx;

        await audioCtx.audioWorklet.addModule('/pcm-processor.js');
        const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
        workletNodeRef.current = workletNode;

        const micSource = audioCtx.createMediaStreamSource(mediaStream);
        micSource.connect(workletNode);

        // Send 16 kHz PCM chunks (~40ms) to WebSocket
        workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
          if (socketRef.current?.readyState === WebSocket.OPEN) {
            const base64Audio = arrayBufferToBase64(event.data);
            const audioPayload = {
              realtimeInput: {
                audio: {
                  data: base64Audio,
                  mimeType: 'audio/pcm;rate=16000',
                },
              },
            };
            socketRef.current.send(JSON.stringify(audioPayload));
          }
        };

        // 3. Connect WebSocket
        await connectWebSocket(tokenRes.token);

        // 4. Video stream at 1 FPS (768px wide JPEG)
        videoIntervalRef.current = window.setInterval(() => {
          if (socketRef.current?.readyState === WebSocket.OPEN && captureFrameRef.current) {
            const frameB64 = captureFrameRef.current();
            if (frameB64) {
              const videoPayload = {
                realtimeInput: {
                  video: {
                    data: frameB64,
                    mimeType: 'image/jpeg',
                  },
                },
              };
              socketRef.current.send(JSON.stringify(videoPayload));
            }
          }
        }, 1000);

        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Failed to initialize Gemini Live session:', msg);
        setError({ key: 'app.capture_raw_error', params: { message: msg } });
        setIsConnecting(false);
        setIsConnected(false);
        return false;
      }
    },
    [connectWebSocket]
  );

  // Stop the live session
  const stopLiveSession = useCallback(() => {
    shouldStayConnectedRef.current = false;

    if (videoIntervalRef.current !== null) {
      clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }

    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    stopPlayback();

    if (playbackContextRef.current) {
      playbackContextRef.current.close().catch(() => {});
      playbackContextRef.current = null;
    }

    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }

    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }

    setIsConnected(false);
    setIsConnecting(false);
  }, [stopPlayback]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopLiveSession();
    };
  }, [stopLiveSession]);

  return {
    isConnected,
    isConnecting,
    currentQuestion,
    questionCount,
    transcript,
    error,
    startLiveSession,
    stopLiveSession,
  };
}
