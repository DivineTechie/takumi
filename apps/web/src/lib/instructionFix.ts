/**
 * A suggested change to a step, split into the new instruction and the new success criteria.
 * Trace-back reports name both fields; older reports put both in one string such as
 * "Instruction: ... Success Criteria: ...", which this splits so neither label lands in the step.
 */
export interface InstructionFix {
  instruction: string;
  successCriteria?: string;
}

const CRITERIA_LABEL = /\s*(?:camera\s+)?success\s+criteria\s*:\s*/i;
const INSTRUCTION_LABEL = /^\s*(?:new\s+|suggested\s+)?instruction\s*:\s*/i;

export function splitInstructionFix(instruction?: string | null, successCriteria?: string | null): InstructionFix {
  let text = (instruction ?? '').trim();
  let criteria = successCriteria?.trim() || undefined;
  if (!criteria) {
    const m = CRITERIA_LABEL.exec(text);
    if (m && m.index > 0) {
      criteria = text.slice(m.index + m[0].length).trim() || undefined;
      text = text.slice(0, m.index).trim();
    }
  }
  text = text.replace(INSTRUCTION_LABEL, '').trim();
  return criteria ? { instruction: text, successCriteria: criteria } : { instruction: text };
}
