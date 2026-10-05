import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useTranslation, SUPPORTED_LANGUAGES, type LanguageCode } from '../i18n';
import type { Skill } from '../../../../shared/schema/ts/skills';

export const ChooseLessonScreen: React.FC = () => {
  const navigate = useNavigate();
  const { language, setLanguage, t } = useTranslation();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const mockSkills = typeof window !== 'undefined' ? (window as unknown as { __TAKUMI_MOCK_SKILLS__?: Skill[] }).__TAKUMI_MOCK_SKILLS__ : null;
    if (mockSkills) {
      setSkills(mockSkills);
      setLoading(false);
      return;
    }

    // Live Firestore query on published skills
    const q = query(collection(db, 'skills'), where('status', '==', 'published'));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const loaded: Skill[] = [];
        snapshot.forEach((doc) => {
          loaded.push({ id: doc.id, ...doc.data() } as Skill);
        });
        setSkills(loaded);
        setLoading(false);
      },
      (err) => {
        console.error('Failed to query published skills:', err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  return (
    <div className="bg-background text-on-surface font-body-md min-h-screen antialiased flex flex-col justify-between selection:bg-primary-container selection:text-on-primary-container">
      {/* Top App Bar */}
      <header className="w-full bg-surface-container-low min-h-[64px] flex items-center justify-between px-4 sticky top-0 z-40 border-b border-outline-variant">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            aria-label={t('back')}
            className="w-12 h-12 flex items-center justify-center rounded-lg text-on-surface hover:bg-surface-container-high active:scale-95 transition-transform duration-100 focus:outline-none cursor-pointer"
            type="button"
          >
            <span className="material-symbols-outlined text-[24px]">arrow_back</span>
          </button>
          <div className="flex items-center gap-2.5">
            <span className="font-headline-md font-bold text-on-surface tracking-wider">TAKUMI</span>
          </div>
        </div>

        {/* Language selector */}
        <div className="relative flex items-center">
          <select
            aria-label="Select Language"
            value={language}
            onChange={(e) => setLanguage(e.target.value as LanguageCode)}
            className="appearance-none bg-surface-container-high text-on-surface font-label-md text-sm pl-3 pr-8 py-2 rounded-lg border border-outline-variant focus:outline-none focus:border-primary-container transition-colors cursor-pointer"
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.native}
              </option>
            ))}
          </select>
          <span className="material-symbols-outlined pointer-events-none absolute right-2 text-on-surface-variant text-[18px]">
            expand_more
          </span>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 w-full max-w-md mx-auto px-4 pt-6 pb-8 flex flex-col">
        <section className="mb-6">
          <h1 className="font-headline-xl font-bold text-on-surface tracking-tight">
            {t('choose_lesson_title')}
          </h1>
        </section>

        {loading ? (
          /* Skeleton loading state */
          <div className="space-y-4">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 animate-pulse"
              >
                <div className="h-7 bg-surface-container-high rounded w-3/4 mb-3" />
                <div className="h-5 bg-surface-container rounded w-1/2 mb-4" />
                <div className="h-4 bg-surface-container rounded w-1/3 mb-6" />
                <div className="h-14 bg-surface-container-high rounded-xl w-full" />
              </div>
            ))}
          </div>
        ) : skills.length === 0 ? (
          /* Empty state matching 03_choose_lesson_empty */
          <div className="bg-surface-container-low rounded-2xl border border-outline-variant p-8 text-center flex flex-col items-center justify-center min-h-[300px] w-full my-auto transition-all">
            <div className="w-20 h-20 rounded-full bg-surface-container flex items-center justify-center border border-outline-variant mb-6 text-on-surface-variant">
              <span className="material-symbols-outlined text-[48px]">menu_book</span>
            </div>
            <h2 className="font-headline-md font-bold text-on-surface mb-2 tracking-normal">
              {t('no_lessons_title')}
            </h2>
            <p className="font-body-md text-on-surface-variant max-w-[280px] leading-relaxed">
              {t('no_lessons_desc')}
            </p>
          </div>
        ) : (
          /* Skill cards list */
          <div className="space-y-4">
            {skills.map((skill) => (
              <div
                key={skill.id}
                className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 flex flex-col justify-between shadow-none"
              >
                <div>
                  <h2 className="font-headline-md font-bold text-on-surface leading-snug">
                    {skill.title}
                  </h2>
                  <p className="font-body-md text-slate-300 mt-2 font-normal">
                    {skill.master ? `${skill.master.display_name}, ${skill.master.role}` : 'Master Instructor'}
                  </p>
                  <div className="flex items-center gap-2 mt-3 text-on-surface-variant font-label-md text-sm">
                    <span className="material-symbols-outlined text-[20px]">schedule</span>
                    <span>{skill.steps ? t('steps_count', { count: skill.steps.length }) : ''}</span>
                  </div>
                  {/* Language chips */}
                  {skill.languages && skill.languages.length > 0 && (
                    <div className="flex items-center gap-2 mt-4 flex-wrap">
                      {skill.languages.map((code) => (
                        <span
                          key={code}
                          className="bg-surface-container-high text-on-surface px-2.5 py-1 text-xs font-bold uppercase rounded tracking-wide border border-outline-variant"
                        >
                          {code}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="mt-6">
                  <button
                    type="button"
                    onClick={() => navigate(`/coach/${skill.id}`)}
                    className="w-full min-h-[56px] h-14 bg-primary-container text-on-primary-container font-label-lg font-bold rounded-xl flex items-center justify-center gap-2 hover:brightness-105 active:scale-[0.98] transition-all cursor-pointer"
                  >
                    <span>{t('start_btn')}</span>
                    <span className="material-symbols-outlined text-[22px]">play_arrow</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default ChooseLessonScreen;
