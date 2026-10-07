import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useTranslation, SUPPORTED_LANGUAGES, type LanguageCode } from '../i18n';
import { useTheme } from '../lib/theme';
import logoSvg from '../assets/logo.svg';
import {
  fetchInsightsMatrix,
  fetchSkillInsights,
  fetchSessionReplay,
  type InsightsMatrixResponse,
  type SkillInsightsResponse,
  type SessionReplayResponse,
  type MatrixSkill,
} from '../lib/api';
import { LiveNowStrip } from '../components/dashboard/LiveNowStrip';
import { SkillMatrixTable } from '../components/dashboard/SkillMatrixTable';
import { LessonHeatmap } from '../components/dashboard/LessonHeatmap';
import {
  SessionReplayViewer,
  type RecentSessionItem,
} from '../components/dashboard/SessionReplayViewer';

type DashboardTab = 'matrix' | 'heatmap' | 'replay';

export const DashboardScreen: React.FC = () => {
  const { t, language, setLanguage } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<DashboardTab>('matrix');
  const [matrixData, setMatrixData] = useState<InsightsMatrixResponse | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(true);
  const [matrixError, setMatrixError] = useState<string | null>(null);

  const [selectedSkillId, setSelectedSkillId] = useState<string>('');
  const [skillInsights, setSkillInsights] = useState<SkillInsightsResponse | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [replayData, setReplayData] = useState<SessionReplayResponse | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [firestoreSessions, setFirestoreSessions] = useState<RecentSessionItem[]>([]);

  // Real-time recent sessions from Firestore
  useEffect(() => {
    const q = query(
      collection(db, 'sessions'),
      orderBy('started_at', 'desc'),
      limit(10)
    );
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list: RecentSessionItem[] = snapshot.docs
          .map((d) => {
            const data = d.data();
            return {
              id: d.id,
              skill_id: data.skill_id,
              trainee_uid: data.trainee_uid,
              status: data.status,
              started_at: data.started_at,
              language: data.language,
              mistakes: data.result?.mistakes,
            };
          })
          .filter((s) => s.trainee_uid !== 'smoke-trainee');
        setFirestoreSessions(list);
      },
      (err) => {
        console.warn('Recent sessions snapshot error:', err);
      }
    );
    return () => unsubscribe();
  }, []);

  // Load team matrix
  const loadMatrix = useCallback(async () => {
    setMatrixLoading(true);
    setMatrixError(null);
    try {
      const data = await fetchInsightsMatrix();
      setMatrixData(data);
      if (data.skills.length > 0) {
        setSelectedSkillId((prev) => prev || data.skills[0].id);
      }
    } catch (err) {
      console.error('Failed to load matrix:', err);
      setMatrixError(t('dashboard_load_failed'));
    } finally {
      setMatrixLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadMatrix();
  }, [loadMatrix]);

  // Load skill insights when selected skill changes
  useEffect(() => {
    if (!selectedSkillId) return;

    let isCurrent = true;
    setInsightsLoading(true);
    fetchSkillInsights(selectedSkillId)
      .then((res) => {
        if (isCurrent) setSkillInsights(res);
      })
      .catch((err) => {
        console.error('Failed to load skill insights:', err);
        if (isCurrent) setSkillInsights(null);
      })
      .finally(() => {
        if (isCurrent) setInsightsLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [selectedSkillId]);

  // Load session replay when selectedSessionId changes
  const handleSelectSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    setActiveTab('replay');
    setReplayLoading(true);
    fetchSessionReplay(sessionId)
      .then((res) => setReplayData(res))
      .catch((err) => {
        console.error('Failed to load session replay:', err);
        setReplayData(null);
      })
      .finally(() => setReplayLoading(false));
  }, []);

  // When a matrix cell is clicked, switch to heatmap for that skill
  const handleSelectMatrixCell = useCallback((_traineeUid: string, skillId: string) => {
    setSelectedSkillId(skillId);
    setActiveTab('heatmap');
  }, []);

  const skillsMap = useMemo(() => {
    const map: Record<string, MatrixSkill> = {};
    matrixData?.skills.forEach((s) => {
      map[s.id] = s;
    });
    return map;
  }, [matrixData?.skills]);

  const traineesMap = useMemo(() => {
    const map: Record<string, string> = {};
    matrixData?.trainees.forEach((tr) => {
      map[tr.uid] = tr.first_name;
    });
    return map;
  }, [matrixData?.trainees]);

  const recentSessionsList = useMemo(() => {
    if (firestoreSessions.length > 0) return firestoreSessions;
    const fallback: RecentSessionItem[] = [];
    matrixData?.cells.forEach((cell) => {
      if (cell.sessions > 0 && cell.last_session_at) {
        fallback.push({
          id: 'ses_1f136365e52d71cd',
          skill_id: cell.skill_id,
          trainee_uid: cell.uid,
          first_name: traineesMap[cell.uid],
          status: 'completed',
          started_at: cell.last_session_at,
          language: 'hi',
          mistakes: cell.mistakes_trend?.[cell.mistakes_trend.length - 1] || 0,
        });
      }
    });
    return fallback;
  }, [firestoreSessions, matrixData, traineesMap]);

  return (
    <div className="bg-background text-on-surface font-body-md min-h-screen antialiased flex flex-col justify-between selection:bg-primary-container selection:text-on-primary-container">
      {/* Top Header */}
      <header className="w-full bg-surface-container-low min-h-[64px] flex items-center justify-between px-3 sm:px-6 sticky top-0 z-40 border-b border-outline-variant shadow-sm gap-2">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <button
            onClick={() => navigate('/')}
            aria-label={t('back')}
            className="w-10 h-10 sm:w-11 sm:h-11 flex items-center justify-center rounded-xl text-on-surface hover:bg-surface-container-high active:scale-95 transition-transform cursor-pointer shrink-0"
            type="button"
          >
            <span className="material-symbols-outlined text-[22px] sm:text-[24px]">arrow_back</span>
          </button>
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
            <img
              src={logoSvg}
              alt="TAKUMI Logo"
              className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg shrink-0 object-contain shadow-sm"
              width={28}
              height={28}
            />
            <h1 className="text-[17px] sm:text-[20px] font-bold text-on-surface tracking-tight truncate whitespace-nowrap">
              <span className="hidden md:inline">{t('dashboard_title')}</span>
              <span className="md:hidden">Dashboard</span>
            </h1>
          </div>
        </div>

        {/* Header Right Actions */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {/* Refresh button */}
          <button
            onClick={() => loadMatrix()}
            disabled={matrixLoading}
            aria-label="Refresh dashboard data"
            className="w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center rounded-xl bg-surface-container hover:bg-surface-container-high text-on-surface border border-outline-variant transition-colors cursor-pointer disabled:opacity-50 shrink-0"
            type="button"
          >
            <span className={`material-symbols-outlined text-[19px] sm:text-[20px] ${matrixLoading ? 'animate-spin' : ''}`}>
              refresh
            </span>
          </button>

          {/* Language selector: collapses to globe + 2-letter code on mobile (<768px) */}
          <div className="relative flex items-center bg-surface-container border border-outline-variant rounded-xl h-9 sm:h-10 px-2 sm:px-3 focus-within:ring-1 focus-within:ring-primary-container cursor-pointer shrink-0">
            <span className="material-symbols-outlined pointer-events-none text-on-surface-variant text-[17px] sm:text-[18px] mr-1 sm:mr-1.5 shrink-0">
              language
            </span>
            <span className="text-[13px] font-bold text-on-surface md:hidden pointer-events-none uppercase">
              {language.slice(0, 2)}
            </span>
            <span className="text-[14px] font-medium text-on-surface hidden md:inline pointer-events-none max-w-[90px] truncate">
              {SUPPORTED_LANGUAGES.find((l) => l.code === language)?.native || language}
            </span>
            <span className="material-symbols-outlined pointer-events-none text-on-surface-variant text-[16px] ml-0.5 sm:ml-1 shrink-0">
              arrow_drop_down
            </span>
            <select
              id="dashboard-lang-select"
              aria-label="Select language"
              value={language}
              onChange={(e) => setLanguage(e.target.value as LanguageCode)}
              className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.native} ({lang.code.toUpperCase()})
                </option>
              ))}
            </select>
          </div>

          {/* Theme toggle: always visible */}
          <button
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? t('light_mode') : t('dark_mode')}
            className="w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center rounded-xl bg-surface-container hover:bg-surface-container-high text-on-surface border border-outline-variant transition-colors cursor-pointer shrink-0"
            type="button"
          >
            <span className="material-symbols-outlined text-[19px] sm:text-[20px]">
              {theme === 'dark' ? 'light_mode' : 'dark_mode'}
            </span>
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-5 sm:py-6 space-y-6">
        {/* Error State Banner */}
        {matrixError && (
          <div className="bg-error/15 border border-error/30 rounded-2xl p-4 flex items-center justify-between gap-3 text-error">
            <div className="flex items-center gap-2.5">
              <span className="material-symbols-outlined text-[22px]">error</span>
              <span className="text-[14px] font-semibold">{matrixError}</span>
            </div>
            <button
              onClick={() => loadMatrix()}
              className="px-4 py-2 rounded-xl bg-error text-white font-bold text-[13px] hover:opacity-90 transition-opacity cursor-pointer shrink-0"
            >
              {t('dashboard_retry')}
            </button>
          </div>
        )}

        {/* Live Now Strip (Always visible at top of dashboard) */}
        <LiveNowStrip
          skillsMap={skillsMap}
          traineesMap={traineesMap}
          onSelectSession={handleSelectSession}
        />

        {/* Tabs Bar: Grid on mobile (no horizontal scroll), flex on desktop */}
        <div
          role="tablist"
          aria-label="Dashboard sections"
          className="grid grid-cols-3 sm:flex items-center gap-1.5 sm:gap-2 bg-surface-container-low p-1.5 rounded-2xl border border-outline-variant w-full sm:w-fit"
        >
          <button
            role="tab"
            aria-selected={activeTab === 'matrix'}
            onClick={() => setActiveTab('matrix')}
            className={`min-h-[44px] px-2 sm:px-5 py-2 rounded-xl text-[13px] sm:text-[15px] flex items-center justify-center gap-1.5 sm:gap-2 transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'matrix'
                ? 'bg-primary-container text-on-primary-container font-bold shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container font-medium bg-transparent'
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">group</span>
            <span className="hidden sm:inline">{t('dashboard_team_matrix')}</span>
            <span className="sm:hidden">{t('dashboard_tab_matrix_short')}</span>
          </button>

          <button
            role="tab"
            aria-selected={activeTab === 'heatmap'}
            onClick={() => setActiveTab('heatmap')}
            className={`min-h-[44px] px-2 sm:px-5 py-2 rounded-xl text-[13px] sm:text-[15px] flex items-center justify-center gap-1.5 sm:gap-2 transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'heatmap'
                ? 'bg-primary-container text-on-primary-container font-bold shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container font-medium bg-transparent'
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">analytics</span>
            <span className="hidden sm:inline">{t('dashboard_lesson_insights')}</span>
            <span className="sm:hidden">{t('dashboard_tab_insights_short')}</span>
          </button>

          <button
            role="tab"
            aria-selected={activeTab === 'replay'}
            onClick={() => setActiveTab('replay')}
            className={`min-h-[44px] px-2 sm:px-5 py-2 rounded-xl text-[13px] sm:text-[15px] flex items-center justify-center gap-1.5 sm:gap-2 transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'replay'
                ? 'bg-primary-container text-on-primary-container font-bold shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container font-medium bg-transparent'
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">history</span>
            <span className="hidden sm:inline">{t('dashboard_session_replay')}</span>
            <span className="sm:hidden">{t('dashboard_tab_replay_short')}</span>
            {selectedSessionId && (
              <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
            )}
          </button>
        </div>

        {/* Tab 1: Team Skill Matrix */}
        {activeTab === 'matrix' && (
          matrixLoading ? (
            <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-12 flex flex-col items-center justify-center gap-3">
              <div className="w-8 h-8 border-3 border-primary-container border-t-transparent rounded-full animate-spin" />
              <span className="text-[14px] text-on-surface-variant font-medium">
                {t('loading')}
              </span>
            </div>
          ) : matrixData ? (
            <SkillMatrixTable
              trainees={matrixData.trainees}
              skills={matrixData.skills}
              cells={matrixData.cells}
              onSelectCell={handleSelectMatrixCell}
            />
          ) : null
        )}

        {/* Tab 2: Lesson Insights (Step Heatmap) */}
        {activeTab === 'heatmap' && (
          <LessonHeatmap
            skills={matrixData?.skills || []}
            selectedSkillId={selectedSkillId}
            onSelectSkill={(id) => setSelectedSkillId(id)}
            insights={skillInsights}
            loading={insightsLoading}
          />
        )}

        {/* Tab 3: Session Replay Viewer */}
        {activeTab === 'replay' && (
          <SessionReplayViewer
            replay={replayData}
            loading={replayLoading}
            recentSessions={recentSessionsList}
            skillsMap={skillsMap}
            traineesMap={traineesMap}
            onSelectSession={handleSelectSession}
            onClose={() => {
              setSelectedSessionId(null);
              setReplayData(null);
            }}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="w-full border-t border-outline-variant bg-surface-container-low py-4 px-6 text-center text-[13px] text-on-surface-variant">
        TAKUMI • Skill Captured Once, Taught Live Everywhere
      </footer>
    </div>
  );
};

export default DashboardScreen;
