import { describe, it, expect } from 'vitest';
import { buildLiveSystemInstruction, cleanTranscript } from './prompt';
import type { Skill } from '../../../../../shared/schema/ts/skills';
import seedSkill from '../../../../../shared/seed/skill_terminal_wiring_v1.json';

const typedSeedSkill = seedSkill as unknown as Skill;

describe('buildLiveSystemInstruction', () => {
  it('includes craftsman persona, 15-word constraint, and target language restriction for Hindi', () => {
    const prompt = buildLiveSystemInstruction(typedSeedSkill, 'hi');

    expect(prompt).toContain('You are TAKUMI, a patient senior craftsman');
    expect(prompt).toContain('Hindi (हिन्दी)');
    expect(prompt).toContain('at most 15 words per utterance');
  });

  it('includes strict operational rules for verification and camera events', () => {
    const prompt = buildLiveSystemInstruction(typedSeedSkill, 'en');

    expect(prompt).toContain(
      'Only verify_step results or [CAMERA EVENT] messages decide that a step is done; never decide it from your own view of the video.'
    );
    expect(prompt).toContain(
      'React to [CAMERA EVENT] messages immediately, without waiting for the trainee to speak.'
    );
    expect(prompt).toContain(
      "Never repeat a verified step; when the trainee asks why, explain using the master's words."
    );
    expect(prompt).toContain(
      'When the trainee says they are done, call verify_step for the current step.'
    );
    expect(prompt).toContain(
      'When verify_step returns passed=true: give one short sentence of praise and announce the next step. When passed=false and visible=true: say the fix in one sentence. When visible=false: ask the trainee to hold the camera steady and move their hands out of the way. Never read the raw result aloud.'
    );
    expect(prompt).toContain(
      'When the trainee seems unsure where to act, call point_at with a short visual target.'
    );
    expect(prompt).toContain(
      "When point_at returns a result, say one short sentence like 'Look at the yellow circle.'"
    );
  });

  it('includes all 4 steps from seed lesson with localized Hindi instructions and master why reasoning', () => {
    const prompt = buildLiveSystemInstruction(typedSeedSkill, 'hi');

    expect(prompt).toContain('LESSON: Wire a DIN-rail terminal block');
    expect(prompt).toContain('Total Steps: 4');

    // Step 1 localized in Hindi
    expect(prompt).toContain('--- STEP 1 ---');
    expect(prompt).toContain('नीले तार को टर्मिनल 1 में डालें और उसके स्क्रू को कसें।');
    expect(prompt).toContain(
      'A blue wire\'s ferrule enters terminal 1, the leftmost terminal.'
    );
    expect(prompt).toContain(
      'IEC रंग कोड के अनुसार टर्मिनल 1 न्यूट्रल है। गलत तार लगाने पर निरीक्षण विफल होगा; फेरूल तारों को बिखरने से रोकता है।'
    );

    // Step 2 localized in Hindi
    expect(prompt).toContain('--- STEP 2 ---');
    expect(prompt).toContain('भूरे तार को टर्मिनल 2 में डालें और उसके स्क्रू को कसें।');

    // Step 3 localized in Hindi
    expect(prompt).toContain('--- STEP 3 ---');
    expect(prompt).toContain('काले तार को टर्मिनल 3 में डालें और उसके स्क्रू को कसें।');

    // Step 4 localized in Hindi
    expect(prompt).toContain('--- STEP 4 ---');
    expect(prompt).toContain('स्लेटी तार को टर्मिनल 4 में डालें और उसके स्क्रू को कसें।');
  });

  it('includes session continuity instructions when session is resumed at step 3', () => {
    const prompt = buildLiveSystemInstruction(typedSeedSkill, 'hi', {
      currentStep: 3,
      resumed: true,
    });

    expect(prompt).toContain('SESSION CONTINUITY (RECONNECTED SESSION):');
    expect(prompt).toContain(
      'This session is resuming after a brief reconnection. Steps 1 through 2 are ALREADY VERIFIED and complete.'
    );
    expect(prompt).toContain(
      'Do NOT greet the trainee again. Do NOT restart from step 1 under any circumstances.'
    );
    expect(prompt).toContain(
      'Immediately resume coaching directly at step 3: "काले तार को टर्मिनल 3 में डालें और उसके स्क्रू को कसें।".'
    );
  });

  it('handles fallback translation note when a language is not present in translations', () => {
    const prompt = buildLiveSystemInstruction(typedSeedSkill, 'id');

    expect(prompt).toContain('Bahasa Indonesia');
    expect(prompt).toContain('(Translate live into Indonesian)');
  });
});

describe('cleanTranscript', () => {
  it('strips <no speech> and {pause} tags and normalizes whitespace', () => {
    const raw = '  <no speech> Hello world   {pause}  how are you? <NO SPEECH>  ';
    const cleaned = cleanTranscript(raw);
    expect(cleaned).toBe('Hello world how are you?');
  });

  it('handles empty or whitespace-only strings', () => {
    expect(cleanTranscript('')).toBe('');
    expect(cleanTranscript('   ')).toBe('');
    expect(cleanTranscript('<no speech>{pause}')).toBe('');
  });
});
