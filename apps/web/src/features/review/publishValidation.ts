import type { Skill } from '../../../../../shared/schema/ts/skills.ts';

export const SUBJ_WORDS = ['properly', 'correctly', 'carefully', 'well', 'safely', 'thoroughly'];

export interface ValidationIssue {
  step?: number;
  field: string;
  message: string;
}

export interface ValidationResult {
  isValid: boolean;
  issues: ValidationIssue[];
  missingFieldsByStep: Record<number, string[]>;
}

/**
 * Validates a skill before publishing according to /shared/schema/skills.json
 * and TAKUMI business rules:
 * 1. video_uri pointing to H.264/AAC MP4.
 * 2. Every step must have:
 *    - clip.start_s < clip.end_s within video duration (start_s >= 0)
 *    - why plus why_source (t_start, t_end where 0 <= t_start <= t_end), unless why_inferred is true
 *    - success_criteria with visible facts only (no subjective words)
 *    - at least 1 common_mistakes entry with non-empty visual_cue
 *    - point_hint
 *    - translations for at least 'vi' and 'hi' (instruction and why)
 * 3. Skill-level safety_rules with visible facts only.
 * A written work instruction (no capture behind it) has no video, so the video, clip and interview
 * timestamp rules apply only to instructions made from a recording.
 */
export function validateSkillForPublish(skill: Skill, videoDuration?: number): ValidationResult {
  const issues: ValidationIssue[] = [];
  const missingFieldsByStep: Record<number, string[]> = {};
  const recorded = Boolean(skill.capture_id);

  const addStepIssue = (stepNum: number, field: string, message: string) => {
    issues.push({ step: stepNum, field, message });
    if (!missingFieldsByStep[stepNum]) {
      missingFieldsByStep[stepNum] = [];
    }
    missingFieldsByStep[stepNum].push(field);
  };

  // Top level checks
  if (!skill.id || !skill.id.trim()) {
    issues.push({ field: 'id', message: 'Skill ID is required.' });
  }

  if (!skill.title || !skill.title.trim()) {
    issues.push({ field: 'title', message: 'Skill title is required.' });
  }

  if (!skill.master?.display_name || !skill.master?.role) {
    issues.push({ field: 'master', message: 'Master display name and role are required.' });
  }

  if (recorded && (!skill.video_uri || (!skill.video_uri.endsWith('.mp4') && !skill.video_uri.includes('.mp4?')))) {
    issues.push({
      field: 'video_uri',
      message: 'Video URI must point to the transcoded master MP4 (captures/{id}/master.mp4).',
    });
  }

  // Safety rules
  if (!skill.safety_rules || skill.safety_rules.length === 0) {
    issues.push({
      field: 'safety_rules',
      message: 'At least one safety rule is required.',
    });
  } else {
    skill.safety_rules.forEach((rule, idx) => {
      const lower = rule.toLowerCase();
      const foundSubj = SUBJ_WORDS.find((w) => lower.includes(w));
      if (foundSubj) {
        issues.push({
          field: `safety_rules[${idx}]`,
          message: `Safety rule "${rule}" contains subjective word "${foundSubj}". State visible facts only.`,
        });
      }
    });
  }

  // Steps validation
  if (!skill.steps || skill.steps.length === 0) {
    issues.push({ field: 'steps', message: 'The work instruction must contain at least one step.' });
    return {
      isValid: false,
      issues,
      missingFieldsByStep,
    };
  }

  skill.steps.forEach((step) => {
    const n = step.n;

    // 1. Clip validation (instructions made from a recording only)
    if (!recorded) {
      // written instruction: no video to clip
    } else if (!step.clip) {
      addStepIssue(n, 'clip', `Step ${n}: Missing video clip range (clip.start_s and clip.end_s).`);
    } else {
      const { start_s, end_s } = step.clip;
      if (typeof start_s !== 'number' || typeof end_s !== 'number') {
        addStepIssue(n, 'clip', `Step ${n}: Clip start_s and end_s must be numeric.`);
      } else if (start_s < 0) {
        addStepIssue(n, 'clip', `Step ${n}: Clip start (${start_s}s) cannot be negative.`);
      } else if (start_s >= end_s) {
        addStepIssue(n, 'clip', `Step ${n}: Clip start (${start_s}s) must be less than clip end (${end_s}s).`);
      } else if (videoDuration && videoDuration > 0 && end_s > videoDuration + 1.0) {
        addStepIssue(
          n,
          'clip',
          `Step ${n}: Clip end (${end_s}s) exceeds total video duration (${videoDuration.toFixed(1)}s).`
        );
      }
    }

    // 2. Why & why_source
    if (!step.why || !step.why.trim()) {
      addStepIssue(n, 'why', `Step ${n}: Missing the reason for this step ("why").`);
    }

    // A reason the model inferred (not said by the master) is labelled as such and has no timestamps.
    if (!step.why_source) {
      if (recorded && !step.why_inferred) {
        addStepIssue(n, 'why_source', `Step ${n}: Missing "why_source" interview timestamps.`);
      }
    } else {
      const { t_start, t_end } = step.why_source;
      if (typeof t_start !== 'number' || typeof t_end !== 'number' || t_start < 0 || t_start > t_end) {
        addStepIssue(n, 'why_source', `Step ${n}: Invalid "why_source" timestamps (0 <= t_start <= t_end required).`);
      }
    }

    // 3. Success criteria (visible facts, no subjective words)
    if (!step.success_criteria || !step.success_criteria.trim()) {
      addStepIssue(n, 'success_criteria', `Step ${n}: Missing camera success criteria.`);
    } else {
      const lower = step.success_criteria.toLowerCase();
      const foundSubj = SUBJ_WORDS.find((w) => lower.includes(w));
      if (foundSubj) {
        addStepIssue(
          n,
          'success_criteria',
          `Step ${n}: Success criteria contains subjective word "${foundSubj}". State visible facts only.`
        );
      }
    }

    // 4. Common mistakes with visual cue
    if (!step.common_mistakes || step.common_mistakes.length === 0) {
      addStepIssue(n, 'common_mistakes', `Step ${n}: Must have at least 1 common mistake.`);
    } else {
      const hasValidMistake = step.common_mistakes.some(
        (m) => m && m.description?.trim() && m.visual_cue?.trim()
      );
      if (!hasValidMistake) {
        addStepIssue(
          n,
          'common_mistakes',
          `Step ${n}: Common mistakes must include at least one item with a non-empty visual_cue.`
        );
      }
    }

    // 5. Point hint
    if (!step.point_hint || !step.point_hint.trim()) {
      addStepIssue(n, 'point_hint', `Step ${n}: Missing "point_hint" guidance.`);
    }

    // 6. Translations for vi and hi
    if (!step.translations) {
      addStepIssue(n, 'translations', `Step ${n}: Missing translations (both 'vi' and 'hi' are required).`);
    } else {
      const vi = step.translations.vi;
      if (!vi || !vi.instruction?.trim() || !vi.why?.trim()) {
        addStepIssue(n, 'translations.vi', `Step ${n}: Incomplete Vietnamese (vi) translation (both instruction & why required).`);
      }

      const hi = step.translations.hi;
      if (!hi || !hi.instruction?.trim() || !hi.why?.trim()) {
        addStepIssue(n, 'translations.hi', `Step ${n}: Incomplete Hindi (hi) translation (both instruction & why required).`);
      }
    }
  });

  return {
    isValid: issues.length === 0,
    issues,
    missingFieldsByStep,
  };
}
