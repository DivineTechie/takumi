import type { LanguageCode } from '../../i18n';

export type LiveConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'closed';

export interface LiveTranscriptItem {
  id: string;
  source: 'coach' | 'trainee';
  text: string;
  timestamp: number;
}

export interface LiveToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LiveClientStats {
  setupCompleteReceived: boolean;
  setupCompleteMs: number | null;
  kickoffSentCount: number;
  micChunksSent: number;
  videoFramesSent: number;
  audioChunksReceived: number;
  transcriptsReceived: number;
  lastCloseCode: number | null;
  lastCloseReason: string;
  interruptedCount: number;
  playbackUnderruns: number;
  isGating: boolean;
  tokenFetchMs: number | null;
  timeToFirstAudioMs: number | null;
  lastVerifyLatencyMs: number | null;
  medianVerifyLatencyMs: number | null;
  lastPointLatencyMs: number | null;
  medianPointLatencyMs: number | null;
  lastToolLatencyMs: number | null;
  medianToolLatencyMs: number | null;
}

export interface LiveClientCallbacks {
  onStateChange: (state: LiveConnectionState) => void;
  onAudioChunk?: (chunk: ArrayBuffer) => void;
  onInterrupted?: () => void;
  onTranscript: (item: LiveTranscriptItem) => void;
  onToolCall: (call: LiveToolCall) => Promise<Record<string, unknown>> | Record<string, unknown>;
  onError: (err: Error) => void;
  onStatsUpdate?: (stats: LiveClientStats) => void;
}

export interface SystemInstructionOptions {
  currentStep?: number;
  resumed?: boolean;
}

export const LANGUAGE_DISPLAY_NAMES: Record<LanguageCode, { native: string; english: string }> = {
  en: { native: 'English', english: 'English' },
  ja: { native: '日本語', english: 'Japanese' },
  vi: { native: 'Tiếng Việt', english: 'Vietnamese' },
  hi: { native: 'हिन्दी', english: 'Hindi' },
  id: { native: 'Bahasa Indonesia', english: 'Indonesian' },
  fil: { native: 'Filipino', english: 'Filipino' },
};
