import { describe, it, expect } from 'vitest';
import { validateSkillForPublish } from './publishValidation';
import type { Skill } from '../../../../../shared/schema/ts/skills.ts';

const validSkill: Skill = {
  id: 'skill_cable_assembly_v1',
  title: 'Cable Lug Assembly',
  source_language: 'ja',
  languages: ['en', 'ja', 'vi', 'hi'],
  status: 'in_review',
  master: {
    display_name: 'Master Tanaka',
    role: 'Senior Electrician',
  },
  video_uri: 'gs://takumi-cup-2026.firebasestorage.app/captures/cap_123/master.mp4',
  safety_rules: [
    'Main breaker switch set to position 0',
    'Insulated gloves worn during termination',
  ],
  steps: [
    {
      n: 1,
      instruction: 'Strip 8 mm of wire jacket using precision strippers.',
      success_criteria: '8 mm of bare copper strand is exposed with zero severed strands.',
      why: 'Prevents insulation pinch in lug while maintaining dielectric boundary.',
      why_source: {
        t_start: 12.0,
        t_end: 18.5,
      },
      tools: ['wire stripper'],
      hazards: ['blade pinch'],
      common_mistakes: [
        {
          description: 'Nicking inner strands',
          visual_cue: 'scored copper conductor fragments on mat',
        },
      ],
      point_hint: 'the 8 mm gauge mark on the stripper jaw',
      clip: {
        start_s: 5.0,
        end_s: 15.0,
      },
      translations: {
        vi: {
          instruction: 'Tuốt 8 mm vỏ dây bằng kìm tuốt chính xác.',
          why: 'Tránh kẹp vỏ cách điện trong đầu cos mà vẫn đảm bảo an toàn điện.',
        },
        hi: {
          instruction: 'सटीक स्ट्रिपर का उपयोग करके 8 मिमी वायर जैकेट को छीलें।',
          why: 'डाइइलेक्ट्रिक सीमा बनाए रखते हुए लग में इन्सुलेशन पिंच को रोकता है।',
        },
      },
    },
  ],
  created_at: '2026-10-07T12:00:00Z',
  published_at: null,
};

describe('validateSkillForPublish', () => {
  it('passes a fully compliant skill', () => {
    const res = validateSkillForPublish(validSkill, 20.0);
    expect(res.isValid).toBe(true);
    expect(res.issues).toHaveLength(0);
  });

  it('fails if video_uri is not an MP4', () => {
    const invalid = { ...validSkill, video_uri: 'gs://bucket/captures/cap_123/master.webm' };
    const res = validateSkillForPublish(invalid, 20.0);
    expect(res.isValid).toBe(false);
    expect(res.issues.some((i) => i.field === 'video_uri')).toBe(true);
  });

  it('fails if safety rules contain subjective words', () => {
    const invalid = {
      ...validSkill,
      safety_rules: ['Make sure you carefully flip the switch'],
    };
    const res = validateSkillForPublish(invalid, 20.0);
    expect(res.isValid).toBe(false);
    expect(res.issues.some((i) => i.field.startsWith('safety_rules'))).toBe(true);
  });

  it('fails if step success_criteria contains subjective words', () => {
    const invalid: Skill = {
      ...validSkill,
      steps: [
        {
          ...validSkill.steps[0],
          success_criteria: 'The wire is properly seated inside the terminal.',
        },
      ],
    };
    const res = validateSkillForPublish(invalid, 20.0);
    expect(res.isValid).toBe(false);
    expect(res.missingFieldsByStep[1]).toContain('success_criteria');
  });

  it('fails if clip start_s >= end_s or exceeds videoDuration', () => {
    const invalid: Skill = {
      ...validSkill,
      steps: [
        {
          ...validSkill.steps[0],
          clip: { start_s: 25.0, end_s: 15.0 },
        },
      ],
    };
    const res = validateSkillForPublish(invalid, 20.0);
    expect(res.isValid).toBe(false);
    expect(res.missingFieldsByStep[1]).toContain('clip');
  });

  it('fails if why_source or point_hint is missing', () => {
    const invalid: Skill = {
      ...validSkill,
      steps: [
        {
          ...validSkill.steps[0],
          why_source: undefined,
          point_hint: '',
        },
      ],
    };
    const res = validateSkillForPublish(invalid, 20.0);
    expect(res.isValid).toBe(false);
    expect(res.missingFieldsByStep[1]).toContain('why_source');
    expect(res.missingFieldsByStep[1]).toContain('point_hint');
  });

  it('fails if vi or hi translations are missing', () => {
    const invalid: Skill = {
      ...validSkill,
      steps: [
        {
          ...validSkill.steps[0],
          translations: {
            vi: {
              instruction: 'Tuốt 8 mm vỏ dây',
              why: 'Tránh kẹp vỏ cách điện',
            },
            // hi missing
          },
        },
      ],
    };
    const res = validateSkillForPublish(invalid, 20.0);
    expect(res.isValid).toBe(false);
    expect(res.missingFieldsByStep[1]).toContain('translations.hi');
  });

  it('fails if common_mistakes has no visual_cue', () => {
    const invalid: Skill = {
      ...validSkill,
      steps: [
        {
          ...validSkill.steps[0],
          common_mistakes: [
            {
              description: 'Loose connection',
              visual_cue: '',
            },
          ],
        },
      ],
    };
    const res = validateSkillForPublish(invalid, 20.0);
    expect(res.isValid).toBe(false);
    expect(res.missingFieldsByStep[1]).toContain('common_mistakes');
  });
});
