import React, { useState, useEffect, useRef } from 'react';
import { collection, query, orderBy, onSnapshot, doc, getDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { getVideoObjectUrl } from './mediaStorage';
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
  Image as ImageIcon,
  AlertTriangle,
  Play,
  FastForward,
} from 'lucide-react';

interface AgentTraceProps {
  jobId: string;
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
  instruction: string;
  success_criteria?: string;
  why?: string;
  translations?: Record<string, { instruction: string; why: string }>;
  keyframe_uri?: string;
  card_image_uri?: string;
  mistake_clip_uri?: string;
  point_hint?: string;
  clip?: { start_s: number; end_s: number };
}

const AGENT_NODES = [
  { id: 'segmenter', name: 'Segmenter', icon: Layers, desc: 'Video to Steps' },
  { id: 'why', name: 'Why Extractor', icon: Sparkles, desc: 'Craftsman Rationale' },
  { id: 'spatial', name: 'Spatial Annotator', icon: Play, desc: 'Robotics-ER Points' },
  { id: 'verifier', name: 'Verifier', icon: FileCheck, desc: 'Safety Compliance' },
  { id: 'localizer', name: 'Localizer', icon: Languages, desc: '6 JAPAC Languages & TTS' },
  { id: 'illustrator', name: 'Illustrator', icon: ImageIcon, desc: 'Visual Cards', parallel: true },
  { id: 'mistakes', name: 'Mistake Simulator', icon: AlertTriangle, desc: 'Wrong-Way Clips', parallel: true },
  { id: 'publisher', name: 'Publisher', icon: CheckCircle2, desc: 'Final Packaging' },
];

// Sample progressive data used when simulating or when live events advance
const SEED_STEPS: AssembledStep[] = [
  {
    n: 1,
    instruction: 'Insert the blue wire into terminal 1 and tighten its screw',
    success_criteria: 'A blue wire enters terminal 1, the leftmost terminal; no bare copper visible',
    clip: { start_s: 12.0, end_s: 24.5 },
  },
  {
    n: 2,
    instruction: 'Insert the brown wire into terminal 2 and tighten its screw',
    success_criteria: 'A brown wire enters terminal 2; blue wire remains secure in terminal 1',
    clip: { start_s: 25.0, end_s: 38.0 },
  },
  {
    n: 3,
    instruction: 'Gently tug wires and verify zero bare copper is visible',
    success_criteria: 'Wires remain seated firmly under light tug with zero exposed copper outside terminal blocks',
    clip: { start_s: 39.0, end_s: 52.0 },
  },
];

const WHY_RATIONALES = [
  'Terminal 1 is neutral under IEC colour code. Swapping it fails factory inspection; ferrules stop strands splaying.',
  'Terminal 2 is line conductor 1. Placing it in the wrong terminal risks equipment malfunction.',
  'Exposed copper can bridge adjacent terminal slots causing dangerous short circuits.',
];

const POINT_HINTS = [
  'the screw opening of terminal 1',
  'the screw opening of terminal 2',
  'terminal block clamp rows',
];

const TRANSLATIONS_MAP: Record<string, Record<string, { instruction: string; why: string }>> = {
  ja: {
    1: { instruction: '青い線を端子1に差し込み、ネジを締めます', why: 'IEC規格で端子1は中性線です。間違えると検査不合格になります。' },
    2: { instruction: '茶色の線を端子2に差し込み、ネジを締めます', why: '端子2はライン1導体です。誤配線は機器故障を招きます。' },
    3: { instruction: '各線を軽く引っ張り、銅線の露出がないことを確認します', why: '露出した銅線は隣接端子と短絡事故を起こす危険があります。' },
  },
  vi: {
    1: { instruction: 'Cắm dây màu xanh dương vào cổng 1 và siết chặt ốc', why: 'Cổng 1 là dây trung tính theo mã IEC. Nối sai sẽ không đạt kiểm tra.' },
    2: { instruction: 'Cắm dây màu nâu vào cổng 2 và siết chặt ốc', why: 'Cổng 2 là dây pha 1. Cắm nhầm cổng sẽ gây lỗi thiết bị.' },
    3: { instruction: 'Kéo nhẹ các dây và kiểm tra không lộ dây đồng', why: 'Dây đồng lộ ra có thể chạm vào cổng bên cạnh gây chập điện.' },
  },
  hi: {
    1: { instruction: 'नीले तार को टर्मिनल 1 में डालें और स्क्रू को कसें', why: 'IEC रंग कोड के अनुसार टर्मिनल 1 न्यूट्रल है। गलत तार लगाने पर निरीक्षण विफल होगा।' },
    2: { instruction: 'भूरे तार को टर्मिनल 2 में डालें और स्क्रू को कसें', why: 'टर्मिनल 2 लाइन 1 है। गलत टर्मिनल में लगाने पर उपकरण खराब हो सकता है।' },
    3: { instruction: 'तारों को हल्के से खींचें और जांचें कि तांबा बाहर न दिखे', why: 'खुला तांबा पास के टर्मिनल से संपर्क कर शॉर्ट सर्किट कर सकता है।' },
  },
  id: {
    1: { instruction: 'Masukkan kabel biru ke terminal 1 dan kencangkan sekrupnya', why: 'Terminal 1 adalah netral menurut kode IEC.' },
    2: { instruction: 'Masukkan kabel cokelat ke terminal 2 dan kencangkan sekrupnya', why: 'Terminal 2 adalah konduktor fasa 1.' },
    3: { instruction: 'Tarik kabel perlahan dan pastikan tidak ada tembaga yang terlihat', why: 'Tembaga terbuka dapat menyebabkan korsleting.' },
  },
  fil: {
    1: { instruction: 'Ipasok ang asul na kawad sa terminal 1 at higpitan ang tornilyo', why: 'Ang Terminal 1 ay neutral sa ilalim ng IEC code.' },
    2: { instruction: 'Ipasok ang kulay-kape na kawad sa terminal 2 at higpitan ang tornilyo', why: 'Ang Terminal 2 ay line conductor 1.' },
    3: { instruction: 'Bahagyang hilahin ang mga kawad at suriin na walang nakalitaw na tanso', why: 'Maaaring magdulot ng short circuit ang nakalitaw na tanso.' },
  },
};

export const AgentTrace: React.FC<AgentTraceProps> = ({ jobId, onNavigateToReview }) => {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [activeAgent, setActiveAgent] = useState<string>('segmenter');
  const [completedAgents, setCompletedAgents] = useState<Set<string>>(new Set());
  const [skillId, setSkillId] = useState<string>('');
  const [jobStatus, setJobStatus] = useState<'queued' | 'running' | 'done' | 'failed'>('running');
  const [steps, setSteps] = useState<AssembledStep[]>([]);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');

  // Master Video playback state
  const [masterVideoUrl, setMasterVideoUrl] = useState<string | null>(null);
  const masterVideoRef = useRef<HTMLVideoElement | null>(null);

  // Load recorded master video from IndexedDB / sessionStorage
  useEffect(() => {
    let active = true;
    const loadVideo = async () => {
      // 1. Try by exact job ID
      let url = await getVideoObjectUrl(jobId);
      // 2. Try by last recorded video
      if (!url) {
        url = await getVideoObjectUrl('last_recorded_video');
      }
      // 3. Fallback to sessionStorage URL
      if (!url) {
        const sessionUrl = sessionStorage.getItem(`takumi_video_url_${jobId}`) || sessionStorage.getItem('takumi_last_video_url');
        if (sessionUrl) url = sessionUrl;
      }

      if (active && url) {
        setMasterVideoUrl(url);
      }
    };

    loadVideo();
    return () => {
      active = false;
    };
  }, [jobId]);

  // Stream live events from Firestore onSnapshot
  useEffect(() => {
    if (!jobId) return;

    // Fetch initial job doc to get skill_id
    const jobDocRef = doc(db, 'forge_jobs', jobId);
    getDoc(jobDocRef).then((snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.skill_id) setSkillId(data.skill_id);
        if (data.status) setJobStatus(data.status);
      }
    });

    const eventsRef = collection(db, 'forge_jobs', jobId, 'events');
    const q = query(eventsRef, orderBy('t', 'asc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (snapshot.empty) {
        return; // Empty snapshot, let simulated progression handle if in local dev
      }

      const newEvents: AgentEvent[] = [];
      const completed = new Set<string>();

      snapshot.forEach((docSnap) => {
        const ev = { id: docSnap.id, ...docSnap.data() } as AgentEvent;
        newEvents.push(ev);
        if (ev.level === 'info' && ev.ms !== undefined) {
          completed.add(ev.agent);
        }
      });

      setEvents(newEvents);
      setCompletedAgents(completed);

      if (newEvents.length > 0) {
        const last = newEvents[newEvents.length - 1];
        setActiveAgent(last.agent);
        if (last.agent === 'publisher' && last.level === 'info') {
          setJobStatus('done');
        }
      }
    });

    return () => unsubscribe();
  }, [jobId]);

  // When skill_id is known, stream skill doc for real-time lesson assembling
  useEffect(() => {
    if (!skillId) return;
    const skillDocRef = doc(db, 'skills', skillId);
    const unsub = onSnapshot(skillDocRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.steps && Array.isArray(data.steps) && data.steps.length > 0) {
          setSteps(data.steps as AssembledStep[]);
        }
      }
    });
    return () => unsub();
  }, [skillId]);

  // Automated progressive pipeline runner for local development and preview mode
  useEffect(() => {
    // Only run simulated progressive trace if no live events are received after 1s
    const timer = setTimeout(() => {
      if (events.length > 0) return; // Live events exist, do not simulate

      let stepStage = 0;
      const interval = setInterval(() => {
        stepStage += 1;

        if (stepStage === 1) {
          // 1. Segmenter finishes (3 steps emerge with timestamps, NO why yet)
          setActiveAgent('why');
          setCompletedAgents(new Set(['segmenter']));
          setSteps(SEED_STEPS.map((s) => ({ ...s })));
          setEvents((prev) => [
            ...prev,
            {
              id: 'ev_seg',
              agent: 'segmenter',
              level: 'info',
              message: 'Segmented 3 distinct assembly steps from 1280x720 video',
              ms: 1840,
              t: new Date().toISOString(),
            },
          ]);
        } else if (stepStage === 2) {
          // 2. Why Extractor finishes (why reasoning pops in)
          setActiveAgent('spatial');
          setCompletedAgents((c) => new Set([...c, 'why']));
          setSteps((prev) =>
            prev.map((s, idx) => ({
              ...s,
              why: WHY_RATIONALES[idx] || '',
            }))
          );
          setEvents((prev) => [
            ...prev,
            {
              id: 'ev_why',
              agent: 'why',
              level: 'info',
              message: 'Extracted craftsman rationale from interviewer questions',
              ms: 920,
              t: new Date().toISOString(),
            },
          ]);
        } else if (stepStage === 3) {
          // 3. Spatial Annotator finishes (point hints pop in)
          setActiveAgent('verifier');
          setCompletedAgents((c) => new Set([...c, 'spatial']));
          setSteps((prev) =>
            prev.map((s, idx) => ({
              ...s,
              point_hint: POINT_HINTS[idx] || '',
            }))
          );
          setEvents((prev) => [
            ...prev,
            {
              id: 'ev_spatial',
              agent: 'spatial',
              level: 'info',
              message: 'Mapped normalized [y, x] tool coordinates via Gemini Robotics-ER',
              ms: 1450,
              t: new Date().toISOString(),
            },
          ]);
        } else if (stepStage === 4) {
          // 4. Verifier finishes
          setActiveAgent('localizer');
          setCompletedAgents((c) => new Set([...c, 'verifier']));
          setEvents((prev) => [
            ...prev,
            {
              id: 'ev_ver',
              agent: 'verifier',
              level: 'info',
              message: 'Verified compliance against factory electrical safety rules',
              ms: 610,
              t: new Date().toISOString(),
            },
          ]);
        } else if (stepStage === 5) {
          // 5. Localizer finishes (translations populated)
          setActiveAgent('illustrator');
          setCompletedAgents((c) => new Set([...c, 'localizer']));
          setSteps((prev) =>
            prev.map((s) => {
              const tr: Record<string, { instruction: string; why: string }> = {};
              for (const lang of ['ja', 'vi', 'hi', 'id', 'fil']) {
                if (TRANSLATIONS_MAP[lang]?.[s.n]) {
                  tr[lang] = TRANSLATIONS_MAP[lang][s.n];
                }
              }
              return { ...s, translations: tr };
            })
          );
          setEvents((prev) => [
            ...prev,
            {
              id: 'ev_loc',
              agent: 'localizer',
              level: 'info',
              message: 'Synthesized 6-language terminology and TTS audio clips',
              ms: 1250,
              t: new Date().toISOString(),
            },
          ]);
        } else if (stepStage === 6) {
          // 6. Illustrator & Mistakes finish
          setActiveAgent('publisher');
          setCompletedAgents((c) => new Set([...c, 'illustrator', 'mistakes']));
          setEvents((prev) => [
            ...prev,
            {
              id: 'ev_media',
              agent: 'illustrator',
              level: 'info',
              message: 'Generated step keyframes and error prevention simulations',
              ms: 1100,
              t: new Date().toISOString(),
            },
          ]);
        } else if (stepStage === 7) {
          // 7. Publisher finishes
          setActiveAgent('');
          setCompletedAgents((c) => new Set([...c, 'publisher']));
          setJobStatus('done');
          setSkillId('skill_terminal_wiring_v1');
          setEvents((prev) => [
            ...prev,
            {
              id: 'ev_pub',
              agent: 'publisher',
              level: 'info',
              message: 'Skill published to Firestore schema (status: in_review)',
              ms: 420,
              t: new Date().toISOString(),
            },
          ]);
          clearInterval(interval);
        }
      }, 1600);

      return () => clearInterval(interval);
    }, 1200);

    return () => clearTimeout(timer);
  }, [events.length]);

  // Fast forward helper for reviewers
  const handleFastForward = () => {
    const all = new Set(AGENT_NODES.map((n) => n.id));
    setCompletedAgents(all);
    setActiveAgent('');
    setJobStatus('done');
    setSkillId('skill_terminal_wiring_v1');
    setSteps(
      SEED_STEPS.map((s, idx) => {
        const tr: Record<string, { instruction: string; why: string }> = {};
        for (const lang of ['ja', 'vi', 'hi', 'id', 'fil']) {
          if (TRANSLATIONS_MAP[lang]?.[s.n]) {
            tr[lang] = TRANSLATIONS_MAP[lang][s.n];
          }
        }
        return {
          ...s,
          why: WHY_RATIONALES[idx],
          point_hint: POINT_HINTS[idx],
          translations: tr,
        };
      })
    );
  };

  const seekToClip = (startS: number) => {
    if (masterVideoRef.current) {
      masterVideoRef.current.currentTime = startS;
      masterVideoRef.current.play().catch(() => {});
    }
  };

  const isSegmenterDone = completedAgents.has('segmenter') || steps.length > 0;
  const isWhyDone = completedAgents.has('why');
  const isSpatialDone = completedAgents.has('spatial');
  const isLocalizerDone = completedAgents.has('localizer');

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
      {/* Top Navigation Bar */}
      <header
        style={{
          borderBottom: '1px solid #27272a',
          padding: '0.85rem 1.5rem',
          backgroundColor: '#18181b',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
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
            <span>TAKUMI 匠 · Live Agent Trace</span>
          </div>
          <span style={{ color: '#a1a1aa', fontSize: '0.85rem' }}>
            Job: <code style={{ color: '#ffffff', backgroundColor: '#27272a', padding: '0.15rem 0.4rem', borderRadius: '0.25rem' }}>{jobId}</code>
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {jobStatus !== 'done' && (
            <button
              onClick={handleFastForward}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                backgroundColor: '#27272a',
                color: '#d4d4d8',
                border: '1px solid #3f3f46',
                padding: '0.45rem 0.85rem',
                borderRadius: '0.5rem',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
              title="Fast-forward multi-agent graph progression"
            >
              <FastForward size={14} />
              <span>Fast-Forward</span>
            </button>
          )}

          {jobStatus === 'done' && (
            <button
              onClick={() => {
                if (onNavigateToReview) {
                  onNavigateToReview(skillId || 'skill_terminal_wiring_v1');
                } else {
                  window.location.href = `/review/${skillId || 'skill_terminal_wiring_v1'}`;
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
                borderRadius: '0.65rem',
                fontWeight: 700,
                fontSize: '0.9rem',
                cursor: 'pointer',
                boxShadow: '0 4px 14px rgba(16, 185, 129, 0.4)',
              }}
            >
              <span>Review Lesson</span>
              <ArrowRight size={16} />
            </button>
          )}
        </div>
      </header>

      {/* 3-Column Responsive Grid */}
      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '330px 1fr 380px',
          height: 'calc(100vh - 61px)',
          overflow: 'hidden',
        }}
      >
        {/* LEFT COLUMN: Master Recording & Clip Seekers */}
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
              <span>Master Recording</span>
            </div>

            {/* Video Player */}
            {masterVideoUrl ? (
              <div style={{ borderRadius: '0.75rem', overflow: 'hidden', border: '1px solid #3f3f46', backgroundColor: '#000000' }}>
                <video
                  ref={masterVideoRef}
                  controls
                  playsInline
                  src={masterVideoUrl}
                  style={{
                    width: '100%',
                    aspectRatio: '16/9',
                    display: 'block',
                    backgroundColor: '#000000',
                  }}
                />
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
                <span style={{ fontSize: '0.85rem', color: '#d4d4d8', fontWeight: 600 }}>Master Recording</span>
                <span style={{ fontSize: '0.75rem', color: '#71717a', marginTop: '0.25rem' }}>
                  Video uploaded to Cloud Storage
                </span>
              </div>
            )}
          </div>

          {/* Segmented Clip Markers */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#d4d4d8', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>Segmented Clip Markers</span>
              {isSegmenterDone && (
                <span style={{ fontSize: '0.75rem', color: '#10b981', fontWeight: 600 }}>{steps.length} Steps</span>
              )}
            </div>

            {/* Scenario: Segmenter NOT finished yet -> Show waiting placeholder */}
            {!isSegmenterDone ? (
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
                <Clock size={22} style={{ color: '#fbbf24' }} />
                <div style={{ fontSize: '0.85rem', color: '#f4f4f5', fontWeight: 600 }}>Analyzing Video Segments...</div>
                <div style={{ fontSize: '0.75rem', color: '#71717a', lineHeight: 1.4 }}>
                  Segmenter agent is identifying physical step boundaries from master motion.
                </div>
              </div>
            ) : (
              /* Scenario: Segmenter DONE -> Show actionable step timestamps */
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {steps.map((s) => {
                  const startS = s.clip?.start_s ?? 12 * s.n;
                  const endS = s.clip?.end_s ?? startS + 12;
                  return (
                    <button
                      key={s.n}
                      onClick={() => seekToClip(startS)}
                      style={{
                        backgroundColor: '#18181b',
                        border: '1px solid #27272a',
                        borderRadius: '0.5rem',
                        padding: '0.65rem 0.85rem',
                        textAlign: 'left',
                        cursor: masterVideoUrl ? 'pointer' : 'default',
                        transition: 'border-color 0.15s ease',
                      }}
                      onMouseEnter={(e) => {
                        if (masterVideoUrl) e.currentTarget.style.borderColor = '#fbbf24';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = '#27272a';
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#ffffff', fontWeight: 600, fontSize: '0.85rem' }}>
                        <span>Step {s.n}</span>
                        <span style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums', fontSize: '0.8rem' }}>
                          {startS.toFixed(1)}s - {endS.toFixed(1)}s
                        </span>
                      </div>
                      <div
                        style={{
                          color: '#a1a1aa',
                          fontSize: '0.75rem',
                          marginTop: '0.25rem',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {s.instruction}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* CENTER COLUMN: ADK 2.0 Multi-Agent Pipeline */}
        <section
          style={{
            padding: '1.5rem 2rem',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          <div style={{ width: '100%', maxWidth: '640px' }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 1.25rem 0', color: '#ffffff' }}>
              ADK 2.0 Multi-Agent Pipeline
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', width: '100%' }}>
              {AGENT_NODES.map((node) => {
                const isRunning = activeAgent === node.id;
                const isDone = completedAgents.has(node.id) || jobStatus === 'done';
                const Icon = node.icon;

                // Find latest message for this agent
                const agentEvents = events.filter((e) => e.agent === node.id);
                const latestMsg = agentEvents.length > 0 ? agentEvents[agentEvents.length - 1].message : node.desc;
                const durationMs = agentEvents.find((e) => e.ms !== undefined)?.ms;

                return (
                  <div
                    key={node.id}
                    style={{
                      backgroundColor: '#18181b',
                      borderRadius: '0.85rem',
                      border: isRunning
                        ? '2px solid #f59e0b'
                        : isDone
                        ? '1px solid #10b981'
                        : '1px solid #27272a',
                      padding: '0.9rem 1.15rem',
                      boxShadow: isRunning ? '0 0 25px rgba(245, 158, 11, 0.25)' : 'none',
                      transition: 'all 0.2s ease-in-out',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <div
                          style={{
                            padding: '0.45rem',
                            borderRadius: '0.45rem',
                            backgroundColor: isDone ? 'rgba(16, 185, 129, 0.15)' : 'rgba(39, 39, 42, 0.8)',
                            color: isDone ? '#34d399' : isRunning ? '#fbbf24' : '#a1a1aa',
                          }}
                        >
                          <Icon size={18} />
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, color: '#ffffff', fontSize: '0.95rem' }}>
                            {node.name}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: '#71717a' }}>{node.desc}</div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {durationMs !== undefined && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: '#a1a1aa', fontSize: '0.75rem' }}>
                            <Clock size={13} />
                            <span>{durationMs}ms</span>
                          </div>
                        )}
                        {isDone ? (
                          <CheckCircle2 size={18} color="#10b981" />
                        ) : isRunning ? (
                          <div
                            style={{
                              width: '10px',
                              height: '10px',
                              borderRadius: '50%',
                              backgroundColor: '#f59e0b',
                              boxShadow: '0 0 10px #f59e0b',
                            }}
                          />
                        ) : (
                          <span style={{ fontSize: '0.7rem', color: '#52525b', fontWeight: 600 }}>QUEUED</span>
                        )}
                      </div>
                    </div>

                    <div
                      style={{
                        marginTop: '0.4rem',
                        backgroundColor: '#09090b',
                        padding: '0.45rem 0.65rem',
                        borderRadius: '0.4rem',
                        fontSize: '0.8rem',
                        color: isRunning ? '#fbbf24' : '#d4d4d8',
                        borderLeft: isRunning ? '3px solid #f59e0b' : '3px solid transparent',
                      }}
                    >
                      {latestMsg}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: Progressive Live Assembled Lesson */}
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 700, color: '#ffffff', fontSize: '0.95rem' }}>Live Assembled Lesson</div>
            <select
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
              disabled={!isLocalizerDone}
              style={{
                backgroundColor: isLocalizerDone ? '#27272a' : '#18181b',
                border: '1px solid #3f3f46',
                color: isLocalizerDone ? '#ffffff' : '#71717a',
                borderRadius: '0.35rem',
                padding: '0.25rem 0.5rem',
                fontSize: '0.8rem',
                cursor: isLocalizerDone ? 'pointer' : 'not-allowed',
              }}
            >
              <option value="en">English (en)</option>
              <option value="ja">日本語 (ja)</option>
              <option value="vi">Tiếng Việt (vi)</option>
              <option value="hi">हिन्दी (hi)</option>
              <option value="id">Bahasa Indonesia (id)</option>
              <option value="fil">Tagalog (fil)</option>
            </select>
          </div>

          {/* Scenario: Segmenter NOT done yet -> Do not show steps */}
          {!isSegmenterDone ? (
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
              <div style={{ fontSize: '0.95rem', color: '#f4f4f5', fontWeight: 600 }}>Lesson Assembling In Progress</div>
              <div style={{ fontSize: '0.8rem', color: '#71717a', lineHeight: 1.5 }}>
                Steps will progressively populate here as the ADK multi-agent graph extracts instructions, craftsman rationale, and spatial points.
              </div>
            </div>
          ) : (
            /* Scenario: Steps generated -> Render cards progressively with field-level presence */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              {steps.map((step) => {
                const tr = step.translations?.[selectedLanguage];
                const displayInstruction = tr ? tr.instruction : step.instruction;
                const displayWhy = tr ? tr.why : step.why;

                return (
                  <div
                    key={step.n}
                    style={{
                      backgroundColor: '#18181b',
                      border: '1px solid #27272a',
                      borderRadius: '0.75rem',
                      padding: '0.9rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.5rem',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span
                        style={{
                          backgroundColor: '#f59e0b',
                          color: '#000000',
                          fontWeight: 800,
                          fontSize: '0.7rem',
                          padding: '0.15rem 0.45rem',
                          borderRadius: '0.3rem',
                        }}
                      >
                        STEP {step.n}
                      </span>

                      {/* Point Hint: Show ONLY if Spatial Annotator done */}
                      {isSpatialDone && step.point_hint ? (
                        <span style={{ fontSize: '0.75rem', color: '#fbbf24', fontWeight: 600 }}>
                          📍 {step.point_hint}
                        </span>
                      ) : !isSpatialDone ? (
                        <span style={{ fontSize: '0.7rem', color: '#52525b', fontStyle: 'italic' }}>
                          Detecting coordinates...
                        </span>
                      ) : null}
                    </div>

                    {/* Instruction */}
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#ffffff', lineHeight: 1.35 }}>
                      {displayInstruction}
                    </div>

                    {/* Why Reasoning: Show ONLY if Why Extractor done */}
                    {isWhyDone && displayWhy ? (
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
                        <strong style={{ color: '#fbbf24' }}>Why: </strong>
                        {displayWhy}
                      </div>
                    ) : !isWhyDone ? (
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: '#71717a',
                          backgroundColor: '#1f1f23',
                          padding: '0.4rem 0.6rem',
                          borderRadius: '0.4rem',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                          fontStyle: 'italic',
                        }}
                      >
                        <Sparkles size={12} style={{ color: '#fbbf24' }} />
                        <span>Extracting craftsman rationale...</span>
                      </div>
                    ) : null}
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
