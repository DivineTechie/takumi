import { describe, it, expect } from 'vitest';
import { isChunkLoadError } from '../lib/chunkErrors';

describe('isChunkLoadError', () => {
  it('recognises stale page-code errors from Chrome, Safari and webpack-style loaders', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/A.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Loading chunk 7 failed'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
