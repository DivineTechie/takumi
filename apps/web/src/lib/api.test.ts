import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  apiFetch,
  NotSignedInError,
  ApiError,
  watch,
  verify,
  point,
  getMe,
  createSession,
  type WatchResponse,
  type VerifyResponse,
  type PointResponse,
  type MeResponse,
} from './api';
import type { Session } from '../../../../shared/schema/ts/sessions';
import * as firebaseModule from './firebase';

describe('apiFetch & api module', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('throws NotSignedInError when auth.currentUser is null', async () => {
    // @ts-expect-error Mocking currentUser
    firebaseModule.auth.currentUser = null;

    await expect(apiFetch('/api/test')).rejects.toThrow(NotSignedInError);
  });

  it('handles 401 by throwing ApiError(401) without hard-redirecting', async () => {
    // @ts-expect-error Mocking currentUser
    firebaseModule.auth.currentUser = {
      getIdToken: vi.fn().mockResolvedValue('fake-token'),
    };

    const initialHref = window.location.href;

    global.fetch = vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
      statusText: 'Unauthorized',
      text: vi.fn().mockResolvedValue('Unauthorized'),
    });

    await expect(apiFetch('/api/test')).rejects.toThrow(ApiError);
    await expect(apiFetch('/api/test')).rejects.toMatchObject({
      status: 401,
      message: 'Unauthorized',
    });
    // Verify window.location was not modified
    expect(window.location.href).toBe(initialHref);
  });

  it('handles 429 by throwing ApiError with "Daily limit reached"', async () => {
    // @ts-expect-error Mocking currentUser
    firebaseModule.auth.currentUser = {
      getIdToken: vi.fn().mockResolvedValue('fake-token'),
    };

    global.fetch = vi.fn().mockResolvedValue({
      status: 429,
      ok: false,
      statusText: 'Too Many Requests',
      text: vi.fn().mockResolvedValue('Too Many Requests'),
    });

    await expect(apiFetch('/api/test')).rejects.toThrow(ApiError);
    await expect(apiFetch('/api/test')).rejects.toMatchObject({
      status: 429,
      message: 'Daily limit reached',
    });
  });

  it('successfully returns json on 200 response with Bearer token', async () => {
    // @ts-expect-error Mocking currentUser
    firebaseModule.auth.currentUser = {
      getIdToken: vi.fn().mockResolvedValue('valid-token-123'),
    };

    const mockData = { status: 'ok', data: 42 };
    let capturedHeaders: Headers | undefined;

    global.fetch = vi.fn().mockImplementation((_url, init) => {
      capturedHeaders = init?.headers as Headers;
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve(mockData),
      });
    });

    const result = await apiFetch<typeof mockData>('/api/test');
    expect(result).toEqual(mockData);
    expect(capturedHeaders?.get('Authorization')).toBe('Bearer valid-token-123');
  });

  describe('Sample endpoint JSON responses type validation', () => {
    beforeEach(() => {
      // @ts-expect-error Mocking currentUser
      firebaseModule.auth.currentUser = {
        getIdToken: vi.fn().mockResolvedValue('valid-token-123'),
      };
    });

    it('matches WatchResponse schema', async () => {
      const sampleWatch: WatchResponse = {
        state: 'in_progress',
        reason: 'Inserting blue wire into terminal 1',
        fix: 'Push fully into terminal opening',
        secs: 1.25,
      };

      global.fetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: () => Promise.resolve(sampleWatch),
      });

      const res = await watch({
        step: 1,
        instruction: 'Insert blue wire',
        success_criteria: 'A blue wire enters terminal 1',
        image_b64: 'fakeb64',
      });

      expect(res.state).toBe('in_progress');
      expect(typeof res.reason).toBe('string');
      expect(typeof res.fix).toBe('string');
      expect(typeof res.secs).toBe('number');
    });

    it('matches VerifyResponse schema with visible and fix fields', async () => {
      const sampleVerify: VerifyResponse = {
        passed: true,
        visible: true,
        reason: 'A blue wire ferrule enters terminal 1 correctly.',
        fix: '',
        secs: 2.45,
      };

      global.fetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: () => Promise.resolve(sampleVerify),
      });

      const res = await verify({
        step: 1,
        instruction: 'Insert blue wire',
        success_criteria: 'A blue wire enters terminal 1',
        image_b64: 'fakeb64',
      });

      expect(res.passed).toBe(true);
      expect(res.visible).toBe(true);
      expect(typeof res.reason).toBe('string');
      expect(typeof res.fix).toBe('string');
      expect(typeof res.secs).toBe('number');
    });

    it('matches PointResponse schema with points array', async () => {
      const samplePoint: PointResponse = {
        points: [
          { point: [250, 480], label: 'screw opening of terminal 1' },
          { point: [300, 500], label: 'terminal 1 slot' },
        ],
        secs: 0.95,
      };

      global.fetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: () => Promise.resolve(samplePoint),
      });

      const res = await point({
        target: 'the screw opening of terminal 1',
        image_b64: 'fakeb64',
      });

      expect(Array.isArray(res.points)).toBe(true);
      expect(res.points.length).toBe(2);
      expect(res.points[0].point).toEqual([250, 480]);
      expect(res.points[0].label).toBe('screw opening of terminal 1');
      expect(typeof res.secs).toBe('number');
    });

    it('matches MeResponse schema with role_assigned boolean', async () => {
      const sampleMe: MeResponse = {
        uid: 'user_trainee_123',
        role: 'trainee',
        display_name: 'Alex Johnson',
        role_assigned: true,
      };

      global.fetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: () => Promise.resolve(sampleMe),
      });

      const res = await getMe();

      expect(res.uid).toBe('user_trainee_123');
      expect(res.role).toBe('trainee');
      expect(res.display_name).toBe('Alex Johnson');
      expect(res.role_assigned).toBe(true);
    });

    it('matches CreateSession schema from /shared/schema/ts', async () => {
      const sampleSession: Session = {
        id: 'ses_123456789abcdef0',
        skill_id: 'seed-wire-din-rail',
        trainee_uid: 'user_trainee_123',
        language: 'en',
        status: 'live',
        started_at: '2026-10-05T12:00:00Z',
        ended_at: null,
        steps: [
          { n: 1, state: 'pending', attempts: 0, mistakes: 0, secs: 0 },
          { n: 2, state: 'pending', attempts: 0, mistakes: 0, secs: 0 },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        status: 201,
        ok: true,
        json: () => Promise.resolve(sampleSession),
      });

      const res = await createSession({
        skill_id: 'seed-wire-din-rail',
        language: 'en',
      });

      expect(res.id).toBe('ses_123456789abcdef0');
      expect(res.status).toBe('live');
      expect(res.steps.length).toBe(2);
      expect(res.steps[0].state).toBe('pending');
    });
  });
});
