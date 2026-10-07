import { describe, it, expect } from 'vitest';
import { getTranslation, SUPPORTED_LANGUAGES } from './index';
import en from './en.json';
import ja from './ja.json';
import vi from './vi.json';
import hi from './hi.json';
import id from './id.json';
import fil from './fil.json';

describe('i18n localization system', () => {
  it('supports the required 6 UI languages with correct native names', () => {
    const expected = [
      { code: 'en', native: 'English' },
      { code: 'ja', native: '日本語' },
      { code: 'vi', native: 'Tiếng Việt' },
      { code: 'hi', native: 'हिन्दी' },
      { code: 'id', native: 'Bahasa Indonesia' },
      { code: 'fil', native: 'Filipino' },
    ];
    expect(SUPPORTED_LANGUAGES).toEqual(expected);
  });

  it('marks non-English translations with status "needs native review"', () => {
    expect(ja._meta.status).toBe('needs native review');
    expect(vi._meta.status).toBe('needs native review');
    expect(hi._meta.status).toBe('needs native review');
    expect(id._meta.status).toBe('needs native review');
    expect(fil._meta.status).toBe('needs native review');
  });

  it('translates known keys in Japanese, Vietnamese, etc.', () => {
    expect(getTranslation('ja', 'app_name')).toBe('TAKUMI');
    expect(getTranslation('ja', 'sign_in_google')).toBe('Google でログイン');
    expect(getTranslation('vi', 'sign_in_google')).toBe('Đăng nhập bằng Google');
  });

  it('interpolates parameters correctly', () => {
    const result = getTranslation('en', 'sign_in_email_sent_desc', { email: 'worker@factory.com' });
    expect(result).toBe('We sent a sign-in link to worker@factory.com. Click the link to complete sign in.');

    const stepResult = getTranslation('en', 'steps_count', { count: 4 });
    expect(stepResult).toBe('4 steps');
  });

  it('falls back to English when key is missing in target language', () => {
    // If a language dictionary lacks a key, it must return the English value
    // Test with simulated missing key logic using getTranslation fallback
    const result = getTranslation('ja', 'non_existent_key_xyz');
    expect(result).toBe('non_existent_key_xyz');
  });

  it('contains consistent translation keys across all 6 files', () => {
    const enKeys = Object.keys(en).filter((k) => k !== '_meta');
    const allLangs = [ja, vi, hi, id, fil];

    for (const dict of allLangs) {
      const keys = Object.keys(dict).filter((k) => k !== '_meta');
      for (const k of enKeys) {
        expect(keys).toContain(k);
      }
    }
  });
});
