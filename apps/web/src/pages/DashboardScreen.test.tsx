import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardScreen } from './DashboardScreen';
import * as apiModule from '../lib/api';
import type {
  InsightSkill,
  SkillInsightsResponse,
  SessionReplayResponse,
} from '../lib/api';

// Mock Firebase & Firestore
vi.mock('../lib/firebase', () => ({
  db: {},
  auth: { currentUser: null },
}));

// Mock APIs
vi.mock('../lib/api', () => ({
  fetchInsightSkills: vi.fn(),
  fetchSkillInsights: vi.fn(),
  fetchSessionReplay: vi.fn(),
  fetchInspectionInsights: vi.fn().mockResolvedValue({
    live: { today_count: 0, first_pass_rate: null, top_defect_types: [], flagged_awaiting_count: 0, recent: [] },
    gallery: { trials_count: 0, hits_count: 0, hit_rate: null, dataset: 'VisA' },
  }),
  fetchUnits: vi.fn().mockResolvedValue([]),
  fetchMachinesSummary: vi.fn().mockResolvedValue([]),
}));

// Mock Translation and Theme providers
vi.mock('../i18n', () => {
  const useTranslation = () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params?.n !== undefined && params?.total !== undefined) {
        return `Step ${params.n} of ${params.total}`;
      }
      if (key === 'app.dashboard_seconds') {
        return `${params?.value}s`;
      }
      return key;
    },
    language: 'en',
    setLanguage: vi.fn(),
  });
  return {
    useTranslation,
    useI18n: useTranslation,
    SUPPORTED_LANGUAGES: [{ code: 'en', label: 'English', native: 'English' }],
  };
});

vi.mock('../lib/theme', () => ({
  useTheme: () => ({
    theme: 'dark',
    toggleTheme: vi.fn(),
  }),
}));

// Mock Firestore onSnapshot for LiveNowStrip & RecentSessions
vi.mock('firebase/firestore', () => {
  return {
    getFirestore: vi.fn(),
    collection: vi.fn(),
    query: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    onSnapshot: vi.fn((_q, callback) => {
      // Emit a mock live session (started 2 minutes ago) and an expired one (15 minutes ago)
      const now = Date.now();
      callback({
        docs: [
          {
            id: 'ses_live_active',
            data: () => ({
              id: 'ses_live_active',
              trainee_uid: 'uid_alice_123',
              skill_id: 'skill_wiring_1',
              status: 'live',
              current_step: 2,
              started_at: new Date(now - 2 * 60 * 1000).toISOString(),
              language: 'en',
              steps: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }],
            }),
          },
          {
            id: 'ses_live_stale',
            data: () => ({
              id: 'ses_live_stale',
              trainee_uid: 'uid_bob_456',
              skill_id: 'skill_wiring_1',
              status: 'live',
              current_step: 1,
              started_at: new Date(now - 20 * 60 * 1000).toISOString(), // > 12m: STALE
              language: 'en',
              steps: [{ n: 1 }],
            }),
          },
          {
            id: 'ses_live_smoke',
            data: () => ({
              id: 'ses_live_smoke',
              trainee_uid: 'smoke-trainee', // EXCLUDED
              skill_id: 'skill_wiring_1',
              status: 'live',
              current_step: 1,
              started_at: new Date(now - 1 * 60 * 1000).toISOString(),
              language: 'en',
            }),
          },
        ],
      });
      return () => {};
    }),
  };
});

const mockSkills: InsightSkill[] = [
  { id: 'skill_wiring_1', title: 'Wire a DIN-rail terminal' },
  { id: 'skill_switch_2', title: 'Assemble industrial switch' },
];

const mockSkillInsights: SkillInsightsResponse = {
  steps: [
    {
      n: 1,
      instruction: 'Strip blue wire to 8mm',
      sessions_reached: 10,
      mistake_rate: 0.1,
      median_secs: 14.2,
      safety_stops: 0,
    },
    {
      n: 2,
      instruction: 'Insert wire into terminal 1',
      sessions_reached: 8,
      mistake_rate: 0.62, // Struggle step
      median_secs: 35.5,
      safety_stops: 2,
    },
    {
      n: 3,
      instruction: 'Tighten screw to 0.5 Nm',
      sessions_reached: 0, // Unreached step
      mistake_rate: null,
      median_secs: null,
      safety_stops: null,
    },
  ],
  totals: {
    sessions: 10,
    completed: 5,
    median_duration_s: 58.0,
  },
};

const mockReplayData: SessionReplayResponse = {
  session: {
    id: 'ses_live_active',
    skill_id: 'skill_wiring_1',
    status: 'live',
    started_at: '2026-10-06T10:00:00Z',
    language: 'en',
  },
  events: [
    {
      t: '2026-10-06T10:00:15Z',
      step: 1,
      type: 'coach_line',
      source: 'coach',
      reason: 'Welcome. Let us start step 1.',
    },
    {
      t: '2026-10-06T10:00:30Z',
      step: 1,
      type: 'trainee_line',
      source: 'trainee',
      reason: 'I am holding the wire stripper.',
    },
    {
      t: '2026-10-06T10:00:45Z',
      step: 1,
      type: 'step_done',
      source: 'watcher',
      reason: 'Wire stripped to correct length.',
      latency_ms: 120,
    },
    {
      t: '2026-10-06T10:01:10Z',
      step: 2,
      type: 'safety_stop',
      source: 'watcher',
      reason: 'Hand too close to live terminal.',
      latency_ms: 95,
      frame_uri: 'https://storage.googleapis.com/test-bucket/frame.jpg?signed=1',
    },
  ],
};

describe('DashboardScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiModule.fetchInsightSkills).mockResolvedValue({ skills: mockSkills });
    vi.mocked(apiModule.fetchSkillInsights).mockResolvedValue(mockSkillInsights);
    vi.mocked(apiModule.fetchSessionReplay).mockResolvedValue(mockReplayData);
  });

  it('renders dashboard with Live Now strip filtering out stale and smoke sessions', async () => {
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>
    );

    // Header title
    expect(screen.getByText('dashboard_title')).toBeInTheDocument();

    // Live Now strip rendered
    expect(screen.getByText('dashboard_live_now')).toBeInTheDocument();

    // Active session shown by an anonymous operator id, never a name
    await waitFor(() => {
      expect(screen.getAllByText('app.dashboard_trainee_short_id').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Step 2 of 4')).toBeInTheDocument();
    });

    // Stale session (Bob >12m ago) and smoke-trainee must NOT appear in live strip
    expect(screen.queryByText('smoke-trainee')).not.toBeInTheDocument();
  });

  it('opens on end-of-line quality and no longer ranks individual workers', async () => {
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>
    );

    const tabs = await screen.findAllByRole('tab');
    expect(tabs[0]).toHaveTextContent('dashboard_tab_quality');
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    expect(document.body.textContent).not.toContain('Alice');

    // Privacy verification: no email domains in document
    expect(document.body.textContent).not.toContain('@example.com');
  });

  it('switches to Lesson Heatmap tab and displays step metrics, nulls as dash, and struggle badge', async () => {
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getAllByText('app.dashboard_trainee_short_id').length).toBeGreaterThanOrEqual(1);
    });

    // Click heatmap tab
    const heatmapTab = screen.getByText('dashboard_lesson_insights');
    fireEvent.click(heatmapTab);

    // Heatmap steps rendered
    await waitFor(() => {
      expect(screen.getByText('Strip blue wire to 8mm')).toBeInTheDocument();
      expect(screen.getByText('Insert wire into terminal 1')).toBeInTheDocument();
      expect(screen.getByText('Tighten screw to 0.5 Nm')).toBeInTheDocument();
    });

    // Step 2 struggle badge
    expect(screen.getByText('dashboard_struggle_step')).toBeInTheDocument();

    // Step 3 was never reached: displays dash "—" with "No data yet" title
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
    expect(dashes[0]).toHaveAttribute('title', 'dashboard_no_data');

    // Totals
    expect(screen.getByText('10')).toBeInTheDocument(); // total sessions
    expect(screen.getByText('50%')).toBeInTheDocument(); // completion rate
    expect(screen.getByText('58s')).toBeInTheDocument(); // median duration
  });

  it('clicking a live session card opens Replay tab with events, chat bubbles, and frame', async () => {
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getAllByText('app.dashboard_trainee_short_id').length).toBeGreaterThanOrEqual(1);
    });

    // Click on the live session card
    const card = screen.getByText('Step 2 of 4');
    fireEvent.click(card);

    // Switches to replay tab
    await waitFor(() => {
      expect(apiModule.fetchSessionReplay).toHaveBeenCalledWith('ses_live_active');
      expect(screen.getByText('Welcome. Let us start step 1.')).toBeInTheDocument();
      expect(screen.getByText('I am holding the wire stripper.')).toBeInTheDocument();
      expect(screen.getByText('Hand too close to live terminal.')).toBeInTheDocument();
    });

    // Image frame rendered
    const img = screen.getByAltText('app.replay_frame_alt');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute(
      'src',
      'https://storage.googleapis.com/test-bucket/frame.jpg?signed=1'
    );
  });
});
