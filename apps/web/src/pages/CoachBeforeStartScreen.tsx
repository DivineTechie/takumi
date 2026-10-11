import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useTranslation, type LanguageCode } from '../i18n';
import type { Skill } from '../../../../shared/schema/ts/skills';
import logoSvg from '../assets/logo.svg';
import { CoachLiveView } from './CoachLiveView';
import { createAndResumeAudioContexts } from '../lib/live/audio';

interface LanguageOption {
  code: LanguageCode;
  native: string;
  /** Translation key for the secondary label under the native name. */
  labelKey: string;
}

const LANGUAGES: LanguageOption[] = [
  { code: 'en', native: 'English', labelKey: 'station.before_start_lang_label_en' },
  { code: 'ja', native: '日本語', labelKey: 'station.before_start_lang_label_ja' },
  { code: 'vi', native: 'Tiếng Việt', labelKey: 'station.before_start_lang_label_vi' },
  { code: 'hi', native: 'हिन्दी', labelKey: 'station.before_start_lang_label_hi' },
  { code: 'id', native: 'Bahasa Indonesia', labelKey: 'station.before_start_lang_label_id' },
  { code: 'fil', native: 'Filipino', labelKey: 'station.before_start_lang_label_fil' },
];

/** A load error is either a translation key or a raw message from Firestore. */
type LoadError = { key: string } | { raw: string };

export const CoachBeforeStartScreen: React.FC = () => {
  const { skillId } = useParams<{ skillId: string }>();
  const navigate = useNavigate();
  const { language: currentUiLang, t } = useTranslation();

  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadError | null>(null);

  const [selectedLang, setSelectedLang] = useState<LanguageCode>(() => {
    const validCodes: LanguageCode[] = ['en', 'ja', 'vi', 'hi', 'id', 'fil'];
    return validCodes.includes(currentUiLang as LanguageCode)
      ? (currentUiLang as LanguageCode)
      : 'en';
  });

  // Station Watch: optional serial of the unit built in this session (links the session to the unit's record)
  const [unitSerial, setUnitSerial] = useState('');
  const serialValid = unitSerial.trim() === '' || /^[A-Za-z0-9._-]{1,64}$/.test(unitSerial.trim());
  const [wearingHeadphones, setWearingHeadphones] = useState<boolean>(() => {
    try {
      return localStorage.getItem('takumi_wearing_headphones') === 'true';
    } catch {
      return false;
    }
  });

  const [isStarting, setIsStarting] = useState(false);
  const [permissionError, setPermissionError] = useState<boolean>(false);
  const [sessionsEnabled, setSessionsEnabled] = useState<boolean>(true);

  // Check system status on mount for kill switch
  useEffect(() => {
    let isMounted = true;
    fetch('/api/status')
      .then((r) => r.json())
      .then((data) => {
        if (isMounted && data && typeof data.sessions_enabled === 'boolean') {
          setSessionsEnabled(data.sessions_enabled);
        }
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, []);

  // Active live session state
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const micAudioContextRef = useRef<AudioContext | null>(null);

  // 1. Load published skill strictly from Firestore (no seed fallback!)
  useEffect(() => {
    if (!skillId) {
      setLoadError({ key: 'station.before_start_error_no_id' });
      setLoading(false);
      return;
    }

    let isMounted = true;

    async function fetchSkill() {
      try {
        setLoading(true);
        setLoadError(null);

        const docRef = doc(db, 'skills', skillId!);
        const snapshot = await getDoc(docRef);

        if (!snapshot.exists()) {
          if (isMounted) {
            setLoadError({ key: 'station.before_start_error_not_found' });
            setLoading(false);
          }
          return;
        }

        const data = { id: snapshot.id, ...snapshot.data() } as Skill;

        // Must be published!
        if (data.status !== 'published') {
          if (isMounted) {
            setLoadError({ key: 'station.before_start_error_not_published' });
            setLoading(false);
          }
          return;
        }

        if (isMounted) {
          setSkill(data);
          setLoading(false);
        }
      } catch (err: unknown) {
        console.error('Failed to load skill doc from Firestore:', err);
        if (isMounted) {
          setLoadError(
            err instanceof Error ? { raw: err.message } : { key: 'station.before_start_error_load_failed' }
          );
          setLoading(false);
        }
      }
    }

    fetchSkill();

    return () => {
      isMounted = false;
    };
  }, [skillId]);

  // 2. Start Live Coaching (iOS Safari User Gesture AudioContexts)
  const handleStartCoaching = async () => {
    if (!skill) return;
    setPermissionError(false);
    setIsStarting(true);

    // Rule 2: Create both AudioContexts and call resume() BEFORE the first await!
    // Safari drops the user gesture after any await.
    const { outputContext, micContext } = createAndResumeAudioContexts();
    outputAudioContextRef.current = outputContext;
    micAudioContextRef.current = micContext;

    try {
      // Rule 2 & 6: getUserMedia with camera and mic
      let stream: MediaStream;
      try {
        // Try rear/environment camera first
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
      } catch (e) {
        console.warn('Ideal environment camera request failed, trying default media:', e);
        // Fall back to any video camera
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: true,
        });
      }

      setActiveStream(stream);
      setIsStarting(false);
    } catch (err: unknown) {
      console.error('getUserMedia failed:', err);
      setIsStarting(false);
      try {
        outputContext.close().catch(() => {});
        micContext.close().catch(() => {});
      } catch {
        // ignore
      }
      setPermissionError(true);
    }
  };

  // Stable reference to skill and stream during an active live session
  const activeSkillRef = useRef<Skill | null>(null);
  if (activeStream && skill && !activeSkillRef.current) {
    activeSkillRef.current = skill;
  }
  if (!activeStream) {
    activeSkillRef.current = null;
  }
  const liveSessionSkill = activeSkillRef.current || skill;

  const activeStreamRef = useRef<MediaStream | null>(null);
  activeStreamRef.current = activeStream;

  const handleEndLiveSession = useCallback(() => {
    if (activeStreamRef.current) {
      activeStreamRef.current.getTracks().forEach((t) => t.stop());
      setActiveStream(null);
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close().catch(() => {});
      outputAudioContextRef.current = null;
    }
    if (micAudioContextRef.current) {
      micAudioContextRef.current.close().catch(() => {});
      micAudioContextRef.current = null;
    }
    activeSkillRef.current = null;
  }, []);

  // If a live session is active, render CoachLiveView
  if (activeStream && liveSessionSkill && outputAudioContextRef.current && micAudioContextRef.current) {
    return (
      <CoachLiveView
        skill={liveSessionSkill}
        language={selectedLang}
        stream={activeStream}
        outputAudioContext={outputAudioContextRef.current}
        micAudioContext={micAudioContextRef.current}
        speakerMode={!wearingHeadphones}
        unitId={unitSerial.trim() || undefined}
        onEnd={handleEndLiveSession}
      />
    );
  }

  // Permission error overlay
  if (permissionError) {
    return (
      <div className="bg-background text-on-surface min-h-screen flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-[420px] bg-surface-container-high border border-outline-variant rounded-2xl p-6 text-center shadow-2xl flex flex-col items-center">
          <div className="w-16 h-16 rounded-full bg-error-container/30 border border-error/50 flex items-center justify-center text-error mb-4">
            <span className="material-symbols-outlined text-[36px]">videocam_off</span>
          </div>
          <h2 className="text-[22px] font-bold text-on-surface mb-2">
            {t('station.before_start_permission_title')}
          </h2>
          <p className="text-[15px] leading-[22px] text-on-surface-variant mb-6 text-left">
            {t('station.before_start_permission_desc')}
          </p>
          <div className="w-full space-y-3">
            <button
              type="button"
              onClick={handleStartCoaching}
              className="w-full min-h-[56px] px-3 py-2 bg-primary-container text-on-primary-container font-bold rounded-xl flex items-center justify-center gap-2 hover:brightness-105 active:scale-[0.98] transition-all cursor-pointer"
            >
              <span className="material-symbols-outlined text-[22px]">refresh</span>
              <span>{t('station.before_start_permission_retry')}</span>
            </button>
            <button
              type="button"
              onClick={() => navigate('/coach')}
              className="w-full min-h-[56px] px-3 py-2 bg-surface-container border border-outline-variant text-on-surface font-semibold rounded-xl flex items-center justify-center hover:bg-surface-bright active:scale-[0.98] transition-all cursor-pointer"
            >
              {t('station.common_back_to_lessons')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Loading state
  if (loading) {
    return (
      <div className="bg-background text-on-surface min-h-screen flex items-center justify-center p-6 font-sans">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-4 border-primary-container border-t-transparent rounded-full animate-spin" />
          <span className="text-on-surface-variant font-medium">{t('station.before_start_loading')}</span>
        </div>
      </div>
    );
  }

  // Load error / unpublished lesson (Rule 1: No fallback to seed data!)
  if (loadError || !skill) {
    return (
      <div className="bg-background text-on-surface min-h-screen flex items-center justify-center p-6 font-sans">
        <div className="w-full max-w-[420px] bg-surface-container-high border border-outline-variant rounded-2xl p-6 text-center shadow-2xl flex flex-col items-center">
          <div className="w-16 h-16 rounded-full bg-error-container/30 border border-error/50 flex items-center justify-center text-error mb-4">
            <span className="material-symbols-outlined text-[36px]">error</span>
          </div>
          <h2 className="text-[22px] font-bold text-on-surface mb-2">
            {t('station.before_start_unavailable_title')}
          </h2>
          <p className="text-[15px] leading-[22px] text-on-surface-variant mb-6">
            {loadError
              ? 'key' in loadError
                ? t(loadError.key)
                : loadError.raw
              : t('station.before_start_unavailable_desc')}
          </p>
          <button
            type="button"
            onClick={() => navigate('/coach')}
            className="w-full min-h-[56px] px-3 py-2 bg-primary-container text-on-primary-container font-bold rounded-xl flex items-center justify-center gap-2 hover:brightness-105 active:scale-[0.98] transition-all cursor-pointer"
          >
            <span className="material-symbols-outlined text-[22px]">arrow_back</span>
            <span>{t('station.common_back_to_lessons')}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background text-on-surface min-h-screen flex justify-center items-start font-sans">
      <main className="w-full max-w-[420px] min-h-screen flex flex-col bg-surface relative overflow-x-hidden border-x border-surface-container-high shadow-2xl">
        {/* Top Bar */}
        <header className="w-full h-[56px] px-4 flex items-center justify-between bg-surface-container-low shrink-0 z-20 border-b border-outline-variant">
          <button
            onClick={() => navigate('/coach')}
            aria-label={t('station.common_back_to_lessons')}
            className="flex items-center justify-center w-12 h-12 -ml-2 rounded text-on-surface hover:bg-surface-container-high active:scale-95 transition-transform cursor-pointer"
            type="button"
          >
            <span className="material-symbols-outlined text-2xl">arrow_back</span>
          </button>
          <div className="flex items-center gap-2">
            <img
              src={logoSvg}
              alt={t('station.common_logo_alt')}
              className="w-8 h-8 rounded-lg shrink-0 object-contain shadow-sm"
              width={32}
              height={32}
            />
            <span className="font-headline-md font-bold tracking-wider text-on-surface">TAKUMI</span>
          </div>
          <div className="w-10" />
        </header>

        {/* Main Content */}
        <div className="flex-1 flex flex-col px-4 pt-6 pb-28 overflow-y-auto">
          {/* Header Title & Tagline */}
          <div className="mb-6">
            <span className="font-label-md uppercase tracking-wider text-primary font-bold block mb-1">
              {t('station.before_start_eyebrow')}
            </span>
            <h1 className="font-headline-lg font-extrabold tracking-tight mb-2 text-on-surface">
              {skill.title}
            </h1>
            <p className="font-body-md text-on-surface-variant">
              {t('station.before_start_intro')}
            </p>
          </div>

          {/* Language Selection Grid (2x3) */}
          <section className="flex flex-col flex-1">
            <div className="flex items-center justify-between flex-wrap gap-x-3 gap-y-1 mb-3">
              <h2 className="font-headline-sm text-on-surface font-semibold">
                {t('station.before_start_language_heading')}
              </h2>
              <span className="font-label-md text-on-surface-variant">
                {t('station.before_start_language_count', { count: LANGUAGES.length })}
              </span>
            </div>

            <div
              className="grid grid-cols-2 gap-3 mb-6"
              role="radiogroup"
              aria-label={t('station.before_start_language_aria')}
            >
              {LANGUAGES.map((lang) => {
                const isSelected = selectedLang === lang.code;
                return (
                  <button
                    key={lang.code}
                    role="radio"
                    aria-checked={isSelected}
                    type="button"
                    onClick={() => setSelectedLang(lang.code)}
                    className={`relative flex flex-col justify-center items-start min-w-0 min-h-[72px] px-4 py-3 rounded-xl text-left transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-surface-container-high border-2 border-primary-container shadow-md'
                        : 'bg-surface-container border border-outline-variant hover:border-surface-bright'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 w-full">
                      <span className="font-headline-sm font-bold text-on-surface leading-tight min-w-0 break-words">
                        {lang.native}
                      </span>
                      {isSelected && (
                        <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary-container text-on-primary-container shrink-0">
                          <span className="material-symbols-outlined text-[14px]">check</span>
                        </span>
                      )}
                    </div>
                    <span className="font-label-md text-on-surface-variant leading-tight mt-1 break-words">
                      {t(lang.labelKey)}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Unit serial (Station Watch) */}
            <div className="flex flex-col gap-1.5 p-3.5 rounded-xl bg-surface-container-low border border-outline-variant">
              <label htmlFor="unit-serial" className="font-body-md text-on-surface font-semibold">
                {t('station.before_start_serial_label')}
              </label>
              <input
                id="unit-serial"
                value={unitSerial}
                onChange={(e) => setUnitSerial(e.target.value)}
                placeholder={t('station.before_start_serial_placeholder')}
                autoCapitalize="characters"
                autoComplete="off"
                className={`min-h-[48px] rounded-lg bg-surface-container px-3 font-mono border ${serialValid ? 'border-outline-variant' : 'border-error'}`}
              />
              <p className="font-body-sm text-on-surface-variant leading-snug">
                {serialValid
                  ? t('station.before_start_serial_help')
                  : t('station.before_start_serial_invalid')}
              </p>
            </div>

            {/* Headphone Toggle & Note */}
            <div className="flex flex-col gap-2.5 p-3.5 rounded-xl bg-surface-container-low border border-outline-variant mt-auto">
              <label className="flex items-center justify-between gap-3 cursor-pointer select-none">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-surface-container flex items-center justify-center shrink-0 text-primary">
                    <span className="material-symbols-outlined text-2xl">headphones</span>
                  </div>
                  <span className="font-body-md text-on-surface font-semibold min-w-0 break-words">
                    {t('station.before_start_headphones')}
                  </span>
                </div>
                <input
                  type="checkbox"
                  aria-label={t('station.before_start_headphones')}
                  checked={wearingHeadphones}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setWearingHeadphones(next);
                    try {
                      localStorage.setItem('takumi_wearing_headphones', String(next));
                    } catch {
                      // ignore
                    }
                  }}
                  className="w-5 h-5 shrink-0 accent-primary cursor-pointer rounded"
                />
              </label>
              <p className="font-body-sm text-on-surface-variant leading-snug">
                {t('station.before_start_headphones_help')}
              </p>
            </div>
          </section>
        </div>

        {/* Pinned Bottom Action Zone */}
        <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[420px] p-4 bg-surface-container-lowest/95 backdrop-blur-md border-t border-outline-variant z-30">
          {!sessionsEnabled ? (
            <div className="w-full min-h-[56px] py-2 rounded-xl bg-surface-container-high border border-outline-variant text-on-surface-variant font-headline-sm font-semibold flex items-center justify-center gap-2 px-3 text-center">
              <span className="material-symbols-outlined text-[22px] text-amber-500 shrink-0">construction</span>
              <span className="text-[15px]">{t('station.before_start_paused')}</span>
            </div>
          ) : (
            <button
              type="button"
              disabled={isStarting || !serialValid}
              onClick={handleStartCoaching}
              className="w-full min-h-[56px] px-3 py-2 rounded-xl bg-primary-container text-on-primary-container font-headline-sm font-extrabold flex items-center justify-center gap-2 hover:brightness-105 active:scale-[0.99] transition-all shadow-lg cursor-pointer disabled:opacity-50"
            >
              {isStarting ? (
                <div className="w-6 h-6 border-3 border-on-primary-container border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <span className="material-symbols-outlined text-[24px]">play_arrow</span>
                  <span className="text-[18px]">{t('station.before_start_start_btn')}</span>
                </>
              )}
            </button>
          )}
        </div>
      </main>
    </div>
  );
};

export default CoachBeforeStartScreen;
