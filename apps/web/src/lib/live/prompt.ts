import type { Skill } from '../../../../../shared/schema/ts/skills';
import type { LanguageCode } from '../../i18n';
import { LANGUAGE_DISPLAY_NAMES, type SystemInstructionOptions } from './types';

/**
 * Strips model artifacts like '<no speech>' and '{pause}', normalizes whitespace and trims.
 */
export function cleanTranscript(text: string): string {
  if (!text) return '';
  return text
    .replace(/<no\s*speech>/gi, '')
    .replace(/\{pause\}/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Builds the Gemini Live system instruction for the voice coach session.
 * Pure function, unit-tested.
 */
export function buildLiveSystemInstruction(
  skill: Skill,
  language: LanguageCode,
  options: SystemInstructionOptions = {}
): string {
  const currentStep = options.currentStep ?? 1;
  const isResumed = Boolean(options.resumed && currentStep > 1);

  const langInfo = LANGUAGE_DISPLAY_NAMES[language] || {
    native: language,
    english: language,
  };

  const lines: string[] = [];

  // 1. Role & Persona
  lines.push('You are TAKUMI, a patient senior craftsman teaching hands-on manufacturing skills.');
  lines.push(
    `You must speak ONLY in ${langInfo.english} (${langInfo.native}). Do not switch to English or other languages unless explicitly asked.`
  );
  lines.push(
    'Keep every spoken utterance concise and direct: at most 15 words per utterance. Trainees work with their hands and need short, clear guidance.'
  );
  lines.push('');

  // 2. Core Operational Rules
  lines.push('OPERATIONAL RULES:');
  lines.push(
    '- Only verify_step results or [CAMERA EVENT] messages decide that a step is done; never decide it from your own view of the video.'
  );
  lines.push(
    '- React to [CAMERA EVENT] messages immediately, without waiting for the trainee to speak.'
  );
  lines.push(
    '- Never repeat a verified step.'
  );
  lines.push(
    '- When the trainee asks why (in any language), call show_master_clip for the current step instead of explaining it yourself; after it plays, add at most one short sentence.'
  );
  lines.push(
    '- When a mistake event happens and a mistake clip exists, you may call show_mistake_clip once per step.'
  );
  lines.push(
    "- For questions about the craft that the lesson text doesn't answer, call ask_master and relay the answer in one or two short sentences, naming the master as the source."
  );
  lines.push(
    '- When the trainee says they are done, call verify_step for the current step.'
  );
  lines.push(
    '- When verify_step returns passed=true: give one short sentence of praise and announce the next step. When passed=false and visible=true: say the fix in one sentence. When visible=false: ask the trainee to hold the camera steady and move their hands out of the way. Never read the raw result aloud.'
  );
  lines.push(
    '- When the trainee seems unsure where to act, call point_at with a short visual target.'
  );
  lines.push(
    '- When point_at returns a result, say one short sentence like \'Look at the yellow circle.\''
  );
  lines.push('');

  // 3. Reconnect / Startup Flow
  if (isResumed) {
    const activeStepObj = skill.steps.find((s) => s.n === currentStep) || skill.steps[0];
    const localizedActiveInstruction =
      activeStepObj.translations?.[language]?.instruction || activeStepObj.instruction;
    lines.push('SESSION CONTINUITY (RECONNECTED SESSION):');
    lines.push(
      `This session is resuming after a brief reconnection. Steps 1 through ${currentStep - 1} are ALREADY VERIFIED and complete.`
    );
    lines.push(
      'Do NOT greet the trainee again. Do NOT restart from step 1 under any circumstances.'
    );
    lines.push(
      `Immediately resume coaching directly at step ${currentStep}: "${localizedActiveInstruction}".`
    );
  } else {
    lines.push('SESSION STARTUP:');
    lines.push(
      'Start by greeting the trainee briefly (under 10 words) and immediately announce step 1. Congratulate after the last step is completed.'
    );
  }
  lines.push('');

  // 4. Safety Rules
  if (skill.safety_rules && skill.safety_rules.length > 0) {
    lines.push('MANDATORY SAFETY RULES:');
    skill.safety_rules.forEach((rule, idx) => {
      lines.push(`${idx + 1}. ${rule}`);
    });
    lines.push('');
  }

  // 5. Standard Operating Procedure Steps
  lines.push(`LESSON: ${skill.title}`);
  lines.push(`Total Steps: ${skill.steps.length}`);
  lines.push('');

  skill.steps.forEach((step) => {
    const localized = step.translations?.[language];
    const instruction = localized?.instruction || step.instruction;
    const why = localized?.why || step.why;
    const isTranslatedLive = !localized && language !== 'en';

    lines.push(`--- STEP ${step.n} ---`);
    lines.push(`Instruction: ${instruction}${isTranslatedLive ? ' (Translate live into ' + langInfo.english + ')' : ''}`);
    lines.push(`Success Criteria: ${step.success_criteria}`);
    lines.push(`Why (Master's words): ${why}`);

    if (step.tools && step.tools.length > 0) {
      lines.push(`Tools needed: ${step.tools.join(', ')}`);
    }

    if (step.common_mistakes && step.common_mistakes.length > 0) {
      lines.push('Common mistakes to watch for:');
      step.common_mistakes.forEach((m) => {
        lines.push(`  - Mistake: ${m.description} | Visual cue: ${m.visual_cue}`);
      });
    }

    if (step.hazards && step.hazards.length > 0) {
      lines.push(`Hazards: ${step.hazards.join(', ')}`);
    }

    if (step.point_hint) {
      lines.push(`Point target hint: ${step.point_hint}`);
    }

    lines.push('');
  });

  return lines.join('\n');
}
