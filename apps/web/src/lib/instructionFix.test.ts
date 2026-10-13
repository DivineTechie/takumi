import { describe, expect, it } from 'vitest';
import { splitInstructionFix } from './instructionFix';

describe('splitInstructionFix', () => {
  it('splits a labelled suggestion into the instruction and the success criteria', () => {
    expect(
      splitInstructionFix(
        'Instruction: Apply the label to the adapter body. Success Criteria: The label lies flat on the adapter housing.'
      )
    ).toEqual({ instruction: 'Apply the label to the adapter body.', successCriteria: 'The label lies flat on the adapter housing.' });
  });

  it('keeps plain text as the instruction', () => {
    expect(splitInstructionFix('Add an orientation mark.')).toEqual({ instruction: 'Add an orientation mark.' });
  });

  it('allows a fix that changes only the success criteria', () => {
    expect(splitInstructionFix(null, 'A rubber band holds the cable.')).toEqual({
      instruction: '',
      successCriteria: 'A rubber band holds the cable.',
    });
  });

  it('uses the separate success criteria when the report gives them', () => {
    expect(splitInstructionFix('Add an orientation mark.', 'The mark faces up.')).toEqual({
      instruction: 'Add an orientation mark.',
      successCriteria: 'The mark faces up.',
    });
  });
});
