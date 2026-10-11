import { describe, it, expect } from 'vitest';

/** Every page string has a translation in every language with the same {placeholders}. */
const files = import.meta.glob('./pages/*/*.json', { eager: true, import: 'default' }) as Record<string, Record<string, unknown>>;
const LANGS = ['ja', 'vi', 'hi', 'id', 'fil'];
const placeholders = (s: string) => (s.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort().join(',');

describe('page translations', () => {
  const english = Object.entries(files).filter(([p]) => p.startsWith('./pages/en/'));
  for (const [path, en] of english) {
    const area = path.split('/').pop() as string;
    for (const lang of LANGS) {
      it(`${lang}/${area} covers every English key with the same placeholders`, () => {
        const tr = files[`./pages/${lang}/${area}`] ?? {};
        const problems = Object.entries(en)
          .filter(([k, v]) => !k.startsWith('_') && typeof v === 'string')
          .filter(([k, v]) => typeof tr[k] !== 'string' || placeholders(tr[k] as string) !== placeholders(v as string))
          .map(([k]) => k);
        expect(problems).toEqual([]);
      });
    }
  }
});
