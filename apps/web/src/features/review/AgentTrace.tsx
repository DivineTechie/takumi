import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { collection, query, orderBy, onSnapshot, doc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { getVideoObjectUrl } from './mediaStorage';
import { useI18n } from '../../i18n';
import {
  Sparkles,
  CheckCircle2,
  Clock,
  ArrowRight,
  Video,
  VideoOff,
  Layers,
  FileCheck,
  Languages,
  AlertTriangle,
  Play,
} from 'lucide-react';

export interface AgentTraceProps {
  jobId?: string;
  onNavigateToReview?: (skillId: string) => void;
}

interface AgentEvent {
  id: string;
  agent: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  artifact_uri?: string;
  ms?: number;
  t: string;
}

interface AssembledStep {
  n: number;
  title?: string;
  instruction: string;
  success_criteria?: string;
  why?: string;
  translations?: Record<string, { title?: string; instruction: string; why: string }>;
  point_hint?: string;
  clip?: { start_s: number; end_s: number };
}

type JobStatus = 'queued' | 'running' | 'done' | 'failed';

// Name and description are translation keys: app.trace_agent_<id>_name / app.trace_agent_<id>_desc.
// spatial, verifier and localizer run in parallel after the segmenter.
const AGENT_NODES = [
  { id: 'segmenter', icon: Layers },
  { id: 'spatial', icon: Play },
  { id: 'verifier', icon: FileCheck },
  { id: 'localizer', icon: Languages },
  { id: 'publisher', icon: CheckCircle2 },
];

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English (en)',
  ja: '日本語 (ja)',
  vi: 'Tiếng Việt (vi)',
  hi: 'हिन्दी (hi)',
  id: 'Bahasa Indonesia (id)',
  fil: 'Tagalog (fil)',
};

function formatTimestamp(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  const ms = Math.floor((secs % 1) * 10);
  return `${m}:${String(s).padStart(2, '0')}.${ms}`;
}

/**
 * Extracts a keyframe JPEG thumbnail from the recorded video element at target timestamp.
 */
function extractThumbnailFromVideo(
  videoUrl: string,
  targetTime: number
): Promise<string> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.src = videoUrl;
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';

    let settled = false;
    const done = (val: string) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        video.onloadeddata = null;
        video.onseeked = null;
        video.onerror = null;
        video.src = '';
        resolve(val);
      }
    };

    const timer = setTimeout(() => done(''), 3500);

    video.onloadeddata = () => {
      video.currentTime = Math.max(0.05, targetTime);
    };

    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
          done(dataUrl);
          return;
        }
      } catch {
        // canvas fallback
      }
      done('');
    };

    video.onerror = () => done('');
  });
}

/**
 * Live trace of one Standard Work Studio job. Everything shown comes from Firestore:
 * forge_jobs/{jobId} (status), forge_jobs/{jobId}/events (what each node reported) and the
 * skills/{skillId} document the publisher writes. The recording plays from this device when present.
 */
export const AgentTrace: React.FC<AgentTraceProps> = ({ jobId: propJobId, onNavigateToReview }) => {
  const { jobId: paramJobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const tf = (key: string, fallback: string, params?: Record<string, string | number>) => {
    const text = t(key, params);
    return text === key ? fallback : text;
  };
  const jobId = propJobId || paramJobId || '';
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [skillId, setSkillId] = useState<string>('');
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [steps, setSteps] = useState<AssembledStep[]>([]);
  const [lessonLanguages, setLessonLanguages] = useState<string[]>(['en']);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');

  const [masterVideoUrl, setMasterVideoUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [clipThumbnails, setClipThumbnails] = useState<Record<number, string>>({});
  const masterVideoRef = useRef<HTMLVideoElement | null>(null);

  // The recording saved on this device for this job (IndexedDB), if any.
  useEffect(() => {
    let active = true;
    getVideoObjectUrl(jobId).then((url) => {
      if (active && url) setMasterVideoUrl(url);
    });
    return () => {
      active = false;
    };
  }, [jobId]);

  // Thumbnails cut from the recording at the clips the segmenter found.
  useEffect(() => {
    if (!masterVideoUrl || steps.length === 0) return;
    let active = true;

    const generateThumbnails = async () => {
      const thumbs: Record<number, string> = {};
      for (const step of steps) {
        if (!active) break;
        if (step.clip) {
          const midPoint = (step.clip.start_s + step.clip.end_s) / 2;
          const thumb = await extractThumbnailFromVideo(masterVideoUrl, midPoint);
          if (thumb && active) {
            thumbs[step.n] = thumb;
          }
        }
      }
      if (active && Object.keys(thumbs).length > 0) {
        setClipThumbnails((prev) => ({ ...prev, ...thumbs }));
      }
    };

    generateThumbnails();
    return () => {
      active = false;
    };
  }, [masterVideoUrl, steps]);

  // The true duration of the recording (WebM from MediaRecorder reports Infinity until probed).
  const handleLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = e.currentTarget;
    const dur = video.duration;
    if (dur && isFinite(dur) && dur > 0) {
      setVideoDuration(+dur.toFixed(1));
    } else if (dur === Infinity) {
      video.currentTime = 1e101;
      video.ontimeupdate = () => {
        video.ontimeupdate = null;
        const probed = video.currentTime;
        video.currentTime = 0;
        if (probed && isFinite(probed) && probed > 0) {
          setVideoDuration(+probed.toFixed(1));
        }
      };
    }
  };

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    setCurrentTime(e.currentTarget.currentTime);
  };

  // Job status and the events each node reports.
  useEffect(() => {
    if (!jobId) return;
    const unsubJob = onSnapshot(
      doc(db, 'forge_jobs', jobId),
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        if (data.skill_id) setSkillId(data.skill_id);
        if (data.status) setJobStatus(data.status as JobStatus);
      },
      (err) => console.warn('Could not read the Studio job:', err)
    );
    const unsubEvents = onSnapshot(
      query(collection(db, 'forge_jobs', jobId, 'events'), orderBy('t', 'asc')),
      (snapshot) => {
        const loaded: AgentEvent[] = [];
        snapshot.forEach((docSnap) => {
          loaded.push({ id: docSnap.id, ...docSnap.data() } as AgentEvent);
        });
        setEvents(loaded);
      },
      (err) => console.warn('Could not read the Studio events:', err)
    );
    return () => {
      unsubJob();
      unsubEvents();
    };
  }, [jobId]);

  // The lesson the publisher saved.
  useEffect(() => {
    if (!skillId) return;
    const unsub = onSnapshot(
      doc(db, 'skills', skillId),
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        setSteps(Array.isArray(data.steps) ? (data.steps as AssembledStep[]) : []);
        if (Array.isArray(data.languages) && data.languages.length > 0) setLessonLanguages(data.languages as string[]);
      },
      (err) => console.warn('Could not read the lesson:', err)
    );
    return () => unsub();
  }, [skillId]);

  const seekToClip = (startS: number) => {
    if (masterVideoRef.current) {
      masterVideoRef.current.currentTime = startS;
      masterVideoRef.current.play().catch(() => {});
    }
  };

  // A node is done when it reported a timed info event; it failed when it reported an error.
  const completedAgents = new Set(events.filter((e) => e.level === 'info' && e.ms !== undefined).map((e) => e.agent));
  const failedAgents = new Set(events.filter((e) => e.level === 'error').map((e) => e.agent));
  const lastError = [...events].reverse().find((e) => e.level === 'error');
  const isDone = jobStatus === 'done';
  const isFailed = jobStatus === 'failed' || failedAgents.size > 0;
  const runningAgents = new Set(
    isDone || isFailed
      ? []
      : events.filter((e) => !completedAgents.has(e.agent) && !failedAgents.has(e.agent)).map((e) => e.agent)
  );
  const hasSteps = steps.length > 0;
  const timelineSeconds = Math.max(videoDuration, ...steps.map((s) => s.clip?.end_s ?? 0), 1);

  const activeStepIndex = steps.findIndex(
    (s) => s.clip && currentTime >= s.clip.start_s && currentTime <= s.clip.end_s
  );

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#09090b',
        color: '#f4f4f5',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* Top Header */}
      <header
        style={{
          borderBottom: '1px solid #27272a',
          padding: '0.85rem 1.5rem',
          backgroundColor: '#18181b',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1rem' }}>
          <div
            style={{
              backgroundColor: 'rgba(245, 158, 11, 0.15)',
              border: '1px solid rgba(245, 158, 11, 0.4)',
              color: '#fbbf24',
              padding: '0.35rem 0.8rem',
              borderRadius: '9999px',
              fontSize: '0.85rem',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <Sparkles size={16} />
            <span>TAKUMI 匠 · {t('app.trace_eyebrow')}</span>
          </div>
          <span style={{ color: '#a1a1aa', fontSize: '0.85rem' }}>
            {t('app.trace_job_label')} <code style={{ color: '#ffffff', backgroundColor: '#27272a', padding: '0.15rem 0.4rem', borderRadius: '0.25rem' }}>{jobId}</code>
          </span>
        </div>

        {isDone && skillId && (
          <button
            onClick={() => {
              if (onNavigateToReview) {
                onNavigateToReview(skillId);
              } else {
                navigate(`/review/${skillId}`);
              }
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              backgroundColor: '#10b981',
              color: '#ffffff',
              border: 'none',
              padding: '0.55rem 1.25rem',
              minHeight: '44px',
              borderRadius: '0.65rem',
              fontWeight: 700,
              fontSize: '0.9rem',
              cursor: 'pointer',
              boxShadow: '0 4px 14px rgba(16, 185, 129, 0.4)',
            }}
          >
            <span>{t('app.trace_review_lesson')}</span>
            <ArrowRight size={16} />
          </button>
        )}
      </header>

      {isFailed && (
        <div
          role="alert"
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.12)',
            borderBottom: '1px solid #ef4444',
            color: '#fca5a5',
            padding: '0.75rem 1.5rem',
            display: 'flex',
            gap: '0.6rem',
            alignItems: 'flex-start',
            fontSize: '0.9rem',
          }}
        >
          <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
          <div>
            <div style={{ fontWeight: 700, color: '#fecaca' }}>
              {tf('app.trace_failed', 'The Studio could not finish this recording.')}
            </div>
            {lastError && <div style={{ marginTop: '0.2rem' }}>{lastError.message}</div>}
          </div>
        </div>
      )}

      {/* One column on phones, three on wide screens */}
      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[330px_1fr_380px] lg:h-[calc(100vh-61px)] lg:overflow-hidden">
        {/* LEFT COLUMN: Master Recording & Clip Timeline */}
        <section
          style={{
            borderRight: '1px solid #27272a',
            padding: '1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.25rem',
            overflowY: 'auto',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#fbbf24', fontWeight: 700, marginBottom: '0.75rem' }}>
              <Video size={18} />
              <span>{t('app.trace_master_recording')}</span>
            </div>

            {masterVideoUrl ? (
              <div>
                <div style={{ borderRadius: '0.75rem', overflow: 'hidden', border: '1px solid #3f3f46', backgroundColor: '#000000' }}>
                  <video
                    ref={masterVideoRef}
                    controls
                    playsInline
                    src={masterVideoUrl}
                    onLoadedMetadata={handleLoadedMetadata}
                    onTimeUpdate={handleTimeUpdate}
                    style={{
                      width: '100%',
                      aspectRatio: '16/9',
                      display: 'block',
                      backgroundColor: '#000000',
                    }}
                  />
                </div>

                {hasSteps && (
                  <div style={{ marginTop: '0.65rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#a1a1aa', marginBottom: '0.35rem' }}>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {formatTimestamp(currentTime)} / {formatTimestamp(timelineSeconds)}
                      </span>
                      <span style={{ color: '#fbbf24', fontWeight: 600 }}>
                        {activeStepIndex >= 0 ? t('app.trace_step_active', { n: steps[activeStepIndex].n }) : t('app.trace_ready')}
                      </span>
                    </div>

                    <div
                      style={{
                        height: '14px',
                        backgroundColor: '#27272a',
                        borderRadius: '0.375rem',
                        overflow: 'hidden',
                        position: 'relative',
                        cursor: 'pointer',
                        border: '1px solid #3f3f46',
                      }}
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                        seekToClip(clickRatio * timelineSeconds);
                      }}
                    >
                      {steps.map((s, idx) => {
                        if (!s.clip) return null;
                        const isCurrent = activeStepIndex === idx;
                        const colors = ['#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899'];
                        const baseColor = colors[idx % colors.length];
                        return (
                          <div
                            key={s.n}
                            title={t('app.trace_segment_title', { n: s.n, start: s.clip.start_s.toFixed(1), end: s.clip.end_s.toFixed(1) })}
                            style={{
                              position: 'absolute',
                              top: 0,
                              bottom: 0,
                              left: `${(s.clip.start_s / timelineSeconds) * 100}%`,
                              width: `${((s.clip.end_s - s.clip.start_s) / timelineSeconds) * 100}%`,
                              backgroundColor: isCurrent ? baseColor : `${baseColor}55`,
                              borderRight: '1px solid #09090b',
                            }}
                          />
                        );
                      })}

                      <div
                        style={{
                          position: 'absolute',
                          top: 0,
                          bottom: 0,
                          left: `${(currentTime / timelineSeconds) * 100}%`,
                          width: '3px',
                          backgroundColor: '#ffffff',
                          boxShadow: '0 0 6px #ffffff',
                          transform: 'translateX(-50%)',
                          pointerEvents: 'none',
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div
                style={{
                  width: '100%',
                  aspectRatio: '16/9',
                  backgroundColor: '#18181b',
                  borderRadius: '0.75rem',
                  border: '1px dashed #3f3f46',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#71717a',
                  padding: '1rem',
                  textAlign: 'center',
                }}
              >
                <VideoOff size={32} style={{ marginBottom: '0.5rem', opacity: 0.6 }} />
                <span style={{ fontSize: '0.85rem', color: '#d4d4d8', fontWeight: 600 }}>{t('app.trace_master_recording')}</span>
                <span style={{ fontSize: '0.75rem', color: '#71717a', marginTop: '0.25rem' }}>
                  {t('app.trace_video_uploaded')}
                </span>
              </div>
            )}
          </div>

          {/* Clips found by the segmenter */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#d4d4d8', marginBottom: '0.75rem', display: 'flex', flexWrap: 'wrap', gap: '0.25rem', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>{t('app.trace_clip_markers')}</span>
            </div>

            {!hasSteps ? (
              <div
                style={{
                  backgroundColor: '#18181b',
                  border: '1px dashed #3f3f46',
                  borderRadius: '0.65rem',
                  padding: '1.25rem 1rem',
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                <Clock size={22} style={{ color: isFailed ? '#f87171' : '#fbbf24' }} />
                <div style={{ fontSize: '0.85rem', color: '#f4f4f5', fontWeight: 600 }}>
                  {isFailed ? tf('app.trace_failed', 'The Studio could not finish this recording.') : t('app.trace_analyzing')}
                </div>
                {!isFailed && (
                  <div style={{ fontSize: '0.75rem', color: '#71717a', lineHeight: 1.4 }}>
                    {t('app.trace_analyzing_desc')}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                {steps.map((s, idx) => {
                  const isPlaying = activeStepIndex === idx;
                  const hasThumbnail = Boolean(clipThumbnails[s.n]);

                  return (
                    <div
                      key={s.n}
                      onClick={() => s.clip && seekToClip(s.clip.start_s)}
                      style={{
                        backgroundColor: isPlaying ? 'rgba(245, 158, 11, 0.12)' : '#18181b',
                        border: isPlaying ? '2px solid #f59e0b' : '1px solid #27272a',
                        borderRadius: '0.65rem',
                        padding: '0.65rem',
                        textAlign: 'left',
                        cursor: masterVideoUrl && s.clip ? 'pointer' : 'default',
                        display: 'flex',
                        gap: '0.75rem',
                      }}
                    >
                      <div
                        style={{
                          position: 'relative',
                          width: '84px',
                          height: '52px',
                          borderRadius: '0.4rem',
                          overflow: 'hidden',
                          backgroundColor: '#09090b',
                          flexShrink: 0,
                          border: isPlaying ? '1px solid #f59e0b' : '1px solid #3f3f46',
                        }}
                      >
                        {hasThumbnail ? (
                          <img
                            src={clipThumbnails[s.n]}
                            alt={t('app.trace_keyframe_alt', { n: s.n })}
                            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                          />
                        ) : (
                          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#71717a' }}>
                            <Video size={18} />
                          </div>
                        )}
                        {s.clip && (
                          <div
                            style={{
                              position: 'absolute',
                              bottom: '2px',
                              right: '2px',
                              backgroundColor: 'rgba(0,0,0,0.75)',
                              color: '#fbbf24',
                              fontSize: '0.65rem',
                              fontWeight: 700,
                              padding: '0.05rem 0.25rem',
                              borderRadius: '0.2rem',
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {t('app.trace_seconds', { value: s.clip.start_s.toFixed(1) })}
                          </div>
                        )}
                      </div>

                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span
                            style={{
                              backgroundColor: isPlaying ? '#f59e0b' : '#3f3f46',
                              color: isPlaying ? '#000000' : '#ffffff',
                              fontSize: '0.65rem',
                              fontWeight: 800,
                              padding: '0.1rem 0.35rem',
                              borderRadius: '0.25rem',
                            }}
                          >
                            {t('app.trace_step_badge', { n: s.n })}
                          </span>
                          {s.clip && (
                            <span style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums', fontSize: '0.75rem', fontWeight: 600 }}>
                              {formatTimestamp(s.clip.start_s)} - {formatTimestamp(s.clip.end_s)}
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            color: isPlaying ? '#ffffff' : '#d4d4d8',
                            fontSize: '0.78rem',
                            fontWeight: isPlaying ? 600 : 500,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {s.title || s.instruction}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* CENTER COLUMN: Studio workflow nodes and what each one reported */}
        <section
          style={{
            padding: '1.5rem',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          <div style={{ width: '100%', maxWidth: '640px' }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 1.25rem 0', color: '#ffffff' }}>
              {t('app.trace_pipeline_title')}
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', width: '100%' }}>
              {AGENT_NODES.map((node) => {
                const nodeEvents = events.filter((e) => e.agent === node.id);
                const isNodeDone = completedAgents.has(node.id);
                const isNodeFailed = failedAgents.has(node.id);
                const isRunning = runningAgents.has(node.id);
                const notices = nodeEvents.filter((e) => e.level === 'warn');
                const latest = nodeEvents.filter((e) => e.level !== 'warn').pop();
                const durationMs = nodeEvents.find((e) => e.ms !== undefined)?.ms;
                const Icon = node.icon;

                return (
                  <div
                    key={node.id}
                    style={{
                      backgroundColor: '#18181b',
                      borderRadius: '0.85rem',
                      border: isNodeFailed
                        ? '2px solid #ef4444'
                        : isRunning
                        ? '2px solid #f59e0b'
                        : isNodeDone
                        ? '1px solid #10b981'
                        : '1px solid #27272a',
                      padding: '0.9rem 1.15rem',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.35rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <div
                          style={{
                            padding: '0.45rem',
                            borderRadius: '0.45rem',
                            backgroundColor: isNodeDone ? 'rgba(16, 185, 129, 0.15)' : 'rgba(39, 39, 42, 0.8)',
                            color: isNodeFailed ? '#f87171' : isNodeDone ? '#34d399' : isRunning ? '#fbbf24' : '#a1a1aa',
                          }}
                        >
                          <Icon size={18} />
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, color: '#ffffff', fontSize: '0.95rem' }}>
                            {t(`app.trace_agent_${node.id}_name`)}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: '#71717a' }}>{t(`app.trace_agent_${node.id}_desc`)}</div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {durationMs !== undefined && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: '#a1a1aa', fontSize: '0.75rem' }}>
                            <Clock size={13} />
                            <span>{t('app.replay_latency_ms', { value: durationMs })}</span>
                          </div>
                        )}
                        {isNodeFailed ? (
                          <AlertTriangle size={18} color="#f87171" />
                        ) : isNodeDone ? (
                          <CheckCircle2 size={18} color="#10b981" />
                        ) : isRunning ? (
                          <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#f59e0b', boxShadow: '0 0 10px #f59e0b' }} />
                        ) : (
                          <span style={{ fontSize: '0.7rem', color: '#a1a1aa', fontWeight: 600 }}>{t('app.trace_queued')}</span>
                        )}
                      </div>
                    </div>

                    {latest && (
                      <div
                        style={{
                          marginTop: '0.4rem',
                          backgroundColor: '#09090b',
                          padding: '0.45rem 0.65rem',
                          borderRadius: '0.4rem',
                          fontSize: '0.8rem',
                          color: latest.level === 'error' ? '#fca5a5' : isRunning ? '#fbbf24' : '#d4d4d8',
                          borderLeft: isRunning ? '3px solid #f59e0b' : '3px solid transparent',
                        }}
                      >
                        {latest.message}
                      </div>
                    )}
                    {notices.map((e) => (
                      <div key={e.id} style={{ marginTop: '0.3rem', fontSize: '0.75rem', color: '#fcd34d', display: 'flex', gap: '0.35rem' }}>
                        <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: '0.15rem' }} />
                        <span>{e.message}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: the saved lesson */}
        <section
          style={{
            borderLeft: '1px solid #27272a',
            padding: '1.25rem',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 700, color: '#ffffff', fontSize: '0.95rem' }}>{t('app.trace_assembled_title')}</div>
            <select
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
              disabled={lessonLanguages.length < 2}
              style={{
                backgroundColor: '#27272a',
                border: '1px solid #3f3f46',
                color: '#ffffff',
                borderRadius: '0.35rem',
                padding: '0.25rem 0.5rem',
                minHeight: '36px',
                fontSize: '0.8rem',
              }}
            >
              {lessonLanguages.map((code) => (
                <option key={code} value={code}>
                  {LANGUAGE_LABELS[code] || code}
                </option>
              ))}
            </select>
          </div>

          {!hasSteps ? (
            <div
              style={{
                backgroundColor: '#18181b',
                border: '1px dashed #3f3f46',
                borderRadius: '0.75rem',
                padding: '2.5rem 1.5rem',
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.75rem',
              }}
            >
              <Sparkles size={28} style={{ color: '#fbbf24' }} />
              <div style={{ fontSize: '0.95rem', color: '#f4f4f5', fontWeight: 600 }}>{t('app.trace_assembling')}</div>
              <div style={{ fontSize: '0.8rem', color: '#a1a1aa', lineHeight: 1.5 }}>
                {t('app.trace_assembling_desc')}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              {steps.map((step, idx) => {
                const translated = selectedLanguage === 'en' ? undefined : step.translations?.[selectedLanguage];
                const displayTitle = translated?.title || step.title;
                const displayInstruction = translated?.instruction || step.instruction;
                const displayWhy = translated?.why || step.why;
                const isPlaying = activeStepIndex === idx;

                return (
                  <div
                    key={step.n}
                    style={{
                      backgroundColor: isPlaying ? 'rgba(245, 158, 11, 0.08)' : '#18181b',
                      border: isPlaying ? '2px solid #f59e0b' : '1px solid #27272a',
                      borderRadius: '0.75rem',
                      padding: '0.9rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.5rem',
                    }}
                  >
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }}>
                        <span
                          style={{
                            backgroundColor: isPlaying ? '#f59e0b' : '#3f3f46',
                            color: isPlaying ? '#000000' : '#ffffff',
                            fontWeight: 800,
                            fontSize: '0.7rem',
                            padding: '0.15rem 0.45rem',
                            borderRadius: '0.3rem',
                          }}
                        >
                          {t('app.trace_step_badge', { n: step.n })}
                        </span>
                        {step.clip && (
                          <button
                            onClick={() => seekToClip(step.clip!.start_s)}
                            style={{
                              background: 'none',
                              border: isPlaying ? '1px solid #f59e0b' : '1px solid #3f3f46',
                              borderRadius: '0.25rem',
                              color: isPlaying ? '#fbbf24' : '#a1a1aa',
                              fontSize: '0.7rem',
                              padding: '0.1rem 0.35rem',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.25rem',
                            }}
                            title={t('app.trace_seek_title')}
                          >
                            <Play size={10} />
                            <span>{t('app.trace_clip_range', { start: step.clip.start_s.toFixed(1), end: step.clip.end_s.toFixed(1) })}</span>
                          </button>
                        )}
                      </div>
                      {step.point_hint && (
                        <span style={{ fontSize: '0.75rem', color: '#fbbf24', fontWeight: 600 }}>📍 {step.point_hint}</span>
                      )}
                    </div>

                    {displayTitle && (
                      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#fbbf24' }}>{displayTitle}</div>
                    )}
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#ffffff', lineHeight: 1.35 }}>
                      {displayInstruction}
                    </div>

                    {displayWhy && (
                      <div
                        style={{
                          fontSize: '0.8rem',
                          color: '#d4d4d8',
                          backgroundColor: '#27272a',
                          padding: '0.5rem 0.65rem',
                          borderRadius: '0.45rem',
                          lineHeight: 1.4,
                          borderLeft: '3px solid #f59e0b',
                        }}
                      >
                        <strong style={{ color: '#fbbf24' }}>{t('app.trace_why_label')} </strong>
                        {displayWhy}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
