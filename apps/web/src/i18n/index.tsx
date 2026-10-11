/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import en from './en.json';
import ja from './ja.json';
import vi from './vi.json';
import hi from './hi.json';
import id from './id.json';
import fil from './fil.json';

export type LanguageCode = 'en' | 'ja' | 'vi' | 'hi' | 'id' | 'fil';

export interface LanguageInfo {
  code: LanguageCode;
  native: string;
}

export const SUPPORTED_LANGUAGES: LanguageInfo[] = [
  { code: 'en', native: 'English' },
  { code: 'ja', native: '日本語' },
  { code: 'vi', native: 'Tiếng Việt' },
  { code: 'hi', native: 'हिन्दी' },
  { code: 'id', native: 'Bahasa Indonesia' },
  { code: 'fil', native: 'Filipino' },
];

// Page strings live in one file per area and language (pages/<lang>/<area>.json) so areas can be
// edited independently; they are merged over the core file for each language. English is bundled;
// other languages are fetched the first time they are chosen, and English shows until they arrive.
const englishAreas = import.meta.glob('./pages/en/*.json', { eager: true, import: 'default' }) as Record<string, Record<string, unknown>>;
const otherAreas = import.meta.glob(['./pages/*/*.json', '!./pages/en/*.json'], { import: 'default' }) as Record<string, () => Promise<Record<string, unknown>>>;

function mergeAreas(target: Record<string, unknown>, strings: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(strings)) if (!k.startsWith('_') && typeof v === 'string') target[k] = v;
}

const translations: Record<LanguageCode, Record<string, unknown>> = {
  en: { ...en },
  ja: { ...ja },
  vi: { ...vi },
  hi: { ...hi },
  id: { ...id },
  fil: { ...fil },
};
for (const strings of Object.values(englishAreas)) mergeAreas(translations.en, strings);

const loadedLanguages = new Set<LanguageCode>(['en']);
const loading = new Map<LanguageCode, Promise<void>>();

/** Loads a language's page strings once; resolves when they are merged. */
export function loadLanguage(lang: LanguageCode): Promise<void> {
  if (loadedLanguages.has(lang)) return Promise.resolve();
  const pending = loading.get(lang);
  if (pending) return pending;
  const p = Promise.all(
    Object.entries(otherAreas)
      .filter(([path]) => path.startsWith(`./pages/${lang}/`))
      .map(([, load]) => load().then((strings) => mergeAreas(translations[lang], strings)))
  ).then(() => {
    loadedLanguages.add(lang);
  });
  loading.set(lang, p);
  return p;
}

export function detectLanguage(): LanguageCode {
  if (typeof window === 'undefined') return 'en';
  try {
    const saved = localStorage.getItem('takumi_lang') as LanguageCode | null;
    if (saved && translations[saved]) {
      return saved;
    }
    const navLang = navigator.language?.toLowerCase() || '';
    for (const item of SUPPORTED_LANGUAGES) {
      if (navLang.startsWith(item.code)) {
        return item.code;
      }
    }
  } catch {
    // fallback
  }
  return 'en';
}

export interface I18nContextType {
  language: LanguageCode;
  setLanguage: (lang: LanguageCode) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export function getTranslation(
  lang: LanguageCode,
  key: string,
  params?: Record<string, string | number>
): string {
  const currentDict = translations[lang] || translations.en;
  let text = (currentDict[key] as string) || (translations.en[key] as string) || key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return text;
}

export const I18nProvider: React.FC<{ children: ReactNode; initialLanguage?: LanguageCode }> = ({
  children,
  initialLanguage,
}) => {
  const [language, setLanguageState] = useState<LanguageCode>(() => initialLanguage || detectLanguage());
  const [, setLoadedVersion] = useState(0);

  useEffect(() => {
    if (loadedLanguages.has(language)) return;
    let alive = true;
    loadLanguage(language)
      .then(() => alive && setLoadedVersion((v) => v + 1))
      .catch(() => {
        // Offline or a stale deploy: keep English for page strings.
      });
    return () => {
      alive = false;
    };
  }, [language]);

  const setLanguage = (newLang: LanguageCode) => {
    setLanguageState(newLang);
    try {
      localStorage.setItem('takumi_lang', newLang);
    } catch {
      // ignore
    }
  };

  const t = (key: string, params?: Record<string, string | number>) => {
    return getTranslation(language, key, params);
  };

  return (
    <I18nContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  );
};

export function useTranslation(): I18nContextType {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Fallback when used outside provider
    return {
      language: 'en',
      setLanguage: () => {},
      t: (key, params) => getTranslation('en', key, params),
    };
  }
  return ctx;
}

export const useI18n = useTranslation;

