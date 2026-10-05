import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

const LANGUAGES = [
  { code: 'en', native: 'English', label: 'Primary' },
  { code: 'ja', native: '日本語', label: 'Japanese' },
  { code: 'vi', native: 'Tiếng Việt', label: 'Vietnamese' },
  { code: 'hi', native: 'हिन्दी', label: 'Hindi' },
  { code: 'id', native: 'Bahasa Indo', label: 'Indonesian' },
  { code: 'fil', native: 'Filipino', label: 'Tagalog' },
];

export const CoachBeforeStartScreen: React.FC = () => {
  const { skillId } = useParams<{ skillId: string }>();
  const navigate = useNavigate();
  const [selectedLang, setSelectedLang] = useState<string>('en');

  return (
    <div className="bg-background text-on-surface min-h-screen flex justify-center items-start">
      <main className="w-full max-w-[420px] min-h-screen flex flex-col bg-surface relative overflow-x-hidden border-x border-surface-container-high shadow-2xl">
        {/* Top Bar */}
        <header className="w-full h-[56px] px-4 flex items-center justify-between bg-surface-container-low shrink-0 z-20">
          <button
            onClick={() => navigate('/coach')}
            aria-label="Go back"
            className="flex items-center justify-center w-12 h-12 -ml-2 rounded text-on-surface hover:bg-surface-container-high active:scale-95 transition-transform"
            type="button"
          >
            <span className="material-symbols-outlined text-2xl">arrow_back</span>
          </button>
          <div className="flex items-center gap-2">
            <span className="font-headline-md font-bold tracking-wider text-on-surface">TAKUMI</span>
          </div>
          <div className="w-10" />
        </header>

        {/* Main Content */}
        <div className="flex-1 flex flex-col px-4 pt-6 pb-28 overflow-y-auto">
          <div className="mb-6">
            <span className="font-label-md uppercase tracking-wider text-primary font-bold block mb-1">
              Lesson preparation
            </span>
            <h1 className="font-headline-lg font-extrabold tracking-tight mb-2 text-on-surface">
              {skillId === 'seed-wire-din-rail' ? 'Wire a DIN-rail terminal block' : 'Standard Operating Module'}
            </h1>
            <p className="font-body-md text-on-surface-variant">
              Choose your coaching language to start audio and camera prompts.
            </p>
          </div>

          <section className="flex flex-col flex-1">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-headline-sm text-on-surface font-semibold">
                Coaching language
              </h2>
              <span className="font-label-md text-on-surface-variant">6 Available</span>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-6" role="radiogroup" aria-label="Select coaching language">
              {LANGUAGES.map((lang) => {
                const isSelected = selectedLang === lang.code;
                return (
                  <button
                    key={lang.code}
                    role="radio"
                    aria-checked={isSelected}
                    type="button"
                    onClick={() => setSelectedLang(lang.code)}
                    className={`relative flex flex-col justify-center items-start min-h-[72px] px-4 py-3 rounded-xl text-left transition-all ${
                      isSelected
                        ? 'bg-surface-container-high border-2 border-primary-container'
                        : 'bg-surface-container border border-outline-variant hover:border-surface-bright'
                    }`}
                  >
                    <span className="font-headline-sm font-bold text-on-surface leading-tight">
                      {lang.native}
                    </span>
                    <span className="font-label-md text-on-surface-variant leading-tight">
                      {lang.label}
                    </span>
                    {isSelected && (
                      <span className="absolute top-2 right-2 flex items-center gap-0.5 bg-primary-container text-on-primary-container px-1.5 py-0.5 rounded font-label-md text-[11px] leading-tight font-bold uppercase tracking-wider">
                        <span className="material-symbols-outlined text-[13px]">check</span>
                        Selected
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-3 p-3.5 rounded-xl bg-surface-container-low border border-outline-variant mt-auto">
              <div className="w-10 h-10 rounded-lg bg-surface-container flex items-center justify-center shrink-0 text-primary">
                <span className="material-symbols-outlined text-2xl">headphones</span>
              </div>
              <p className="font-body-md text-on-surface font-medium leading-snug">
                Use headphones for best results
              </p>
            </div>
          </section>
        </div>

        {/* Pinned Bottom Action Zone */}
        <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[420px] p-4 bg-surface-container-lowest/95 backdrop-blur-md border-t border-outline-variant z-30">
          <button
            disabled
            className="w-full min-h-[56px] h-[60px] rounded-lg bg-surface-container-high text-on-surface-variant/60 font-headline-sm font-extrabold flex flex-col items-center justify-center cursor-not-allowed opacity-80"
            type="button"
          >
            <span className="text-[17px]">Live coaching arrives in the next update</span>
          </button>
        </div>
      </main>
    </div>
  );
};

export default CoachBeforeStartScreen;
