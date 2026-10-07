import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { doc, getDoc, updateDoc, collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { regenerateStepPart } from '../../lib/api';
import {
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  RotateCw,
  Trash2,
  ArrowUp,
  ArrowDown,
  Volume2,
  ShieldAlert,
  Send,
  Languages,
  Wrench,
  AlertOctagon,
} from 'lucide-react';
import type { Skill } from '../../../../../shared/schema/ts/skills.ts';

export interface MasterReviewProps {
  skillId?: string;
  onPublished?: (skillId: string) => void;
}

interface ReviewRequestItem {
  id: string;
  skill_id: string;
  step: number;
  reason: string;
  suggested_instruction: string;
  status: 'open' | 'applied' | 'dismissed';
}

export const MasterReview: React.FC<MasterReviewProps> = ({ skillId: propSkillId, onPublished }) => {
  const { skillId: routeSkillId } = useParams<{ skillId: string }>();
  const navigate = useNavigate();
  const skillId = propSkillId || routeSkillId || '';
  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeLang, setActiveLang] = useState<string>('en');
  const [reviewRequests, setReviewRequests] = useState<ReviewRequestItem[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [publishSuccess, setPublishSuccess] = useState(false);
  const [regeneratingStep, setRegeneratingStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load skill document from Firestore
  useEffect(() => {
    if (!skillId) return;

    const skillRef = doc(db, 'skills', skillId);
    getDoc(skillRef)
      .then((snap) => {
        if (snap.exists()) {
          setSkill(snap.data() as Skill);
        } else {
          // Use seed fallback for initial demo/testing
          import('../../../../../shared/seed/skill_terminal_wiring_v1.json').then((seed) => {
            setSkill(seed.default as unknown as Skill);
          });
        }
        setLoading(false);
      })
      .catch((err) => {
        console.warn('Could not fetch skill doc, using fallback:', err);
        import('../../../../../shared/seed/skill_terminal_wiring_v1.json').then((seed) => {
          setSkill(seed.default as unknown as Skill);
          setLoading(false);
        });
      });

    // Listen for open review requests
    try {
      const rrRef = collection(db, 'review_requests');
      const q = query(rrRef, where('skill_id', '==', skillId), where('status', '==', 'open'));
      const unsub = onSnapshot(q, (snapshot) => {
        const reqs: ReviewRequestItem[] = [];
        snapshot.forEach((d) => reqs.push({ id: d.id, ...d.data() } as ReviewRequestItem));
        setReviewRequests(reqs);
      });
      return () => unsub();
    } catch {
      // ignore offline query issues
    }
  }, [skillId]);

  if (loading || !skill) {
    return (
      <div
        style={{
          minHeight: '100vh',
          backgroundColor: '#09090b',
          color: '#ffffff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <span>Loading lesson for review...</span>
      </div>
    );
  }

  // Step mutation helpers
  const handleUpdateStepField = (stepIdx: number, field: string, val: string) => {
    const updated = { ...skill };
    (updated.steps[stepIdx] as unknown as Record<string, unknown>)[field] = val;
    setSkill(updated);
  };

  const handleMoveStep = (stepIdx: number, direction: 'up' | 'down') => {
    const targetIdx = direction === 'up' ? stepIdx - 1 : stepIdx + 1;
    if (targetIdx < 0 || targetIdx >= skill.steps.length) return;

    const updatedSteps = [...skill.steps];
    const [moved] = updatedSteps.splice(stepIdx, 1);
    updatedSteps.splice(targetIdx, 0, moved);

    // Renumber n 1..N
    updatedSteps.forEach((s, idx) => {
      s.n = idx + 1;
    });

    setSkill({ ...skill, steps: updatedSteps });
  };

  const handleDeleteStep = (stepIdx: number) => {
    if (skill.steps.length <= 1) return;
    const updatedSteps = skill.steps.filter((_, idx) => idx !== stepIdx);
    updatedSteps.forEach((s, idx) => {
      s.n = idx + 1;
    });
    setSkill({ ...skill, steps: updatedSteps });
  };

  const handleRegeneratePart = async (n: number, part: string) => {
    setRegeneratingStep(n);
    try {
      await regenerateStepPart(skill.id, n, part);
    } catch (e) {
      console.warn('Regenerate call error:', e);
    } finally {
      setTimeout(() => setRegeneratingStep(null), 800);
    }
  };

  const handlePublish = async () => {
    setPublishing(true);
    setError(null);
    try {
      const nowIso = new Date().toISOString();
      const updatedSkill: Skill = {
        ...skill,
        status: 'published',
        published_at: nowIso,
      };

      const skillRef = doc(db, 'skills', skill.id);
      await updateDoc(skillRef, {
        steps: updatedSkill.steps,
        status: 'published',
        published_at: nowIso,
      });

      setSkill(updatedSkill);
      setPublishSuccess(true);
      if (onPublished) {
        onPublished(skill.id);
      } else {
        setTimeout(() => navigate('/library'), 1200);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Failed to publish skill:', msg);
      setError(`Failed to publish: ${msg}`);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#09090b',
        color: '#f4f4f5',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '1.5rem 2rem 5rem 2rem',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ maxWidth: '860px', margin: '0 auto' }}>
        {/* Top Header */}
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #27272a',
            paddingBottom: '1.25rem',
            marginBottom: '1.5rem',
          }}
        >
          <div>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                color: '#fbbf24',
                fontSize: '0.85rem',
                fontWeight: 700,
                marginBottom: '0.35rem',
              }}
            >
              <Sparkles size={16} />
              <span>TAKUMI 匠 · Master Review</span>
            </div>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: 0, color: '#ffffff' }}>
              {skill.title}
            </h1>
            <div style={{ color: '#a1a1aa', fontSize: '0.85rem', marginTop: '0.25rem' }}>
              Master: <strong style={{ color: '#d4d4d8' }}>{skill.master.display_name}</strong> ({skill.master.role})
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {/* Language Switcher */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                backgroundColor: '#18181b',
                padding: '0.35rem 0.65rem',
                borderRadius: '0.5rem',
                border: '1px solid #27272a',
              }}
            >
              <Languages size={16} color="#fbbf24" />
              <select
                value={activeLang}
                onChange={(e) => setActiveLang(e.target.value)}
                style={{
                  backgroundColor: 'transparent',
                  color: '#ffffff',
                  border: 'none',
                  fontSize: '0.85rem',
                  outline: 'none',
                  cursor: 'pointer',
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

            {/* Publish Button */}
            <button
              onClick={handlePublish}
              disabled={publishing || publishSuccess}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                backgroundColor: publishSuccess ? '#10b981' : '#f59e0b',
                color: publishSuccess ? '#ffffff' : '#000000',
                border: 'none',
                borderRadius: '0.75rem',
                padding: '0.75rem 1.5rem',
                fontSize: '1rem',
                fontWeight: 800,
                cursor: publishing ? 'not-allowed' : 'pointer',
                boxShadow: '0 4px 15px rgba(245, 158, 11, 0.3)',
              }}
            >
              {publishSuccess ? (
                <>
                  <CheckCircle2 size={18} />
                  <span>PUBLISHED</span>
                </>
              ) : (
                <>
                  <Send size={18} />
                  <span>{publishing ? 'PUBLISHING...' : 'PUBLISH LESSON'}</span>
                </>
              )}
            </button>
          </div>
        </header>

        {error && (
          <div
            style={{
              backgroundColor: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid #ef4444',
              color: '#f87171',
              padding: '0.75rem 1rem',
              borderRadius: '0.5rem',
              marginBottom: '1.5rem',
            }}
          >
            {error}
          </div>
        )}

        {/* Review Requests from Trainee Live Coach Dashboard */}
        {reviewRequests.length > 0 && (
          <div
            style={{
              backgroundColor: 'rgba(245, 158, 11, 0.1)',
              border: '1px solid #f59e0b',
              borderRadius: '0.75rem',
              padding: '1rem 1.25rem',
              marginBottom: '1.5rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#fbbf24', fontWeight: 700, marginBottom: '0.5rem' }}>
              <AlertTriangle size={18} />
              <span>Supervisor Insight: Review Request for Step {reviewRequests[0].step}</span>
            </div>
            <div style={{ fontSize: '0.9rem', color: '#d4d4d8', marginBottom: '0.75rem' }}>
              {reviewRequests[0].reason}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => {
                  const stepIdx = reviewRequests[0].step - 1;
                  if (skill.steps[stepIdx]) {
                    handleUpdateStepField(stepIdx, 'instruction', reviewRequests[0].suggested_instruction);
                  }
                  setReviewRequests([]);
                }}
                style={{
                  backgroundColor: '#f59e0b',
                  color: '#000000',
                  border: 'none',
                  padding: '0.4rem 0.85rem',
                  borderRadius: '0.4rem',
                  fontWeight: 700,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                }}
              >
                Apply Suggestion
              </button>
              <button
                onClick={() => setReviewRequests([])}
                style={{
                  backgroundColor: '#27272a',
                  color: '#a1a1aa',
                  border: '1px solid #3f3f46',
                  padding: '0.4rem 0.85rem',
                  borderRadius: '0.4rem',
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Step Cards List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {skill.steps.map((step, idx) => {
            const tr = step.translations?.[activeLang];
            const currentInstruction = activeLang === 'en' ? step.instruction : tr?.instruction || step.instruction;
            const currentWhy = activeLang === 'en' ? step.why : tr?.why || step.why;

            return (
              <div
                key={step.n}
                style={{
                  backgroundColor: '#18181b',
                  border: '1px solid #27272a',
                  borderRadius: '1rem',
                  padding: '1.5rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1rem',
                }}
              >
                {/* Step Top Bar & Reordering Controls */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span
                      style={{
                        backgroundColor: '#f59e0b',
                        color: '#000000',
                        fontWeight: 900,
                        fontSize: '0.85rem',
                        padding: '0.3rem 0.75rem',
                        borderRadius: '0.5rem',
                      }}
                    >
                      STEP {step.n}
                    </span>
                    {step.why_inferred && (
                      <span
                        style={{
                          backgroundColor: 'rgba(168, 85, 247, 0.15)',
                          color: '#c084fc',
                          border: '1px solid rgba(168, 85, 247, 0.3)',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          padding: '0.2rem 0.5rem',
                          borderRadius: '0.35rem',
                        }}
                      >
                        Inferred Rationale
                      </span>
                    )}
                    {step.point_hint && (
                      <span style={{ fontSize: '0.85rem', color: '#fbbf24' }}>
                        📍 {step.point_hint}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <button
                      type="button"
                      title="Move Step Up"
                      onClick={() => handleMoveStep(idx, 'up')}
                      disabled={idx === 0}
                      style={{
                        backgroundColor: '#27272a',
                        border: '1px solid #3f3f46',
                        color: '#d4d4d8',
                        padding: '0.4rem',
                        borderRadius: '0.35rem',
                        cursor: idx === 0 ? 'not-allowed' : 'pointer',
                        opacity: idx === 0 ? 0.4 : 1,
                      }}
                    >
                      <ArrowUp size={16} />
                    </button>
                    <button
                      type="button"
                      title="Move Step Down"
                      onClick={() => handleMoveStep(idx, 'down')}
                      disabled={idx === skill.steps.length - 1}
                      style={{
                        backgroundColor: '#27272a',
                        border: '1px solid #3f3f46',
                        color: '#d4d4d8',
                        padding: '0.4rem',
                        borderRadius: '0.35rem',
                        cursor: idx === skill.steps.length - 1 ? 'not-allowed' : 'pointer',
                        opacity: idx === skill.steps.length - 1 ? 0.4 : 1,
                      }}
                    >
                      <ArrowDown size={16} />
                    </button>
                    <button
                      type="button"
                      title="Regenerate Step"
                      onClick={() => handleRegeneratePart(step.n, 'instruction')}
                      style={{
                        backgroundColor: '#27272a',
                        border: '1px solid #3f3f46',
                        color: '#fbbf24',
                        padding: '0.4rem',
                        borderRadius: '0.35rem',
                        cursor: 'pointer',
                      }}
                    >
                      <RotateCw
                        size={16}
                        style={{
                          animation: regeneratingStep === step.n ? 'spin 1s linear infinite' : 'none',
                        }}
                      />
                    </button>
                    <button
                      type="button"
                      title="Delete Step"
                      onClick={() => handleDeleteStep(idx)}
                      style={{
                        backgroundColor: '#27272a',
                        border: '1px solid #3f3f46',
                        color: '#f87171',
                        padding: '0.4rem',
                        borderRadius: '0.35rem',
                        cursor: 'pointer',
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                {/* Verifier Conflict Banner */}
                {step.verifier?.conflict && (
                  <div
                    style={{
                      backgroundColor: 'rgba(239, 68, 68, 0.1)',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                      borderRadius: '0.5rem',
                      padding: '0.75rem',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.75rem',
                    }}
                  >
                    <ShieldAlert size={20} color="#f87171" style={{ flexShrink: 0, marginTop: '2px' }} />
                    <div style={{ flex: 1, fontSize: '0.85rem' }}>
                      <div style={{ fontWeight: 700, color: '#f87171', marginBottom: '0.2rem' }}>
                        Safety Conflict: {step.verifier.detail} ({step.verifier.citation})
                      </div>
                      <div style={{ color: '#d4d4d8', marginBottom: '0.5rem' }}>
                        Suggestion: {step.verifier.suggestion}
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          onClick={() => {
                            handleUpdateStepField(idx, 'instruction', step.verifier!.suggestion);
                            const updated = { ...skill };
                            updated.steps[idx].verifier!.conflict = false;
                            setSkill(updated);
                          }}
                          style={{
                            backgroundColor: '#ef4444',
                            color: '#ffffff',
                            border: 'none',
                            padding: '0.3rem 0.65rem',
                            borderRadius: '0.3rem',
                            fontSize: '0.8rem',
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          Accept Suggestion
                        </button>
                        <button
                          onClick={() => {
                            const updated = { ...skill };
                            updated.steps[idx].verifier!.conflict = false;
                            setSkill(updated);
                          }}
                          style={{
                            backgroundColor: '#27272a',
                            color: '#a1a1aa',
                            border: '1px solid #3f3f46',
                            padding: '0.3rem 0.65rem',
                            borderRadius: '0.3rem',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                          }}
                        >
                          Keep Master&apos;s Version
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Instruction (Editable) */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#a1a1aa', marginBottom: '0.35rem' }}>
                    Instruction ({activeLang.toUpperCase()})
                  </label>
                  <input
                    type="text"
                    value={currentInstruction}
                    onChange={(e) => handleUpdateStepField(idx, 'instruction', e.target.value)}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      backgroundColor: '#27272a',
                      border: '1px solid #3f3f46',
                      borderRadius: '0.5rem',
                      padding: '0.65rem 0.85rem',
                      color: '#ffffff',
                      fontSize: '1rem',
                      fontWeight: 600,
                      outline: 'none',
                    }}
                  />
                </div>

                {/* Success Criteria (Visible facts - editable) */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#a1a1aa', marginBottom: '0.35rem' }}>
                    Camera Success Criteria (Visible Facts Only)
                  </label>
                  <input
                    type="text"
                    value={step.success_criteria}
                    onChange={(e) => handleUpdateStepField(idx, 'success_criteria', e.target.value)}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      backgroundColor: '#27272a',
                      border: '1px solid #3f3f46',
                      borderRadius: '0.5rem',
                      padding: '0.65rem 0.85rem',
                      color: '#34d399',
                      fontSize: '0.9rem',
                      outline: 'none',
                    }}
                  />
                </div>

                {/* Why Text (Editable) */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#a1a1aa', marginBottom: '0.35rem' }}>
                    Craftsman &ldquo;Why&rdquo; Rationale
                  </label>
                  <textarea
                    rows={2}
                    value={currentWhy}
                    onChange={(e) => handleUpdateStepField(idx, 'why', e.target.value)}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      backgroundColor: '#27272a',
                      border: '1px solid #3f3f46',
                      borderRadius: '0.5rem',
                      padding: '0.65rem 0.85rem',
                      color: '#fbbf24',
                      fontSize: '0.9rem',
                      outline: 'none',
                      resize: 'vertical',
                    }}
                  />
                </div>

                {/* Tools, Hazards, Common Mistakes Chips */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem', fontSize: '0.8rem' }}>
                  <div style={{ backgroundColor: '#27272a', padding: '0.6rem', borderRadius: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#a1a1aa', fontWeight: 600, marginBottom: '0.25rem' }}>
                      <Wrench size={14} />
                      <span>Tools</span>
                    </div>
                    <div style={{ color: '#ffffff' }}>
                      {step.tools.length > 0 ? step.tools.join(', ') : 'None specified'}
                    </div>
                  </div>

                  <div style={{ backgroundColor: '#27272a', padding: '0.6rem', borderRadius: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#f87171', fontWeight: 600, marginBottom: '0.25rem' }}>
                      <AlertOctagon size={14} />
                      <span>Hazards</span>
                    </div>
                    <div style={{ color: '#ffffff' }}>
                      {step.hazards.length > 0 ? step.hazards.join(', ') : 'No hazards flagged'}
                    </div>
                  </div>

                  <div style={{ backgroundColor: '#27272a', padding: '0.6rem', borderRadius: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#fbbf24', fontWeight: 600, marginBottom: '0.25rem' }}>
                      <Volume2 size={14} />
                      <span>Narration ({activeLang.toUpperCase()})</span>
                    </div>
                    <div style={{ color: '#34d399', fontWeight: 600 }}>
                      Audio WAV ready
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
