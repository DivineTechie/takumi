import { auth } from './firebase';

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

/**
 * Returns a valid Firebase ID token if a user is signed in,
 * or a development mock token if in local development mode.
 */
export async function getIdToken(): Promise<string> {
  const currentUser = auth.currentUser;
  if (currentUser) {
    try {
      return await currentUser.getIdToken();
    } catch (err) {
      console.warn('Failed to retrieve Firebase ID token:', err);
    }
  }

  // Development fallback for local testing when unauthenticated
  const devToken = localStorage.getItem('takumi_dev_token') || 'dev_mock_master_token';
  return devToken;
}

/**
 * Fetches a single-use Gemini Live token from Member A's API endpoint.
 * POST /api/live-token
 */
export async function fetchLiveToken(
  purpose: 'interview' | 'coach' = 'interview'
): Promise<LiveTokenResponse> {
  const token = await getIdToken();
  const res = await fetch('/api/live-token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ purpose }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch live token (${res.status}): ${errorText}`);
  }

  return (await res.json()) as LiveTokenResponse;
}

/**
 * Dispatches a Forge job to process a completed capture.
 * POST /forge/jobs
 */
export async function triggerForgeJob(captureId: string): Promise<ForgeJobResponse> {
  const token = await getIdToken();
  const res = await fetch('/forge/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ capture_id: captureId }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to trigger Forge job (${res.status}): ${errorText}`);
  }

  return (await res.json()) as ForgeJobResponse;
}

/**
 * Retrieves the status of a running or completed Forge job.
 * GET /forge/jobs/{job_id}
 */
export async function fetchForgeJob(jobId: string): Promise<ForgeJobStatus> {
  const token = await getIdToken();
  const res = await fetch(`/forge/jobs/${jobId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Forge job ${jobId}: ${res.statusText}`);
  }

  return (await res.json()) as ForgeJobStatus;
}

/**
 * Requests regeneration of a specific step part in Master Review.
 * POST /forge/steps/regenerate
 */
export async function regenerateStepPart(
  skillId: string,
  n: number,
  part: string
): Promise<{ success: boolean; message?: string }> {
  const token = await getIdToken();
  const res = await fetch('/forge/steps/regenerate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ skill_id: skillId, n, part }),
  });

  if (!res.ok) {
    throw new Error(`Failed to regenerate step part: ${res.statusText}`);
  }

  return (await res.json()) as { success: boolean; message?: string };
}
