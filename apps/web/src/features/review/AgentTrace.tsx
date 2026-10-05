import React, { useState, useEffect } from 'react';
import { collection, query, orderBy, onSnapshot, doc, getDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import {
  Sparkles,
  CheckCircle2,
  Clock,
  ArrowRight,
  Video,
  Layers,
  FileCheck,
  Languages,
  Image as ImageIcon,
  AlertTriangle,
  Play,
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

export const AgentTrace: React.FC<AgentTraceProps> = ({ jobId, onNavigateToReview }) => {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [activeAgent, setActiveAgent] = useState<string>('segmenter');
  const [completedAgents, setCompletedAgents] = useState<Set<string>>(new Set());
  const [skillId, setSkillId] = useState<string>('');
  const [jobStatus, setJobStatus] = useState<'queued' | 'running' | 'done' | 'failed'>('running');
  const [steps, setSteps] = useState<AssembledStep[]>([]);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');

  // Stream live events from Firestore onSnapshot (no polling!)
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
        if (data.steps) {
          setSteps(data.steps as AssembledStep[]);
        }
      }
    });
    return () => unsub();
  }, [skillId]);

  // Fallback demo data if loading offline
  const displaySteps =
    steps.length > 0
      ? steps
      : [
          {
            n: 1,
            instruction: 'Insert the blue wire into terminal 1 and tighten its screw',
            why: 'Terminal 1 is neutral under IEC colour code. Swapping it fails inspection.',
            success_criteria: 'A blue wire enters terminal 1; no copper visible',
            point_hint: 'the screw opening of terminal 1',
          },
          {
            n: 2,
            instruction: 'Insert the brown wire into terminal 2 and tighten its screw',
            why: 'Terminal 2 is line conductor 1. Placing it in the wrong terminal fails inspection.',
            success_criteria: 'A brown wire enters terminal 2',
            point_hint: 'the screw opening of terminal 2',
          },
          {
            n: 3,
            instruction: 'Insert the black wire into terminal 3 and tighten its screw',
            why: 'Terminal 3 is line conductor 2. Phase order prevents motor reversal.',
            success_criteria: 'A black wire enters terminal 3',
            point_hint: 'the screw opening of terminal 3',
          },
        ];

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
          padding: '1rem 2rem',
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
              padding: '0.4rem 0.85rem',
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
          <span style={{ color: '#a1a1aa', fontSize: '0.9rem' }}>
            Job: <code style={{ color: '#ffffff' }}>{jobId}</code>
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
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
                padding: '0.6rem 1.25rem',
                borderRadius: '0.75rem',
                fontWeight: 700,
                fontSize: '0.95rem',
                cursor: 'pointer',
                boxShadow: '0 4px 14px rgba(16, 185, 129, 0.4)',
              }}
            >
              <span>Review Lesson</span>
              <ArrowRight size={18} />
            </button>
          )}
        </div>
      </header>

      {/* 3-Column Layout */}
      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '320px 1fr 380px',
          height: 'calc(100vh - 65px)',
          overflow: 'hidden',
        }}
      >
        {/* LEFT COLUMN: Master Video & Clip Timeline */}
        <section
          style={{
            borderRight: '1px solid #27272a',
            padding: '1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
            overflowY: 'auto',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#fbbf24', fontWeight: 700 }}>
            <Video size={18} />
            <span>Master Recording</span>
          </div>

          <div
            style={{
              width: '100%',
              aspectRatio: '16/9',
              backgroundColor: '#18181b',
              borderRadius: '0.75rem',
              border: '1px solid #27272a',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#71717a',
            }}
          >
            <Video size={36} style={{ marginBottom: '0.5rem', opacity: 0.5 }} />
            <span style={{ fontSize: '0.85rem' }}>1280x720 30 FPS WebM</span>
          </div>

          <div style={{ marginTop: '0.5rem' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#a1a1aa', marginBottom: '0.75rem' }}>
              Segmented Clip Markers
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {displaySteps.map((s) => (
                <div
                  key={s.n}
                  style={{
                    backgroundColor: '#18181b',
                    border: '1px solid #27272a',
                    borderRadius: '0.5rem',
                    padding: '0.6rem 0.75rem',
                    fontSize: '0.85rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#d4d4d8', fontWeight: 600 }}>
                    <span>Step {s.n}</span>
                    <span style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }}>
                      {10 + s.n * 12}s - {22 + s.n * 12}s
                    </span>
                  </div>
                  <div style={{ color: '#71717a', fontSize: '0.75rem', marginTop: '0.25rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.instruction}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CENTER COLUMN: Live Agent Graph with Glowing State & Findings */}
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
              ADK 2.0 Multi-Agent Pipeline
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}>
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
                      borderRadius: '0.875rem',
                      border: isRunning
                        ? '2px solid #f59e0b'
                        : isDone
                        ? '1px solid #10b981'
                        : '1px solid #27272a',
                      padding: '1rem 1.25rem',
                      boxShadow: isRunning ? '0 0 25px rgba(245, 158, 11, 0.25)' : 'none',
                      transition: 'all 0.2s ease-in-out',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <div
                          style={{
                            padding: '0.5rem',
                            borderRadius: '0.5rem',
                            backgroundColor: isDone ? 'rgba(16, 185, 129, 0.15)' : 'rgba(39, 39, 42, 0.8)',
                            color: isDone ? '#34d399' : isRunning ? '#fbbf24' : '#a1a1aa',
                          }}
                        >
                          <Icon size={20} />
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, color: '#ffffff', fontSize: '1rem' }}>
                            {node.name}
                          </div>
                          <div style={{ fontSize: '0.8rem', color: '#71717a' }}>{node.desc}</div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {durationMs !== undefined && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: '#a1a1aa', fontSize: '0.8rem' }}>
                            <Clock size={14} />
                            <span>{durationMs}ms</span>
                          </div>
                        )}
                        {isDone ? (
                          <CheckCircle2 size={20} color="#10b981" />
                        ) : isRunning ? (
                          <div
                            style={{
                              width: '12px',
                              height: '12px',
                              borderRadius: '50%',
                              backgroundColor: '#f59e0b',
                              boxShadow: '0 0 10px #f59e0b',
                            }}
                          />
                        ) : (
                          <span style={{ fontSize: '0.75rem', color: '#52525b', fontWeight: 600 }}>QUEUED</span>
                        )}
                      </div>
                    </div>

                    <div
                      style={{
                        marginTop: '0.5rem',
                        backgroundColor: '#09090b',
                        padding: '0.5rem 0.75rem',
                        borderRadius: '0.5rem',
                        fontSize: '0.85rem',
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

        {/* RIGHT COLUMN: Live Assembling Lesson Cards */}
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
            <div style={{ fontWeight: 700, color: '#ffffff', fontSize: '1rem' }}>Live Assembled Lesson</div>
            <select
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
              style={{
                backgroundColor: '#27272a',
                border: '1px solid #3f3f46',
                color: '#ffffff',
                borderRadius: '0.35rem',
                padding: '0.25rem 0.5rem',
                fontSize: '0.8rem',
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

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {displaySteps.map((step) => {
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
                    padding: '1rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span
                      style={{
                        backgroundColor: '#f59e0b',
                        color: '#000000',
                        fontWeight: 800,
                        fontSize: '0.75rem',
                        padding: '0.2rem 0.5rem',
                        borderRadius: '0.35rem',
                      }}
                    >
                      STEP {step.n}
                    </span>
                    {step.point_hint && (
                      <span style={{ fontSize: '0.75rem', color: '#fbbf24' }}>
                        📍 {step.point_hint}
                      </span>
                    )}
                  </div>

                  <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#ffffff', lineHeight: 1.3 }}>
                    {displayInstruction}
                  </div>

                  {displayWhy && (
                    <div
                      style={{
                        fontSize: '0.85rem',
                        color: '#a1a1aa',
                        backgroundColor: '#27272a',
                        padding: '0.5rem 0.65rem',
                        borderRadius: '0.5rem',
                        lineHeight: 1.35,
                      }}
                    >
                      <strong style={{ color: '#fbbf24' }}>Why: </strong>
                      {displayWhy}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
};
