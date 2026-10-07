/* eslint-disable react-refresh/only-export-components */
import React, { useEffect, useRef } from 'react';
import { useI18n } from '../i18n';

export interface SafetyStopProps {
  rule: string | null;
  onMadeSafe: () => void;
  outputAudioContext?: AudioContext | null;
}

/**
 * Synthesizes an alert tone on the EXISTING output AudioContext.
 * Reuses the context already resumed during the start gesture to comply with iOS restrictions.
 */
export function playSafetyStopTone(audioContext?: AudioContext | null): void {
  if (!audioContext || audioContext.state === 'closed') {
    return;
  }
  try {
    const now = audioContext.currentTime;
    const osc1 = audioContext.createOscillator();
    const osc2 = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(880, now);
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(440, now);

    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(audioContext.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.3);
    osc2.stop(now + 0.3);
  } catch (err) {
    console.warn('Failed to play safety stop tone:', err);
  }
}

export const SafetyStop: React.FC<SafetyStopProps> = ({
  rule,
  onMadeSafe,
  outputAudioContext,
}) => {
  const { t } = useI18n();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // 1. Accessibility: capture active focus and focus button
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    buttonRef.current?.focus();

    // 2. Play warning tone on existing context
    playSafetyStopTone(outputAudioContext);

    // 3. Vibrate pattern: 200ms on, 100ms off, 200ms on
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate([200, 100, 200]);
      } catch {
        // ignore
      }
    }

    return () => {
      // Restore focus on close
      previousFocusRef.current?.focus();
    };
  }, [outputAudioContext]);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-live="assertive"
      aria-label={t('safety_stop_title')}
      className="fixed inset-0 z-50 flex flex-col justify-between bg-[#C62828] select-none text-white overflow-hidden p-6 sm:p-8"
    >
      {/* Background camera texture overlay at <= 10% opacity */}
      <div
        className="absolute inset-0 pointer-events-none opacity-10 bg-repeat mix-blend-luminosity"
        style={{
          backgroundImage:
            'radial-gradient(circle at 50% 50%, rgba(255,255,255,0.4) 1px, transparent 1px)',
          backgroundSize: '16px 16px',
        }}
      />

      {/* Main Content Layer */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center text-center max-w-xl mx-auto w-full">
        {/* Large Stop Hand Icon (120px) */}
        <div className="mb-4 flex items-center justify-center" aria-hidden="true">
          <svg
            className="w-24 h-24 sm:w-28 sm:h-28 text-white fill-current drop-shadow-md"
            viewBox="0 0 24 24"
          >
            <path d="M18 10a1.5 1.5 0 0 0-1.5-1.5V3a1.5 1.5 0 0 0-3 0v4.5A1.5 1.5 0 0 0 12 6a1.5 1.5 0 0 0-1.5 1.5V4.5a1.5 1.5 0 0 0-3 0V11a1.5 1.5 0 0 0-1.5 0v3.5C6 18.09 8.91 21 12.5 21S19 18.09 19 14.5V10z" />
          </svg>
        </div>

        {/* Massive STOP Label */}
        <h1
          className="text-white font-black tracking-wider uppercase leading-none mb-6 drop-shadow"
          style={{ fontSize: 'clamp(52px, 12vw, 80px)' }}
        >
          {t('safety_stop_title')}
        </h1>

        {/* Violation Rule / Unsafe condition */}
        <p className="text-white font-extrabold text-2xl sm:text-3xl leading-snug mb-4 max-w-md drop-shadow">
          {rule ? rule : t('safety_stop_unsafe_condition')}
        </p>

        {/* Direct Imperative */}
        <p className="text-white/95 font-semibold text-lg sm:text-xl tracking-wide drop-shadow-sm">
          {t('safety_stop_keep_hands')}
        </p>
      </div>

      {/* Bottom Action Area */}
      <div className="relative z-10 w-full max-w-xl mx-auto pt-4">
        <button
          ref={buttonRef}
          type="button"
          onClick={onMadeSafe}
          className="w-full h-16 min-h-[64px] rounded-2xl bg-white text-[#C62828] font-black text-xl shadow-2xl active:scale-95 transition-all flex items-center justify-center tracking-wide cursor-pointer focus:outline-none focus:ring-4 focus:ring-white/50"
        >
          {t('safety_stop_action_btn')}
        </button>
      </div>
    </div>
  );
};
