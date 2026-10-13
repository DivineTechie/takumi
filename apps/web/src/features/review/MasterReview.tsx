import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { doc, getDoc, updateDoc, collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { regenerateStepPart, ApiError, type RegeneratePart } from '../../lib/api';
import {
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  RotateCw,
  Trash2,
  ArrowUp,
  ArrowDown,
  ShieldAlert,
  Send,
  Languages,
  Wrench,
  AlertOctagon,
  Clock,
  MapPin,
  Eye,
  Film,
} from 'lucide-react';
import type { Skill } from '../../../../../shared/schema/ts/skills.ts';
import { validateSkillForPublish, ValidationResult } from './publishValidation';
import { useI18n } from '../../i18n';

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
  suggested_success_criteria?: string;
  source?: 'traceback' | 'supervisor';
  unit_id?: string | null;
  status: 'open' | 'applied' | 'dismissed';
}

export const MasterReview: React.FC<MasterReviewProps> = ({ skillId: propSkillId, onPublished }) => {
  const { skillId: routeSkillId } = useParams<{ skillId: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const tf = (key: string, fallback: string, params?: Record<string, string | number>) => {
    const text = t(key, params);
    return text === key ? fallback : text;
  };
  const skillId = propSkillId || routeSkillId || '';
  const [skill, setSkill] = useState<Skill | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  const [activeLang, setActiveLang] = useState<string>('en');
  const [reviewRequests, setReviewRequests] = useState<ReviewRequestItem[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [publishSuccess, setPublishSuccess] = useState(false);
  const [regeneratingStep, setRegeneratingStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [videoDuration] = useState<number>(() => {
    const cached =
      sessionStorage.getItem(`takumi_duration_${skillId}`) ||
      sessionStorage.getItem('takumi_last_duration');
    return cached ? parseFloat(cached) : 0;
  });

  // Load skill document from Firestore
  useEffect(() => {
    if (!skillId) return;

    const skillRef = doc(db, 'skills', skillId);
    getDoc(skillRef)
      .then((snap) => {
        if (snap.exists()) {
          setSkill(snap.data() as Skill);
          setLoadState('ready');
        } else {
          setLoadState('not_found');
        }
      })
      .catch((err) => {
        console.warn('Could not load the lesson:', err);
        setLoadState('error');
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

  // Compute validation against strict schema and publish requirements
  const validation: ValidationResult = useMemo(() => {
    if (!skill) return { isValid: false, issues: [], missingFieldsByStep: {} };
    return validateSkillForPublish(skill, videoDuration);
  }, [skill, videoDuration]);

  if (loadState !== 'ready' || !skill) {
    return (
      <div
        role={loadState === 'loading' ? 'status' : 'alert'}
        style={{
          minHeight: '100vh',
          backgroundColor: '#09090b',
          color: '#ffffff',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.75rem',
          padding: '1rem',
          textAlign: 'center',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        {loadState === 'loading' && <span>{t('app.review_loading')}</span>}
        {loadState === 'not_found' && <span>{tf('app.review_not_found', 'This lesson could not be found.')}</span>}
        {loadState === 'error' && (
          <>
            <strong>{t('app.route_error_title')}</strong>
            <span style={{ color: '#a1a1aa' }}>{t('app.route_error_desc')}</span>
          </>
        )}
        {loadState !== 'loading' && (
          <button
            type="button"
            onClick={() => navigate('/library')}
            style={{
              backgroundColor: '#27272a',
              color: '#ffffff',
              border: '1px solid #3f3f46',
              borderRadius: '0.5rem',
              padding: '0.6rem 1.2rem',
              minHeight: '44px',
              cursor: 'pointer',
            }}
          >
            {t('back')}
          </button>
        )}
      </div>
    );
  }

  // Step mutation helpers
  const handleUpdateStepField = (stepIdx: number, field: string, val: string) => {
    const updated = { ...skill, steps: [...skill.steps] };
    const stepObj = { ...updated.steps[stepIdx] };

    if (activeLang !== 'en' && (field === 'instruction' || field === 'why')) {
      const translations = { ...(stepObj.translations || {}) };
      const currentTr = translations[activeLang] || {
        instruction: stepObj.instruction,
        why: stepObj.why,
      };
      translations[activeLang] = { ...currentTr, [field]: val };
      stepObj.translations = translations;
    } else {
      (stepObj as Record<string, unknown>)[field] = val;
    }

    updated.steps[stepIdx] = stepObj;
    setSkill(updated);
  };

  /** Applies a review request to the step with the same number (base language) and records the decision. */
  const handleReviewRequest = async (rr: ReviewRequestItem, decision: 'applied' | 'dismissed') => {
    if (decision === 'applied') {
      const idx = skill.steps.findIndex((st) => st.n === rr.step);
      if (idx < 0) return;
      const updated = { ...skill, steps: [...skill.steps] };
      updated.steps[idx] = {
        ...updated.steps[idx],
        instruction: rr.suggested_instruction,
        ...(rr.suggested_success_criteria ? { success_criteria: rr.suggested_success_criteria } : {}),
      };
      setSkill(updated);
      try {
        // The master's Apply is the approval: save the step now so the change is not lost.
        await updateDoc(doc(db, 'skills', skill.id), { steps: updated.steps });
      } catch (err) {
        console.warn('Failed to save the applied step:', err);
        return;
      }
    }
    try {
      await updateDoc(doc(db, 'review_requests', rr.id), { status: decision });
      setReviewRequests((prev) => prev.filter((x) => x.id !== rr.id));
    } catch (err) {
      console.warn('Failed to record review request decision:', err);
    }
  };

  const handleUpdateClip = (stepIdx: number, subfield: 'start_s' | 'end_s', val: number) => {
    const updated = { ...skill, steps: [...skill.steps] };
    const stepObj = { ...updated.steps[stepIdx] };
    const clip = { ...(stepObj.clip || { start_s: 0, end_s: 10 }) };
    clip[subfield] = val;
    stepObj.clip = clip;
    updated.steps[stepIdx] = stepObj;
    setSkill(updated);
  };

  const handleUpdateWhySource = (stepIdx: number, subfield: 't_start' | 't_end', val: number) => {
    const updated = { ...skill, steps: [...skill.steps] };
    const stepObj = { ...updated.steps[stepIdx] };
    const whySource = { ...(stepObj.why_source || { t_start: 0, t_end: 10 }) };
    whySource[subfield] = val;
    stepObj.why_source = whySource;
    updated.steps[stepIdx] = stepObj;
    setSkill(updated);
  };

  const handleUpdateCommonMistake = (
    stepIdx: number,
    mistakeIdx: number,
    subfield: 'description' | 'visual_cue',
    val: string
  ) => {
    const updated = { ...skill, steps: [...skill.steps] };
    const stepObj = { ...updated.steps[stepIdx] };
    const mistakes = [...(stepObj.common_mistakes || [])];
    if (!mistakes[mistakeIdx]) {
      mistakes[mistakeIdx] = { description: '', visual_cue: '' };
    }
    mistakes[mistakeIdx] = { ...mistakes[mistakeIdx], [subfield]: val };
    stepObj.common_mistakes = mistakes;
    updated.steps[stepIdx] = stepObj;
    setSkill(updated);
  };

  const handleUpdatePointHint = (stepIdx: number, val: string) => {
    const updated = { ...skill, steps: [...skill.steps] };
    const stepObj = { ...updated.steps[stepIdx] };
    stepObj.point_hint = val;
    updated.steps[stepIdx] = stepObj;
    setSkill(updated);
  };

  const handleUpdateSafetyRule = (ruleIdx: number, val: string) => {
    const updated = { ...skill };
    const rules = [...(updated.safety_rules || [])];
    rules[ruleIdx] = val;
    updated.safety_rules = rules;
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

  /** Asks Gemini for a new version of one part of a step and puts it, with its translations, into the editor. */
  const handleRegeneratePart = async (n: number, part: RegeneratePart) => {
    setRegeneratingStep(n);
    setError(null);
    try {
      const result = await regenerateStepPart(skill.id, n, part);
      setSkill((current) => {
        if (!current) return current;
        const steps = current.steps.map((s) => {
          if (s.n !== n) return s;
          const translations = { ...(s.translations || {}) };
          for (const [lang, text] of Object.entries(result.translations)) {
            if (translations[lang]) translations[lang] = { ...translations[lang], [part]: text };
          }
          return { ...s, [part]: result.text, translations };
        });
        return { ...current, steps };
      });
    } catch (e: unknown) {
      console.warn('Regenerate failed:', e instanceof ApiError ? `${e.status} ${e.message}` : e);
      setError(tf('app.review_regenerate_failed', `Could not regenerate step ${n}. Please try again.`, { n }));
    } finally {
      setRegeneratingStep(null);
    }
  };

  const handlePublish = async () => {
    if (!validation.isValid) {
      setError(t('app.review_cannot_publish', { count: validation.issues.length }));
      return;
    }

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
        safety_rules: updatedSkill.safety_rules,
        video_uri: updatedSkill.video_uri,
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
      setError(t('app.review_publish_failed', { message: msg }));
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
      <div style={{ maxWidth: '880px', margin: '0 auto' }}>
        {/* Top Header */}
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #27272a',
            paddingBottom: '1.25rem',
            marginBottom: '1.5rem',
            flexWrap: 'wrap',
            gap: '1rem',
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
              <span>TAKUMI 匠 · {t('app.review_eyebrow')}</span>
            </div>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: 0, color: '#ffffff' }}>
              {skill.title}
            </h1>
            <div style={{ color: '#a1a1aa', fontSize: '0.85rem', marginTop: '0.25rem' }}>
              {t('app.library_master_label')} <strong style={{ color: '#d4d4d8' }}>{skill.master.display_name}</strong> ({skill.master.role}){skill.video_uri && (<> · {t('app.review_video_label')} <code style={{ color: '#fbbf24', fontSize: '0.8rem' }}>{skill.video_uri.split('/').pop()}</code></>)}
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
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
                  outline: 'none',
                  fontSize: '0.85rem',
                  fontWeight: 600,
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
              disabled={publishing || publishSuccess || !validation.isValid}
              title={!validation.isValid ? t('app.review_publish_blocked_title') : t('app.review_publish_title')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                backgroundColor: publishSuccess
                  ? '#10b981'
                  : validation.isValid
                  ? '#f59e0b'
                  : '#3f3f46',
                color: publishSuccess || !validation.isValid ? '#ffffff' : '#000000',
                border: 'none',
                borderRadius: '0.75rem',
                padding: '0.75rem 1.5rem',
                fontSize: '1rem',
                fontWeight: 800,
                cursor: publishing || !validation.isValid ? 'not-allowed' : 'pointer',
                opacity: !validation.isValid ? 0.6 : 1,
                boxShadow: validation.isValid ? '0 4px 15px rgba(245, 158, 11, 0.3)' : 'none',
                transition: 'all 0.2s ease',
              }}
            >
              {publishSuccess ? (
                <>
                  <CheckCircle2 size={18} />
                  <span>{t('app.review_published')}</span>
                </>
              ) : (
                <>
                  <Send size={18} />
                  <span>{publishing ? t('app.review_publishing') : skill.status === 'published' ? t('app.review_publish_changes') : t('app.review_publish_btn')}</span>
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

        {/* Publish Validation Checklist Box */}
        <div
          style={{
            backgroundColor: validation.isValid ? 'rgba(16, 185, 129, 0.08)' : 'rgba(245, 158, 11, 0.08)',
            border: `1px solid ${validation.isValid ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
            borderRadius: '0.75rem',
            padding: '1.15rem 1.25rem',
            marginBottom: '1.5rem',
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700 }}>
              {validation.isValid ? (
                <>
                  <CheckCircle2 size={18} color="#10b981" />
                  <span style={{ color: '#10b981' }}>{t('app.review_ready')}</span>
                </>
              ) : (
                <>
                  <AlertTriangle size={18} color="#f59e0b" />
                  <span style={{ color: '#fbbf24' }}>
                    {t(
                      validation.issues.length === 1 ? 'app.review_checklist_one' : 'app.review_checklist_other',
                      { count: validation.issues.length }
                    )}
                  </span>
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <span
                style={{
                  fontSize: '0.75rem',
                  padding: '0.2rem 0.5rem',
                  borderRadius: '0.35rem',
                  backgroundColor: '#27272a',
                  color: '#a1a1aa',
                }}
              >
                {t('app.review_schema_strict')}
              </span>
              <span
                style={{
                  fontSize: '0.75rem',
                  padding: '0.2rem 0.5rem',
                  borderRadius: '0.35rem',
                  backgroundColor: '#27272a',
                  color: '#a1a1aa',
                }}
              >
                H.264 MP4 faststart
              </span>
            </div>
          </div>

          {validation.isValid ? (
            <div style={{ fontSize: '0.85rem', color: '#a7f3d0' }}>
              ✓ {t('app.review_valid_desc', { count: skill.steps.length, schema: '/shared/schema/skills.json' })}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.5rem' }}>
              <div style={{ fontSize: '0.85rem', color: '#d4d4d8', marginBottom: '0.25rem' }}>
                {t('app.review_resolve_fields')}
              </div>
              <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.85rem', color: '#fca5a5' }}>
                {validation.issues.map((iss, i) => (
                  <li key={i} style={{ marginBottom: '0.2rem' }}>
                    {iss.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Safety Rules Section (Visible facts) */}
        <div
          style={{
            backgroundColor: '#18181b',
            border: '1px solid #27272a',
            borderRadius: '0.75rem',
            padding: '1.25rem',
            marginBottom: '1.5rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#f87171', fontWeight: 700, fontSize: '0.9rem', marginBottom: '0.75rem' }}>
            <ShieldAlert size={16} />
            <span>{t('app.review_safety_rules')}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {skill.safety_rules.map((rule, rIdx) => (
              <input
                key={rIdx}
                type="text"
                value={rule}
                onChange={(e) => handleUpdateSafetyRule(rIdx, e.target.value)}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  backgroundColor: '#27272a',
                  border: '1px solid #3f3f46',
                  borderRadius: '0.4rem',
                  padding: '0.5rem 0.75rem',
                  color: '#ffffff',
                  fontSize: '0.85rem',
                  outline: 'none',
                }}
              />
            ))}
          </div>
        </div>

        {/* Open review requests (from supervisors, often via the quality trace-back agent) */}
        {reviewRequests.map((rr) => (
          <div
            key={rr.id}
            data-testid="review-request"
            style={{
              backgroundColor: 'rgba(245, 158, 11, 0.1)',
              border: '1px solid #f59e0b',
              borderRadius: '0.75rem',
              padding: '1rem 1.25rem',
              marginBottom: '1rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#fbbf24', fontWeight: 700, marginBottom: '0.5rem' }}>
              <AlertTriangle size={18} />
              <span>
                {rr.source === 'traceback'
                  ? rr.unit_id
                    ? t('app.review_request_traceback_unit', { step: rr.step, unit: rr.unit_id })
                    : t('app.review_request_traceback', { step: rr.step })
                  : t('app.review_request_title', { step: rr.step })}
              </span>
            </div>
            <div style={{ fontSize: '0.9rem', color: '#d4d4d8', marginBottom: '0.5rem' }}>{rr.reason}</div>
            <div style={{ fontSize: '0.9rem', color: '#fafafa', marginBottom: '0.75rem' }}>
              {t('app.review_suggested_instruction')} {rr.suggested_instruction}
              {rr.suggested_success_criteria && (
                <div>
                  {t('app.review_suggested_criteria')} {rr.suggested_success_criteria}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              <button
                onClick={() => handleReviewRequest(rr, 'applied')}
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
                {t('app.review_apply_to_step', { step: rr.step })}
              </button>
              <button
                onClick={() => handleReviewRequest(rr, 'dismissed')}
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
                {t('app.review_dismiss')}
              </button>
            </div>
          </div>
        ))}

        {/* Step Cards List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {skill.steps.map((step, idx) => {
            const tr = step.translations?.[activeLang];
            const currentInstruction = activeLang === 'en' ? step.instruction : tr?.instruction || step.instruction;
            const currentWhy = activeLang === 'en' ? step.why : tr?.why || step.why;
            const missingInStep = validation.missingFieldsByStep[step.n] || [];

            return (
              <div
                key={step.n}
                style={{
                  backgroundColor: '#18181b',
                  border: `1px solid ${missingInStep.length > 0 ? 'rgba(239, 68, 68, 0.4)' : '#27272a'}`,
                  borderRadius: '1rem',
                  padding: '1.5rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1rem',
                }}
              >
                {/* Step Top Bar & Reordering Controls */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
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
                      {t('app.trace_step_badge', { n: step.n })}
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
                        {t('app.review_inferred')}
                      </span>
                    )}
                    {missingInStep.length > 0 && (
                      <span
                        style={{
                          backgroundColor: 'rgba(239, 68, 68, 0.15)',
                          color: '#f87171',
                          border: '1px solid rgba(239, 68, 68, 0.3)',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          padding: '0.2rem 0.5rem',
                          borderRadius: '0.35rem',
                        }}
                      >
                        {t('app.review_needs_attention', { fields: missingInStep.join(', ') })}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <button
                      type="button"
                      title={t('app.review_move_up')}
                      aria-label={t('app.review_move_up')}
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
                      title={t('app.review_move_down')}
                      aria-label={t('app.review_move_down')}
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
                      title={t('app.review_regenerate')}
                      aria-label={t('app.review_regenerate')}
                      onClick={() => handleRegeneratePart(step.n, 'instruction')}
                      disabled={regeneratingStep !== null}
                      style={{
                        backgroundColor: '#27272a',
                        border: '1px solid #3f3f46',
                        color: '#fbbf24',
                        padding: '0.4rem',
                        borderRadius: '0.35rem',
                        cursor: regeneratingStep !== null ? 'wait' : 'pointer',
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
                      title={t('app.review_delete')}
                      aria-label={t('app.review_delete')}
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

                {/* Instruction (Editable) */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#a1a1aa', marginBottom: '0.35rem' }}>
                    {t('app.review_instruction_label', { lang: activeLang.toUpperCase() })}
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
                    {t('app.review_criteria_label')}
                  </label>
                  <input
                    type="text"
                    value={step.success_criteria}
                    onChange={(e) => handleUpdateStepField(idx, 'success_criteria', e.target.value)}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      backgroundColor: '#27272a',
                      border: `1px solid ${missingInStep.includes('success_criteria') ? '#ef4444' : '#3f3f46'}`,
                      borderRadius: '0.5rem',
                      padding: '0.65rem 0.85rem',
                      color: '#34d399',
                      fontSize: '0.9rem',
                      outline: 'none',
                    }}
                  />
                  {step.verifier?.conflict && (
                    <div
                      data-testid="verifier-flag"
                      style={{
                        marginTop: '0.4rem',
                        fontSize: '0.8rem',
                        color: '#fcd34d',
                        display: 'flex',
                        gap: '0.35rem',
                        alignItems: 'flex-start',
                      }}
                    >
                      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
                      <span>
                        {tf('app.review_verifier_flag', 'AI check: not a visible fact.')} {step.verifier.detail}
                        {step.verifier.suggestion && (
                          <>
                            {' '}
                            {t('app.review_suggested_criteria')} <em>{step.verifier.suggestion}</em>
                          </>
                        )}
                      </span>
                    </div>
                  )}
                </div>

                {/* Why Text (Editable) */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#a1a1aa', marginBottom: '0.35rem' }}>
                    {t('app.review_why_label', { lang: activeLang.toUpperCase() })}
                  </label>
                  <textarea
                    rows={2}
                    value={currentWhy}
                    onChange={(e) => handleUpdateStepField(idx, 'why', e.target.value)}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      backgroundColor: '#27272a',
                      border: `1px solid ${missingInStep.includes('why') ? '#ef4444' : '#3f3f46'}`,
                      borderRadius: '0.5rem',
                      padding: '0.65rem 0.85rem',
                      color: '#fbbf24',
                      fontSize: '0.9rem',
                      outline: 'none',
                      resize: 'vertical',
                    }}
                  />
                </div>

                {/* Point Hint Guidance (Editable) */}
                <div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', fontWeight: 600, color: '#a1a1aa', marginBottom: '0.35rem' }}>
                    <MapPin size={14} color="#fbbf24" />
                    <span>{t('app.review_point_label')}</span>
                  </label>
                  <input
                    type="text"
                    value={step.point_hint || ''}
                    placeholder={t('app.review_point_placeholder')}
                    onChange={(e) => handleUpdatePointHint(idx, e.target.value)}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      backgroundColor: '#27272a',
                      border: `1px solid ${missingInStep.includes('point_hint') ? '#ef4444' : '#3f3f46'}`,
                      borderRadius: '0.5rem',
                      padding: '0.5rem 0.75rem',
                      color: '#fbbf24',
                      fontSize: '0.85rem',
                      outline: 'none',
                    }}
                  />
                </div>

                {/* Video Clip Range & Why Source Timing Inputs */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
                  <div style={{ backgroundColor: '#27272a', padding: '0.75rem', borderRadius: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#60a5fa', fontWeight: 600, fontSize: '0.8rem', marginBottom: '0.4rem' }}>
                      <Film size={14} />
                      <span>{t('app.review_clip_range')}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={step.clip?.start_s ?? 0}
                        onChange={(e) => handleUpdateClip(idx, 'start_s', parseFloat(e.target.value) || 0)}
                        style={{
                          width: '80px',
                          backgroundColor: '#18181b',
                          border: '1px solid #3f3f46',
                          borderRadius: '0.35rem',
                          color: '#ffffff',
                          padding: '0.3rem 0.5rem',
                          fontSize: '0.85rem',
                        }}
                      />
                      <span style={{ color: '#a1a1aa' }}>{t('app.review_range_to')}</span>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={step.clip?.end_s ?? 10}
                        onChange={(e) => handleUpdateClip(idx, 'end_s', parseFloat(e.target.value) || 0)}
                        style={{
                          width: '80px',
                          backgroundColor: '#18181b',
                          border: '1px solid #3f3f46',
                          borderRadius: '0.35rem',
                          color: '#ffffff',
                          padding: '0.3rem 0.5rem',
                          fontSize: '0.85rem',
                        }}
                      />
                    </div>
                  </div>

                  <div style={{ backgroundColor: '#27272a', padding: '0.75rem', borderRadius: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#c084fc', fontWeight: 600, fontSize: '0.8rem', marginBottom: '0.4rem' }}>
                      <Clock size={14} />
                      <span>{t('app.review_why_timestamp')}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={step.why_source?.t_start ?? 0}
                        onChange={(e) => handleUpdateWhySource(idx, 't_start', parseFloat(e.target.value) || 0)}
                        style={{
                          width: '80px',
                          backgroundColor: '#18181b',
                          border: '1px solid #3f3f46',
                          borderRadius: '0.35rem',
                          color: '#ffffff',
                          padding: '0.3rem 0.5rem',
                          fontSize: '0.85rem',
                        }}
                      />
                      <span style={{ color: '#a1a1aa' }}>{t('app.review_range_to')}</span>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={step.why_source?.t_end ?? 10}
                        onChange={(e) => handleUpdateWhySource(idx, 't_end', parseFloat(e.target.value) || 0)}
                        style={{
                          width: '80px',
                          backgroundColor: '#18181b',
                          border: '1px solid #3f3f46',
                          borderRadius: '0.35rem',
                          color: '#ffffff',
                          padding: '0.3rem 0.5rem',
                          fontSize: '0.85rem',
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* Common Mistake & Visual Cue */}
                <div style={{ backgroundColor: '#27272a', padding: '0.75rem', borderRadius: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#f87171', fontWeight: 600, fontSize: '0.8rem', marginBottom: '0.4rem' }}>
                    <Eye size={14} />
                    <span>{t('app.review_mistake_label')}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    <input
                      type="text"
                      placeholder={t('app.review_mistake_placeholder')}
                      value={step.common_mistakes?.[0]?.description || ''}
                      onChange={(e) => handleUpdateCommonMistake(idx, 0, 'description', e.target.value)}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        backgroundColor: '#18181b',
                        border: '1px solid #3f3f46',
                        borderRadius: '0.35rem',
                        padding: '0.4rem 0.6rem',
                        color: '#ffffff',
                        fontSize: '0.85rem',
                      }}
                    />
                    <input
                      type="text"
                      placeholder={t('app.review_cue_placeholder')}
                      value={step.common_mistakes?.[0]?.visual_cue || ''}
                      onChange={(e) => handleUpdateCommonMistake(idx, 0, 'visual_cue', e.target.value)}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        backgroundColor: '#18181b',
                        border: `1px solid ${missingInStep.includes('common_mistakes') ? '#ef4444' : '#3f3f46'}`,
                        borderRadius: '0.35rem',
                        padding: '0.4rem 0.6rem',
                        color: '#34d399',
                        fontSize: '0.85rem',
                      }}
                    />
                  </div>
                </div>

                {/* Tools & Hazards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem', fontSize: '0.8rem' }}>
                  <div style={{ backgroundColor: '#27272a', padding: '0.6rem', borderRadius: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#a1a1aa', fontWeight: 600, marginBottom: '0.25rem' }}>
                      <Wrench size={14} />
                      <span>{t('app.review_tools')}</span>
                    </div>
                    <div style={{ color: '#ffffff' }}>
                      {step.tools.length > 0 ? step.tools.join(', ') : t('app.review_tools_none')}
                    </div>
                  </div>

                  <div style={{ backgroundColor: '#27272a', padding: '0.6rem', borderRadius: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#f87171', fontWeight: 600, marginBottom: '0.25rem' }}>
                      <AlertOctagon size={14} />
                      <span>{t('app.review_hazards')}</span>
                    </div>
                    <div style={{ color: '#ffffff' }}>
                      {step.hazards.length > 0 ? step.hazards.join(', ') : t('app.review_hazards_none')}
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
