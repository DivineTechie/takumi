import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { SessionReplayViewer } from '../components/dashboard/SessionReplayViewer';

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

  return (
    <div className="bg-background text-on-surface font-body-md min-h-screen antialiased flex flex-col justify-between selection:bg-primary-container selection:text-on-primary-container">
      {/* Top Header */}
      <header className="w-full bg-surface-container-low min-h-[64px] flex items-center justify-between px-4 sm:px-6 sticky top-0 z-40 border-b border-outline-variant shadow-sm">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            aria-label={t('back')}
            className="w-12 h-12 flex items-center justify-center rounded-xl text-on-surface hover:bg-surface-container-high active:scale-95 transition-transform cursor-pointer"
            type="button"
          >
            <span className="material-symbols-outlined text-[24px]">arrow_back</span>
          </button>
          <div className="flex items-center gap-2.5">
            <img
              src={logoSvg}
              alt="TAKUMI Logo"
              className="w-8 h-8 rounded-lg shrink-0 object-contain shadow-sm"
              width={32}
              height={32}
            />
            <h1 className="text-[18px] sm:text-[20px] font-bold text-on-surface tracking-tight">
              {t('dashboard_title')}
            </h1>
          </div>
        </div>

        {/* Header Right Actions */}
        <div className="flex items-center gap-2">
          {/* Refresh button */}
          <button
            onClick={() => loadMatrix()}
            disabled={matrixLoading}
            aria-label="Refresh dashboard data"
            className="w-10 h-10 flex items-center justify-center rounded-xl bg-surface-container hover:bg-surface-container-high text-on-surface border border-outline-variant transition-colors cursor-pointer disabled:opacity-50"
            type="button"
          >
            <span className={`material-symbols-outlined text-[20px] ${matrixLoading ? 'animate-spin' : ''}`}>
              refresh
            </span>
          </button>

          {/* Language selector */}
          <div className="relative flex items-center">
            <label className="sr-only" htmlFor="dashboard-lang-select">
              Select language
            </label>
            <span className="material-symbols-outlined absolute left-2 pointer-events-none text-on-surface-variant text-[18px]">
              language
            </span>
            <select
              id="dashboard-lang-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value as LanguageCode)}
              className="appearance-none bg-surface-container border border-outline-variant text-on-surface text-[14px] font-medium rounded-xl pl-7 pr-6 py-2 focus:outline-none focus:ring-1 focus:ring-primary-container cursor-pointer max-w-[120px] truncate"
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.native}
                </option>
              ))}
            </select>
          </div>

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? t('light_mode') : t('dark_mode')}
            className="w-10 h-10 flex items-center justify-center rounded-xl bg-surface-container hover:bg-surface-container-high text-on-surface border border-outline-variant transition-colors cursor-pointer"
            type="button"
          >
            <span className="material-symbols-outlined text-[20px]">
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

        {/* Tabs Bar */}
        <div className="flex items-center gap-2 bg-surface-container-low p-1.5 rounded-2xl border border-outline-variant w-fit max-w-full overflow-x-auto">
          <button
            onClick={() => setActiveTab('matrix')}
            className={`min-h-[44px] px-4 sm:px-5 py-2 rounded-xl font-bold text-[14px] sm:text-[15px] flex items-center gap-2 transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'matrix'
                ? 'bg-primary-container text-on-primary-container shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container'
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">group</span>
            {t('dashboard_team_matrix')}
          </button>

          <button
            onClick={() => setActiveTab('heatmap')}
            className={`min-h-[44px] px-4 sm:px-5 py-2 rounded-xl font-bold text-[14px] sm:text-[15px] flex items-center gap-2 transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'heatmap'
                ? 'bg-primary-container text-on-primary-container shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container'
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">analytics</span>
            {t('dashboard_lesson_insights')}
          </button>

          <button
            onClick={() => setActiveTab('replay')}
            className={`min-h-[44px] px-4 sm:px-5 py-2 rounded-xl font-bold text-[14px] sm:text-[15px] flex items-center gap-2 transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'replay'
                ? 'bg-primary-container text-on-primary-container shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container'
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">history</span>
            {t('dashboard_session_replay')}
            {selectedSessionId && (
              <span className="w-2 h-2 rounded-full bg-primary" />
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
