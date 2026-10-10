import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useTranslation, SUPPORTED_LANGUAGES, type LanguageCode } from '../i18n';
import { useTheme } from '../lib/theme';
import logoSvg from '../assets/logo.svg';
import {
  fetchInsightsMatrix,
  fetchSkillInsights,
  fetchSessionReplay,
  fetchInspectionInsights,
  submitInspectionDecision,
  type InsightsMatrixResponse,
  type SkillInsightsResponse,
  type SessionReplayResponse,
  type MatrixSkill,
  type InspectionInsightsResponse,
} from '../lib/api';
import { LiveNowStrip } from '../components/dashboard/LiveNowStrip';
import { SkillMatrixTable } from '../components/dashboard/SkillMatrixTable';
import { LessonHeatmap } from '../components/dashboard/LessonHeatmap';
import { MachinesPanel } from '../components/dashboard/MachinesPanel';
import { RecentUnits } from '../components/dashboard/RecentUnits';
import {
  SessionReplayViewer,
  type RecentSessionItem,
} from '../components/dashboard/SessionReplayViewer';

type DashboardTab = 'matrix' | 'heatmap' | 'replay' | 'inspections' | 'machines';

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

  const [inspectionInsights, setInspectionInsights] = useState<InspectionInsightsResponse | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);

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

  const loadInspectionInsights = useCallback(async () => {
    setInspectionLoading(true);
    try {
      const data = await fetchInspectionInsights();
      setInspectionInsights(data);
    } catch (err) {
      console.warn('Failed to load inspection insights:', err);
    } finally {
      setInspectionLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'inspections') {
      loadInspectionInsights();
    }
  }, [activeTab, loadInspectionInsights]);

  const handleDecision = async (inspectionId: string, decision: 'confirmed_defect' | 'overridden_ok') => {
    try {
      await submitInspectionDecision(inspectionId, decision);
      await loadInspectionInsights();
    } catch (err) {
      console.error('Failed to submit inspection decision:', err);
    }
  };

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

          <Link
            to="/control"
            aria-label="Control tower"
            title="Control tower"
            className="w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center rounded-xl bg-surface-container hover:bg-surface-container-high text-on-surface border border-outline-variant transition-colors shrink-0"
          >
            <span className="material-symbols-outlined text-[19px] sm:text-[20px]">monitoring</span>
          </Link>

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

          <button
            role="tab"
            aria-selected={activeTab === 'inspections'}
            onClick={() => setActiveTab('inspections')}
            className={`min-h-[44px] px-2 sm:px-5 py-2 rounded-xl text-[13px] sm:text-[15px] flex items-center justify-center gap-1.5 sm:gap-2 transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'inspections'
                ? 'bg-primary-container text-on-primary-container font-bold shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container font-medium bg-transparent'
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">verified</span>
            <span className="hidden sm:inline">End-of-Line Quality</span>
            <span className="sm:hidden">Inspect</span>
            {inspectionInsights && inspectionInsights.live.flagged_awaiting_count > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-red-600 text-white shrink-0">
                {inspectionInsights.live.flagged_awaiting_count}
              </span>
            )}
          </button>

          <button
            role="tab"
            aria-selected={activeTab === 'machines'}
            onClick={() => setActiveTab('machines')}
            className={`min-h-[44px] px-2 sm:px-5 py-2 rounded-xl text-[13px] sm:text-[15px] flex items-center justify-center gap-1.5 sm:gap-2 transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'machines'
                ? 'bg-primary-container text-on-primary-container font-bold shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container font-medium bg-transparent'
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">precision_manufacturing</span>
            <span>Machines</span>
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

        {/* Tab 5: Machine Watch */}
        {activeTab === 'machines' && <MachinesPanel />}

        {/* Tab 4: End-of-Line Quality Inspection */}
        {activeTab === 'inspections' && (
          <div className="space-y-6">
            {/* Top Metrics Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 flex flex-col justify-between">
                <span className="text-xs uppercase font-bold text-on-surface-variant">Today's Units (LIVE)</span>
                <span className="text-[28px] font-bold font-mono text-on-surface mt-2">
                  {inspectionInsights ? inspectionInsights.live.today_count : '—'}
                </span>
                <span className="text-[11px] text-on-surface-variant mt-1">Live Factory Station</span>
              </div>

              <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 flex flex-col justify-between">
                <span className="text-xs uppercase font-bold text-on-surface-variant">First-Pass Rate (LIVE)</span>
                <span className="text-[28px] font-bold font-mono text-on-surface mt-2">
                  {inspectionInsights && inspectionInsights.live.first_pass_rate !== null
                    ? `${inspectionInsights.live.first_pass_rate}%`
                    : '—'}
                </span>
                <span className="text-[11px] text-on-surface-variant mt-1">Passed on First Check</span>
              </div>

              <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 flex flex-col justify-between">
                <span className="text-xs uppercase font-bold text-on-surface-variant">Awaiting Review</span>
                <span className="text-[28px] font-bold font-mono text-amber-600 dark:text-amber-400 mt-2">
                  {inspectionInsights ? inspectionInsights.live.flagged_awaiting_count : '—'}
                </span>
                <span className="text-[11px] text-on-surface-variant mt-1">Supervisor Decision Gate</span>
              </div>

              <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 flex flex-col justify-between">
                <span className="text-xs uppercase font-bold text-on-surface-variant">Judge Benchmark Trials</span>
                <span className="text-[28px] font-bold font-mono text-primary-container mt-2">
                  {inspectionInsights && inspectionInsights.gallery.trials_count > 0
                    ? `${inspectionInsights.gallery.trials_count}`
                    : '—'}
                </span>
                <span className="text-[11px] text-on-surface-variant mt-1">
                  {inspectionInsights && inspectionInsights.gallery.hit_rate !== null
                    ? `${inspectionInsights.gallery.hit_rate}% hit rate (VisA CC BY 4.0)`
                    : 'PUBLIC DATA: VisA'}
                </span>
              </div>
            </div>

            <RecentUnits />

            {/* Section 1: Live Factory Operations */}
            <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-[18px] font-bold text-on-surface flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary-container text-[22px]">factory</span>
                    Live End-of-Line Inspections
                  </h3>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    Multimodal inspections recorded at factory stations. Supervisors confirm or override flagged units.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    LIVE
                  </span>
                  <button
                    type="button"
                    onClick={() => navigate('/inspect')}
                    className="min-h-[40px] px-3 rounded-lg bg-primary-container text-on-primary-container font-bold text-xs flex items-center gap-1.5 cursor-pointer shadow-xs"
                  >
                    <span className="material-symbols-outlined text-[16px]">add_a_photo</span>
                    <span>Open Station</span>
                  </button>
                </div>
              </div>

              {/* Top Defect Types Strip */}
              {inspectionInsights && inspectionInsights.live.top_defect_types.length > 0 && (
                <div className="p-3 bg-surface rounded-xl border border-outline-variant flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-bold text-on-surface">Top Defects:</span>
                  {inspectionInsights.live.top_defect_types.map((d, i) => (
                    <span key={i} className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 font-medium">
                      {d.defect} ({d.count})
                    </span>
                  ))}
                </div>
              )}

              {/* Recent Live Inspections List */}
              {inspectionLoading ? (
                <div className="p-8 flex justify-center">
                  <div className="w-6 h-6 border-2 border-primary-container border-t-transparent rounded-full animate-spin" />
                </div>
              ) : inspectionInsights && inspectionInsights.live.recent.length > 0 ? (
                <div className="space-y-3">
                  {inspectionInsights.live.recent.map((item) => (
                    <div
                      key={item.id}
                      className="p-4 bg-surface rounded-xl border border-outline-variant flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-xs"
                    >
                      <div className="flex items-center gap-3">
                        {item.image_url ? (
                          <img
                            src={item.image_url}
                            alt={item.unit_id || item.id}
                            className="w-14 h-14 rounded-lg object-cover border border-outline-variant bg-black"
                          />
                        ) : (
                          <div className="w-14 h-14 rounded-lg bg-surface-container flex items-center justify-center text-on-surface-variant">
                            <span className="material-symbols-outlined text-[24px]">image</span>
                          </div>
                        )}
                        <div>
                          <div className="flex items-center gap-2">
                            {item.unit_id ? (
                              <Link to={`/units/${encodeURIComponent(item.unit_id)}`} className="font-mono font-bold text-[14px] text-on-surface underline">
                                {item.unit_id}
                              </Link>
                            ) : (
                              <span className="font-mono font-bold text-[14px] text-on-surface">{item.id}</span>
                            )}
                            <span className="text-xs text-on-surface-variant font-medium">
                              • {item.product_id}
                            </span>
                          </div>
                          <p className="text-xs text-on-surface-variant mt-0.5">
                            {item.defect ? `Defect: ${item.defect}` : 'Clean unit'}
                            {item.where ? ` (${item.where})` : ''} • {(item.confidence * 100).toFixed(0)}% conf
                          </p>
                          <span className="text-[11px] text-on-surface-variant/80">
                            {new Date(item.created_at).toLocaleString()}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 self-end sm:self-center">
                        <span
                          className={`px-2.5 py-1 rounded-full text-xs font-bold uppercase ${
                            item.ai_verdict === 'ok'
                              ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
                              : item.ai_verdict === 'defective'
                              ? 'bg-red-500/20 text-red-700 dark:text-red-300'
                              : 'bg-amber-500/20 text-amber-700 dark:text-amber-300'
                          }`}
                        >
                          {item.ai_verdict}
                        </span>

                        {item.human_decision ? (
                          <span className="text-xs font-semibold px-2 py-0.5 rounded bg-surface-container text-on-surface">
                            {item.human_decision}
                          </span>
                        ) : item.ai_verdict === 'defective' ? (
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleDecision(item.id, 'confirmed_defect')}
                              className="min-h-[36px] px-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
                              title="Confirm Defect (Sets unit to Failed)"
                            >
                              <span className="material-symbols-outlined text-[14px]">thumb_down</span>
                              <span>Confirm</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDecision(item.id, 'overridden_ok')}
                              className="min-h-[36px] px-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
                              title="Override OK (Sets unit to Passed)"
                            >
                              <span className="material-symbols-outlined text-[14px]">thumb_up</span>
                              <span>Override</span>
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 text-center text-xs text-on-surface-variant bg-surface rounded-xl border border-outline-variant">
                  No live factory units inspected yet today.
                </div>
              )}
            </div>

            {/* Section 2: Judges Benchmark Trials (PUBLIC DATA) */}
            <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-[18px] font-bold text-on-surface flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary-container text-[22px]">science</span>
                    Judge Benchmark Trials on PUBLIC DATA
                  </h3>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    Judges and evaluators testing the model against the public Amazon VisA test benchmark.
                  </p>
                </div>
                <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">
                  PUBLIC DATA: VisA (CC BY 4.0)
                </span>
              </div>

              <div className="p-4 bg-surface rounded-xl border border-outline-variant flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div>
                  <p className="text-xs text-on-surface-variant">
                    Total Public Benchmark Trials:{' '}
                    <strong className="text-on-surface">
                      {inspectionInsights ? inspectionInsights.gallery.trials_count : '—'}
                    </strong>{' '}
                    • Hits:{' '}
                    <strong className="text-on-surface">
                      {inspectionInsights ? inspectionInsights.gallery.hits_count : '—'}
                    </strong>{' '}
                    • Hit Rate:{' '}
                    <strong className="text-emerald-600 dark:text-emerald-400">
                      {inspectionInsights && inspectionInsights.gallery.hit_rate !== null
                        ? `${inspectionInsights.gallery.hit_rate}%`
                        : '—'}
                    </strong>
                  </p>
                  <p className="text-[11px] text-on-surface-variant/80 mt-1">
                    Dataset: Amazon VisA (Visual Anomaly Benchmark), CC BY 4.0
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => navigate('/inspect/gallery')}
                  className="min-h-[44px] px-4 rounded-xl border border-outline-variant bg-surface-container hover:bg-surface-container-high text-on-surface font-bold text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[18px]">photo_library</span>
                  <span>Try VisA Gallery</span>
                </button>
              </div>
            </div>
          </div>
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
