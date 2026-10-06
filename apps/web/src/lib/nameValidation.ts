/**
 * Validates trainee certificate first name.
 * Rule: ^[\p{L}\p{M}' \-]{1,30}$ with unicode flag (u).
 * \p{M} is required because Devanagari vowel signs and Vietnamese combining accents are marks;
 * "तुषार", "Nguyễn" and "D'Souza" must pass.
 * Must reject '@' and any digits.
 */
export function validateTraineeName(name: string): boolean {
  if (!name) {
    return false;
  }
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 30) {
    return false;
  }
  if (trimmed.includes('@') || /\d/.test(trimmed)) {
    return false;
  }
  const regex = /^[\p{L}\p{M}' -]{1,30}$/u;
  return regex.test(trimmed);
}
