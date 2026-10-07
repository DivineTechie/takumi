import { auth } from './firebase';
import type { Session } from '../../../../shared/schema/ts/sessions';
import type { SessionEvent } from '../../../../shared/schema/ts/session_events';

export class NotSignedInError extends Error {
  constructor(message = 'User is not signed in') {
    super(message);
    this.name = 'NotSignedInError';
  }
}

export class ApiError extends Error {
  public status: number;
  public data?: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export interface MeResponse {
  uid: string;
  role: 'trainee' | 'master' | 'supervisor';
  display_name: string | null;
  role_assigned: boolean;
}

export interface LiveTokenResponse {
  token: string;
  model: string;
  max_minutes: number;
}

export interface ForgeJobResponse {
  job_id: string;
  skill_id: string;
}

export interface ForgeJobStatus {
  capture_id: string;
  skill_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  started_at: string | null;
  finished_at: string | null;
}

export interface CommonMistakeItem {
  description: string;
  visual_cue: string;
}

export interface WatchRequest {
  step: number;
  instruction: string;
  success_criteria: string;
  common_mistakes?: CommonMistakeItem[];
  safety_rules?: string[];
  image_b64: string;
}

export interface WatchResponse {
  state: 'done' | 'in_progress' | 'mistake' | 'not_visible' | 'hazard' | 'error';
  reason: string;
  fix: string;
  rule?: string | null;
  secs: number;
}

export interface VerifyRequest {
  step: number;
  instruction: string;
  success_criteria: string;
  safety_rules?: string[];
  image_b64: string;
}

export interface VerifyResponse {
  passed: boolean;
  visible: boolean;
  reason: string;
  fix: string;
  secs: number;
}

export interface PointRequest {
  target: string;
  image_b64: string;
}

export interface PointItem {
  point: [number, number];
  label: string;
}

export interface PointResponse {
  points: PointItem[];
  secs: number;
}

export interface CreateSessionRequest {
  skill_id: string;
  language: string;
}

export interface CreateSessionEventRequest {
  step: number;
  type: SessionEvent['type'];
  source: SessionEvent['source'];
  reason?: string;
  latency_ms?: number;
  frame_uri?: string;
  image_b64?: string;
}

/**
 * Returns a valid Firebase ID token if a user is signed in.
 * Throws NotSignedInError if unauthenticated.
 */
export async function getIdToken(): Promise<string> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new NotSignedInError();
  }
  return await currentUser.getIdToken();
}

/**
 * Generic typed API fetcher with Bearer token authentication and error handling.
 */
export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getIdToken();
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData) && !(options.body instanceof Blob)) {
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
  }

  const res = await fetch(path, { ...options, headers });

  if (res.status === 401) {
    throw new ApiError('Unauthorized', 401);
  }

  if (res.status === 429) {
    throw new ApiError('Daily limit reached', 429);
  }

  if (!res.ok) {
    let errorDetail = res.statusText;
    let data: unknown;
    try {
      data = await res.json();
      if (typeof data === 'object' && data !== null && 'detail' in data) {
        errorDetail = (data as { detail: string }).detail;
      }
    } catch {
      try {
        errorDetail = await res.text();
      } catch {
        // ignore
      }
    }
    throw new ApiError(errorDetail || `Request failed with status ${res.status}`, res.status, data);
  }

  return (await res.json()) as T;
}

// --- Endpoints for Member A ---

export async function getMe(): Promise<MeResponse> {
  return await apiFetch<MeResponse>('/api/me');
}

export async function liveToken(
  purpose: 'interview' | 'coach' = 'coach'
): Promise<LiveTokenResponse> {
  return await apiFetch<LiveTokenResponse>('/api/live-token', {
    method: 'POST',
    body: JSON.stringify({ purpose }),
  });
}

export async function watch(req: WatchRequest): Promise<WatchResponse> {
  return await apiFetch<WatchResponse>('/api/watch', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function verify(req: VerifyRequest): Promise<VerifyResponse> {
  return await apiFetch<VerifyResponse>('/api/verify', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function point(req: PointRequest): Promise<PointResponse> {
  return await apiFetch<PointResponse>('/api/point', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function createSession(req: CreateSessionRequest): Promise<Session> {
  return await apiFetch<Session>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function postSessionEvent(
  sessionId: string,
  req: CreateSessionEventRequest
): Promise<SessionEvent> {
  return await apiFetch<SessionEvent>(`/api/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function endSession(
  sessionId: string,
  status: 'completed' | 'abandoned'
): Promise<Session & { passport_id?: string | null; clean_runs?: number }> {
  return await apiFetch<Session & { passport_id?: string | null; clean_runs?: number }>(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

// --- Member B functions preserved with same signatures, backed by apiFetch ---

export async function fetchLiveToken(
  purpose: 'interview' | 'coach' = 'interview'
): Promise<LiveTokenResponse> {
  return await liveToken(purpose);
}

export async function triggerForgeJob(captureId: string): Promise<ForgeJobResponse> {
  return await apiFetch<ForgeJobResponse>('/forge/jobs', {
    method: 'POST',
    body: JSON.stringify({ capture_id: captureId }),
  });
}

export async function fetchForgeJob(jobId: string): Promise<ForgeJobStatus> {
  return await apiFetch<ForgeJobStatus>(`/forge/jobs/${jobId}`);
}

export async function regenerateStepPart(
  skillId: string,
  n: number,
  part: string
): Promise<{ success: boolean; message?: string }> {
  return await apiFetch<{ success: boolean; message?: string }>('/forge/steps/regenerate', {
    method: 'POST',
    body: JSON.stringify({ skill_id: skillId, n, part }),
  });
}

// --- Supervisor Insight Endpoints (Role: supervisor only) ---

export interface MatrixTrainee {
  uid: string;
  first_name: string;
}

export interface MatrixSkill {
  id: string;
  title: string;
}

export interface MatrixCell {
  uid: string;
  skill_id: string;
  status: 'certified' | 'learning' | 'not_started';
  sessions: number;
  last_session_at: string | null;
  mistakes_trend: number[];
}

export interface InsightsMatrixResponse {
  trainees: MatrixTrainee[];
  skills: MatrixSkill[];
  cells: MatrixCell[];
}

export async function fetchInsightsMatrix(): Promise<InsightsMatrixResponse> {
  return await apiFetch<InsightsMatrixResponse>('/api/insights/matrix');
}

export interface SkillStepInsight {
  n: number;
  instruction: string;
  sessions_reached: number;
  mistake_rate: number | null;
  median_secs: number | null;
  safety_stops: number | null;
}

export interface SkillInsightsTotals {
  sessions: number;
  completed: number;
  median_duration_s: number | null;
}

export interface SkillInsightsResponse {
  steps: SkillStepInsight[];
  totals: SkillInsightsTotals;
}

export async function fetchSkillInsights(skillId: string): Promise<SkillInsightsResponse> {
  return await apiFetch<SkillInsightsResponse>(`/api/insights/skill/${skillId}`);
}

export interface SessionReplaySession {
  id: string;
  skill_id: string;
  first_name: string;
  status: 'live' | 'completed' | 'abandoned';
  started_at: string;
  ended_at?: string | null;
  language: string;
  current_step?: number;
  steps?: Array<{
    n: number;
    state: 'pending' | 'active' | 'done';
    mistakes: number;
    attempts: number;
    secs: number;
  }>;
  result?: {
    passed: boolean;
    duration_s: number;
    mistakes: number;
    safety_stops: number;
  } | null;
}

export interface SessionReplayEvent {
  t: string;
  step?: number;
  type:
    | 'step_done'
    | 'mistake'
    | 'blocked'
    | 'safety_stop'
    | 'ask_why'
    | 'ask_master'
    | 'point'
    | 'verify'
    | 'coach_line'
    | 'trainee_line';
  source: 'watcher' | 'verify' | 'coach' | 'trainee';
  reason?: string | null;
  latency_ms?: number;
  frame_uri?: string | null;
}

export interface SessionReplayResponse {
  session: SessionReplaySession;
  events: SessionReplayEvent[];
}

export async function fetchSessionReplay(sessionId: string): Promise<SessionReplayResponse> {
  return await apiFetch<SessionReplayResponse>(`/api/sessions/${sessionId}/replay`);
}

// --- Skill Passport Types & Functions ---

export interface PublicPassport {
  id: string;
  display_first_name: string;
  skill_title: string;
  master_display_name: string;
  language: string;
  issued_at: string;
  sessions_count: number;
  verified: boolean;
  badge_url: string | null;
}

export interface MyPassport {
  id: string;
  skill_id: string;
  skill_title: string;
  display_first_name: string;
  master_display_name: string;
  language: string;
  issued_at: string;
  sessions_count: number;
  badge_url: string | null;
  verify_url: string;
}

export async function fetchPublicPassport(passportId: string): Promise<PublicPassport> {
  const res = await fetch(`/api/passports/${passportId}`);
  if (!res.ok) {
    if (res.status === 404) {
      throw new ApiError('This certificate could not be found.', 404);
    }
    throw new ApiError(await res.text(), res.status);
  }
  return await res.json();
}

export async function fetchMyPassports(): Promise<{ passports: MyPassport[] }> {
  return await apiFetch<{ passports: MyPassport[] }>('/api/me/passports');
}

export interface SystemStatusResponse {
  api: string;
  sessions_enabled: boolean;
  last_24h: {
    sessions: number;
    p50_ms: {
      watch: number | null;
      verify: number | null;
      point: number | null;
      decision_to_audio: number | null;
    };
    p90_ms: {
      watch: number | null;
      verify: number | null;
      point: number | null;
      decision_to_audio: number | null;
    };
  };
}

export async function fetchSystemStatus(): Promise<SystemStatusResponse> {
  const res = await fetch('/api/status');
  if (!res.ok) {
    throw new ApiError(await res.text(), res.status);
  }
  return await res.json();
}

export interface MasterClipResponse {
  url: string;
  start_s: number;
  end_s: number;
  why: string;
  why_lang: string;
  translated: boolean;
}

export interface MistakeClipResponse {
  url: string;
  label: string;
}

export async function fetchSkillMedia(
  skillId: string,
  step: number,
  kind: 'master_clip',
  lang?: string
): Promise<MasterClipResponse>;
export async function fetchSkillMedia(
  skillId: string,
  step: number,
  kind: 'mistake_clip',
  lang?: string
): Promise<MistakeClipResponse>;
export async function fetchSkillMedia(
  skillId: string,
  step: number,
  kind: 'master_clip' | 'mistake_clip',
  lang = 'en'
): Promise<MasterClipResponse | MistakeClipResponse> {
  const query = new URLSearchParams({
    step: String(step),
    kind,
    lang,
  });
  return await apiFetch(`/api/skills/${encodeURIComponent(skillId)}/media?${query.toString()}`);
}

export interface CitationInfo {
  type: string;
  t_start?: number | null;
  t_end?: number | null;
  step?: number | null;
  quote?: string | null;
}

export interface AskMasterResponse {
  answer: string;
  citation?: CitationInfo | null;
  clip?: {
    step: number;
    start_s: number;
    end_s: number;
  } | null;
}

export async function askMaster(
  skillId: string,
  question: string,
  language = 'en'
): Promise<AskMasterResponse> {
  return await apiFetch<AskMasterResponse>('/api/ask', {
    method: 'POST',
    body: JSON.stringify({
      skill_id: skillId,
      question,
      language,
    }),
  });
}


