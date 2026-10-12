import { auth } from './firebase';
import type { Session } from '../../../../shared/schema/ts/sessions';
import type { SessionEvent } from '../../../../shared/schema/ts/session_events';
import type { Machine, NormalizedRoi } from '../../../../shared/schema/ts/machines';
import type { SoakRun, SoakTruth } from '../../../../shared/schema/ts/soak_runs';

export type { Machine, NormalizedRoi, SoakRun, SoakTruth };

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
  /** Station Watch: serial of the unit built in this session. */
  unit_id?: string;
  product_id?: string;
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

// --- Account and Station Watch sessions ---

export async function getMe(): Promise<MeResponse> {
  return await apiFetch<MeResponse>('/api/me');
}

export async function liveToken(
  purpose: 'interview' | 'coach' | 'copilot' = 'coach'
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
): Promise<Session> {
  return await apiFetch<Session>(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

// --- Live tokens and the Standard Work Studio ---

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

export interface InsightSkill {
  id: string;
  title: string;
}

/** Published skills for the supervisor dashboard (aggregate only, no per-worker data). */
export async function fetchInsightSkills(): Promise<{ skills: InsightSkill[] }> {
  return await apiFetch<{ skills: InsightSkill[] }>('/api/insights/skills');
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

export interface LiveLatencyRow {
  endpoint: string;
  n: number;
  p50_ms: number;
  p90_ms: number;
  model_p50_ms: number | null;
  first_ts: string | null;
  last_ts: string | null;
}

/** Public LIVE production timings for /evals (no sign-in). */
export async function fetchLiveLatency(days = 30): Promise<{ label: string; days: number; endpoints: LiveLatencyRow[] }> {
  const res = await fetch(`/api/evals/live?days=${days}`);
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

// ---------------------------------------------------------------------------
// End-of-Line Quality Inspection API (P15)
// ---------------------------------------------------------------------------

export interface InspectionStage {
  stage: string;
  model: string;
  defective: boolean;
  confidence: number;
  defect?: string | null;
  where?: string | null;
  ms: number;
}

export interface InspectResponse {
  inspection_id: string;
  product_id?: string;
  unit_id?: string | null;
  ai_verdict: 'ok' | 'defective' | 'needs_review';
  defective?: boolean;
  defect: string | null;
  where: string | null;
  confidence: number;
  mode: string;
  stages: InspectionStage[];
  checks_run?: number;
  total_ms: number;
  created_at?: string;
  inspector_uid?: string;
  dataset_label?: string;
  source?: string;
  human_decision?: string | null;
}

export interface ProductItem {
  id: string;
  name: string;
  description: string;
  defect_types: string[];
  reference_image_paths: string[];
  default_mode: 'few_false_alarms' | 'catch_everything';
  source: string;
  created_at: string;
}

export interface GalleryItem {
  id: string;
  category: string;
  image_url: string;
}

export interface InspectionInsightsResponse {
  live: {
    today_count: number;
    first_pass_rate: number | null;
    top_defect_types: { defect: string; count: number }[];
    flagged_awaiting_count: number;
    recent: Array<{
      id: string;
      unit_id: string | null;
      product_id: string;
      ai_verdict: string;
      defect: string | null;
      where: string | null;
      confidence: number;
      human_decision: string | null;
      created_at: string;
      image_url: string | null;
    }>;
  };
  gallery: {
    trials_count: number;
    hits_count: number;
    hit_rate: number | null;
    dataset: string;
  };
}

export async function fetchProducts(): Promise<ProductItem[]> {
  return await apiFetch<ProductItem[]>('/api/products');
}

export async function createProductWithImages(req: {
  name: string;
  description: string;
  defect_types: string[];
  images_b64: string[];
}): Promise<ProductItem> {
  return await apiFetch<ProductItem>('/api/products/with-images', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function fetchGallery(category?: string): Promise<GalleryItem[]> {
  const query = category ? `?category=${encodeURIComponent(category)}` : '';
  return await apiFetch<GalleryItem[]>(`/api/inspect/gallery${query}`);
}

export async function inspectUnit(params: {
  product_id: string;
  image_b64: string;
  unit_id?: string;
  mode?: 'few_false_alarms' | 'catch_everything';
}): Promise<InspectResponse> {
  return await apiFetch<InspectResponse>('/api/inspect', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function inspectGallery(params: {
  gallery_id: string;
  mode?: 'few_false_alarms' | 'catch_everything';
}): Promise<InspectResponse> {
  return await apiFetch<InspectResponse>('/api/inspect/gallery', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function submitInspectionDecision(
  inspectionId: string,
  decision: 'confirmed_defect' | 'overridden_ok' | 'confirmed_ok'
): Promise<{ status: string; human_decision: string; unit_status?: string }> {
  return await apiFetch(`/api/inspections/${encodeURIComponent(inspectionId)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  });
}

export async function fetchInspectionInsights(): Promise<InspectionInsightsResponse> {
  return await apiFetch<InspectionInsightsResponse>('/api/insights/inspections');
}

export async function startSoakRun(params: {
  duration_min: number;
  schedule_seed: number | string;
  machines: string[];
}): Promise<SoakRun> {
  return await apiFetch<SoakRun>('/api/soak', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function endSoakRun(id: string): Promise<SoakRun> {
  return await apiFetch<SoakRun>(`/api/soak/${encodeURIComponent(id)}/end`, {
    method: 'POST',
  });
}

export async function postSoakTruth(
  id: string,
  truth: {
    machine_id: string;
    event_type: 'state_change' | 'alarm' | 'alarm_cleared' | 'count';
    state?: string | null;
    count?: number | null;
    alarm_code?: string | null;
  }
): Promise<{ status: string }> {
  return await apiFetch<{ status: string }>(`/api/soak/${encodeURIComponent(id)}/truth`, {
    method: 'POST',
    body: JSON.stringify(truth),
  });
}

export interface UnitIssue {
  step: number | null;
  step_title: string | null;
  type: string;
  reason: string | null;
  t: string | null;
  frame_url: string | null;
}

export interface StationRecord {
  session_id: string;
  skill_id: string;
  station: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  steps_total: number;
  steps_done: number;
  incomplete_steps: number[];
  mistakes: number;
  safety_stops: number;
  issues: UnitIssue[];
}

export interface UnitInspection {
  id: string;
  created_at: string | null;
  ai_verdict: string | null;
  defect: string | null;
  where: string | null;
  human_decision: string | null;
  mode: string | null;
  source: string | null;
  image_url: string | null;
}

export interface UnitHistory {
  id: string;
  product_id: string | null;
  status: string;
  created_at: string | null;
  holds: { at: string; reason: string; source: string; previous_status: string | null }[];
  station_records: StationRecord[];
  inspections: UnitInspection[];
}

export interface UnitSummary {
  id: string;
  product_id: string | null;
  status: string;
  created_at: string | null;
  stations: number;
  inspections: number;
  issues: number;
}

export interface TracebackResult {
  unit_id: string;
  report: {
    summary: string;
    root_cause_station: string | null;
    root_cause_skill_id: string | null;
    root_cause_step: number | null;
    evidence: string[];
    confidence: 'low' | 'medium' | 'high';
    hold_unit_ids: string[];
    hold_reason: string;
    work_instruction_fix: string | null;
  };
  agent_steps: { agent: string; tool: string; args: Record<string, unknown> }[];
}

export async function fetchUnitHistory(id: string): Promise<UnitHistory> {
  return await apiFetch<UnitHistory>(`/api/units/${encodeURIComponent(id)}/history`);
}

export async function fetchUnits(status?: string): Promise<UnitSummary[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return await apiFetch<UnitSummary[]>(`/api/units${query}`);
}

export async function holdUnits(unitIds: string[], reason: string, source: 'traceback' | 'manual'): Promise<{
  held: string[];
  skipped: { id: string; reason: string }[];
}> {
  return await apiFetch('/api/units/hold', {
    method: 'POST',
    body: JSON.stringify({ unit_ids: unitIds, reason, source }),
  });
}

export async function releaseUnit(id: string): Promise<{ id: string; status: string }> {
  return await apiFetch(`/api/units/${encodeURIComponent(id)}/release`, { method: 'POST' });
}

export async function createReviewRequest(req: {
  skill_id: string;
  step: number;
  reason: string;
  suggested_instruction: string;
  suggested_success_criteria?: string;
  source: 'traceback' | 'supervisor';
  unit_id?: string;
}): Promise<{ id: string }> {
  return await apiFetch('/api/review-requests', { method: 'POST', body: JSON.stringify(req) });
}

export async function runTraceback(unitId: string): Promise<TracebackResult> {
  return await apiFetch<TracebackResult>('/forge/agents/traceback', {
    method: 'POST',
    body: JSON.stringify({ unit_id: unitId }),
  });
}

export interface ControlSourceKpis {
  inspected: number;
  ok: number;
  defective: number;
  needs_review: number;
  first_pass_rate: number | null;
  confirmed_defects: number;
  overridden: number;
  stations_completed: number;
  steps_verified: number;
  mistakes: number;
  safety_stops: number;
  machine_stops: number;
  machine_alarms: number;
  units_held: number;
  events: number;
}

export interface ControlFeedItem {
  ts: string;
  kind: 'station' | 'inspection' | 'machine' | 'unit';
  event_type: string;
  source: string;
  unit_id: string | null;
  machine_id: string | null;
  product_id: string | null;
  station: string | null;
  step: number | null;
  status: string | null;
  detail: Record<string, unknown>;
}

export interface ControlSummary {
  hours: number;
  by_source: Record<string, ControlSourceKpis>;
  last_event_at: string | null;
  feed: ControlFeedItem[];
}

export interface OrderStatus {
  order_id: string;
  name: string;
  quantity: number;
  due_at: string;
  made: number;
  rate_per_hour: number | null;
  first_pass_rate: number | null;
  machines: {
    machine_id: string;
    name: string;
    state: string | null;
    last_alarm: string | null;
    made: number;
    rate_per_hour: number | null;
    ideal_rate_per_hour: number | null;
  }[];
  source: string;
  hours_left: number;
  good_made: number;
  projected_good: number | null;
  shortfall: number | null;
  on_track: boolean | null;
  rate_needed_per_hour: number | null;
}

export interface DemandResult {
  report: {
    summary: string;
    orders: { order_id: string; verdict: string; main_constraint: string | null }[];
    actions: { action: string; reason: string; expected_extra_units: number | null }[];
    confidence: string;
  };
  orders: OrderStatus[];
  agent_steps: { agent: string; tool: string; args: Record<string, unknown> }[];
}

export async function fetchOrders(): Promise<OrderStatus[]> {
  return await apiFetch<OrderStatus[]>('/api/orders');
}

export async function createOrder(order: { name: string; quantity: number; due_at: string; machine_ids: string[]; product_id?: string }): Promise<{ id: string }> {
  return await apiFetch('/api/orders', { method: 'POST', body: JSON.stringify(order) });
}

export async function closeOrder(id: string): Promise<{ id: string; status: string }> {
  return await apiFetch(`/api/orders/${encodeURIComponent(id)}/close`, { method: 'POST' });
}

export interface WorkOrderDraft {
  title: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  summary: string;
  likely_causes: { cause: string; evidence: string }[];
  steps: string[];
  safety: string[];
  parts: string[];
  estimated_minutes: number | null;
  repeat_issue: boolean;
  operator_alert: string;
}

export interface WorkOrder {
  id: string;
  machine_id: string;
  machine_name: string | null;
  alarm_text: string | null;
  source: string;
  status: 'draft' | 'approved' | 'dismissed';
  draft: WorkOrderDraft;
  agent_steps: { agent: string; tool: string; args: Record<string, unknown> }[];
  created_at: string;
  agent_ms?: number;
  existing?: boolean;
  decision_note?: string | null;
}

export type SpeechLanguage = 'en' | 'ja' | 'vi' | 'hi' | 'id' | 'fil';

export async function draftWorkOrder(machineId: string): Promise<WorkOrder> {
  return await apiFetch<WorkOrder>('/forge/agents/maintenance', { method: 'POST', body: JSON.stringify({ machine_id: machineId }) });
}

export async function fetchWorkOrders(): Promise<WorkOrder[]> {
  return await apiFetch<WorkOrder[]>('/api/work-orders');
}

export async function decideWorkOrder(id: string, decision: 'approve' | 'dismiss', note?: string): Promise<{ id: string; status: string }> {
  return await apiFetch(`/api/work-orders/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    body: JSON.stringify(note ? { decision, note } : { decision }),
  });
}

/** Fetches the spoken operator alert (WAV) and the text that was spoken. */
export async function speakWorkOrder(id: string, language: SpeechLanguage): Promise<{ audio: Blob; text: string }> {
  const token = await getIdToken();
  const res = await fetch(`/api/work-orders/${encodeURIComponent(id)}/speak`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ language }),
  });
  if (!res.ok) throw new ApiError('Could not make the spoken alert', res.status);
  const b64 = res.headers.get('X-Spoken-Text-B64') || '';
  const text = b64 ? new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))) : '';
  return { audio: await res.blob(), text };
}

export async function runDemandAgent(): Promise<DemandResult> {
  return await apiFetch<DemandResult>('/forge/agents/demand', { method: 'POST' });
}

export async function fetchControlSummary(hours = 24): Promise<ControlSummary> {
  return await apiFetch<ControlSummary>(`/api/control/summary?hours=${hours}`);
}

export async function fetchMySoakRuns(): Promise<SoakRun[]> {
  return await apiFetch<SoakRun[]>('/api/soak/mine');
}

export interface MachineDaySummary {
  id: string;
  name: string;
  bench_slot?: number | null;
  state: string | null;
  last_alarm: string | null;
  last_count: number | null;
  last_seen_at: string | null;
  segments: { state: string; start: string; end: string }[];
  running_s: number;
  idle_s: number;
  stopped_s: number;
  availability: number | null;
  performance: number | null;
  stops: number;
  parts: number;
  top_alarms: { alarm_text: string; count: number }[];
  source: string | null;
  events: number;
}

export async function fetchMachinesSummary(day?: string): Promise<{
  day: string;
  window_end: string;
  machines: MachineDaySummary[];
}> {
  const query = day ? `?day=${encodeURIComponent(day)}` : '';
  return await apiFetch(`/api/machines/summary${query}`);
}

export async function fetchMachines(): Promise<Machine[]> {
  return await apiFetch<Machine[]>('/api/machines');
}

export async function removeMachine(id: string): Promise<{ id: string; archived: boolean }> {
  return await apiFetch(`/api/machines/${encodeURIComponent(id)}/remove`, { method: 'POST' });
}

export async function setupMachine(
  image_b64: string,
  position: { machine_count: number; machine_index: number } = { machine_count: 1, machine_index: 1 }
): Promise<{
  rois: {
    stack_light: NormalizedRoi;
    counter?: NormalizedRoi | null;
    hmi?: NormalizedRoi | null;
  };
}> {
  return await apiFetch('/api/machines/setup', {
    method: 'POST',
    body: JSON.stringify({ image_b64, ...position }),
  });
}

export async function createMachine(machine: {
  name: string;
  light_order?: string[];
  state_map?: Record<string, string>;
  rois: {
    stack_light: NormalizedRoi;
    counter?: NormalizedRoi | null;
    hmi?: NormalizedRoi | null;
  };
  ideal_cycle_s?: number;
  source?: 'LIVE' | 'VIRTUAL';
  bench_slot?: number | null;
}): Promise<Machine> {
  return await apiFetch<Machine>('/api/machines', {
    method: 'POST',
    body: JSON.stringify(machine),
  });
}

export async function readMachine(
  id: string,
  params: {
    crops: {
      stack_light_b64?: string;
      counter_b64?: string;
      hmi_b64?: string;
    };
    video_run_s?: number;
    soak_run_id?: string;
    detected_by?: 'edge' | 'gemini';
    reason?: 'change' | 'heartbeat';
  }
): Promise<{
  state: string | null;
  light: string | null;
  count: number | null;
  alarm_text: string | null;
  alarm_code: string | null;
  changed: boolean;
  ms: number;
}> {
  return await apiFetch(`/api/machines/${encodeURIComponent(id)}/read`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}




