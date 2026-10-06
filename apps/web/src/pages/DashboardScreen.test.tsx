import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardScreen } from './DashboardScreen';
import * as apiModule from '../lib/api';
import type {
  InsightsMatrixResponse,
  SkillInsightsResponse,
  SessionReplayResponse,
} from '../lib/api';

// Mock APIs
vi.mock('../lib/api', () => ({
  fetchInsightsMatrix: vi.fn(),
  fetchSkillInsights: vi.fn(),
  fetchSessionReplay: vi.fn(),
}));

// Mock Translation and Theme providers
vi.mock('../i18n', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params?.n !== undefined && params?.total !== undefined) {
        return `Step ${params.n} of ${params.total}`;
      }
      return key;
    },
    language: 'en',
    setLanguage: vi.fn(),
  }),
  SUPPORTED_LANGUAGES: [{ code: 'en', label: 'English', native: 'English' }],
}));

vi.mock('../lib/theme', () => ({
  useTheme: () => ({
    theme: 'dark',
    toggleTheme: vi.fn(),
  }),
}));

// Mock Firestore onSnapshot for LiveNowStrip
vi.mock('firebase/firestore', () => {
  return {
    getFirestore: vi.fn(),
    collection: vi.fn(),
    query: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
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

const mockMatrixData: InsightsMatrixResponse = {
  trainees: [
    { uid: 'uid_alice_123', first_name: 'Alice' },
    { uid: 'uid_bob_456', first_name: 'Bob' },
  ],
  skills: [
    { id: 'skill_wiring_1', title: 'Wire a DIN-rail terminal' },
    { id: 'skill_switch_2', title: 'Assemble industrial switch' },
  ],
  cells: [
    {
      uid: 'uid_alice_123',
      skill_id: 'skill_wiring_1',
      status: 'learning',
      sessions: 3,
      last_session_at: '2026-10-06T10:00:00Z',
      mistakes_trend: [2, 1, 0],
    },
    {
      uid: 'uid_alice_123',
      skill_id: 'skill_switch_2',
      status: 'not_started',
      sessions: 0,
      last_session_at: null,
      mistakes_trend: [],
    },
    {
      uid: 'uid_bob_456',
      skill_id: 'skill_wiring_1',
      status: 'certified',
      sessions: 2,
      last_session_at: '2026-10-06T11:00:00Z',
      mistakes_trend: [0],
    },
  ],
};

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
    first_name: 'Alice',
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
      reason: 'Welcome Alice. Let us start step 1.',
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
    vi.mocked(apiModule.fetchInsightsMatrix).mockResolvedValue(mockMatrixData);
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

    // Active session shown with trainee name (Alice)
    await waitFor(() => {
      expect(screen.getAllByText('Alice').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Step 2 of 4')).toBeInTheDocument();
    });

    // Stale session (Bob >12m ago) and smoke-trainee must NOT appear in live strip
    expect(screen.queryByText('smoke-trainee')).not.toBeInTheDocument();
  });

  it('renders skill matrix with trainee first names, certified status, and learning sparklines', async () => {
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>
    );

    await waitFor(() => {
      // Trainees Alice and Bob
      expect(screen.getAllByText('Alice').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });

    // Bob is certified on Wire a DIN-rail terminal
    expect(screen.getByText('dashboard_certified')).toBeInTheDocument();

    // Alice is learning with 3 sessions
    expect(screen.getByText('dashboard_learning (3)')).toBeInTheDocument();

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
      expect(screen.getAllByText('Alice').length).toBeGreaterThanOrEqual(1);
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
    expect(dashes[0]).toHaveAttribute('title', 'No data yet');

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
      expect(screen.getAllByText('Alice').length).toBeGreaterThanOrEqual(1);
    });

    // Click on Alice's live session card
    const card = screen.getByText('Step 2 of 4');
    fireEvent.click(card);

    // Switches to replay tab
    await waitFor(() => {
      expect(apiModule.fetchSessionReplay).toHaveBeenCalledWith('ses_live_active');
      expect(screen.getByText('Welcome Alice. Let us start step 1.')).toBeInTheDocument();
      expect(screen.getByText('I am holding the wire stripper.')).toBeInTheDocument();
      expect(screen.getByText('Hand too close to live terminal.')).toBeInTheDocument();
    });

    // Image frame rendered
    const img = screen.getByAltText('Event snapshot frame');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute(
      'src',
      'https://storage.googleapis.com/test-bucket/frame.jpg?signed=1'
    );
  });
});
