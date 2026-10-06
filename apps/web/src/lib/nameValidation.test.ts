import { describe, it, expect } from 'vitest';
import { validateTraineeName } from './nameValidation';

describe('validateTraineeName', () => {
  it('accepts valid names with Unicode marks and apostrophes/hyphens', () => {
    expect(validateTraineeName('तुषार')).toBe(true);
    expect(validateTraineeName('Nguyễn')).toBe(true);
    expect(validateTraineeName("D'Souza")).toBe(true);
    expect(validateTraineeName('Jean-Luc')).toBe(true);
    expect(validateTraineeName('Tushar')).toBe(true);
    expect(validateTraineeName('Takeshi')).toBe(true);
    expect(validateTraineeName('María')).toBe(true);
  });

  it('rejects email addresses containing @', () => {
    expect(validateTraineeName('tushar@example.com')).toBe(false);
    expect(validateTraineeName('user@test')).toBe(false);
    expect(validateTraineeName('@')).toBe(false);
  });

  it('rejects names containing digits', () => {
    expect(validateTraineeName('Trainee123')).toBe(false);
    expect(validateTraineeName('12345')).toBe(false);
    expect(validateTraineeName('John 2nd')).toBe(false);
  });

  it('rejects empty strings or names longer than 30 characters', () => {
    expect(validateTraineeName('')).toBe(false);
    expect(validateTraineeName('   ')).toBe(false);
    expect(validateTraineeName('A'.repeat(31))).toBe(false);
  });
});
