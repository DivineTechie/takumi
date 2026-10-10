import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { useTranslation, SUPPORTED_LANGUAGES, type LanguageCode } from '../i18n';
import { fetchMyPassports, type MyPassport } from '../lib/api';
import { featureRoutes } from '../features/routes';
import logoSvg from '../assets/logo.svg';

export const HomeScreen: React.FC = () => {
  const { user, role, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { language, setLanguage, t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [myPassports, setMyPassports] = useState<MyPassport[]>([]);

  useEffect(() => {
    if (user) {
      fetchMyPassports()
        .then((res) => {
          if (res?.passports) {
            setMyPassports(res.passports);
          }
        })
        .catch((err) => {
          console.warn('Failed to fetch user passports:', err);
        });
    }
  }, [user]);

  const unauthorizedMessage = (location.state as { unauthorizedMessage?: string })?.unauthorizedMessage;

  const canLearn = role === 'trainee' || role === 'supervisor' || role === 'master';
  const canTeach = role === 'master' || role === 'supervisor';
  const canSeeTeam = role === 'supervisor';

  const isRouteAvailable = (path: string) => featureRoutes.some((r) => r.path === path);
  const isCaptureAvailable = isRouteAvailable('/capture');

  return (
    <div className="bg-background text-on-surface antialiased min-h-screen flex flex-col font-sans">
      {/* Top App Bar: Responsive at 390px */}
      <header className="bg-surface-container-low border-b border-outline-variant sticky top-0 z-40">
        <div className="max-w-[460px] mx-auto px-4 min-h-[64px] flex items-center justify-between">
          {/* Brand Mark & Name - never cut off at 390px */}
          <div className="flex items-center gap-3 shrink-0">
            <img
              src={logoSvg}
              alt="TAKUMI Logo"
              className="w-8 h-8 rounded-lg shrink-0 object-contain shadow-sm"
              width={32}
              height={32}
            />
            <span className="text-[20px] font-bold tracking-wider text-on-surface shrink-0">
              TAKUMI
            </span>
          </div>

          {/* Right Header Actions: Compact Language Switcher + Menu */}
          <div className="flex items-center gap-2">
            {/* Language Selector: Globe icon + native script name */}
            <div className="relative flex items-center">
              <label className="sr-only" htmlFor="header-language-select">
                Select language
              </label>
              <span className="material-symbols-outlined absolute left-2 pointer-events-none text-on-surface-variant text-[18px]">
                language
              </span>
              <select
                id="header-language-select"
                value={language}
                onChange={(e) => setLanguage(e.target.value as LanguageCode)}
                className="appearance-none bg-surface-container-high border border-outline-variant text-on-surface text-[14px] sm:text-[15px] font-medium rounded-lg pl-7 sm:pl-8 pr-6 sm:pr-7 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary-container cursor-pointer transition-colors max-w-[120px] sm:max-w-[140px] truncate"
              >
                {SUPPORTED_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.native}
                  </option>
                ))}
              </select>
              <span className="material-symbols-outlined absolute right-1 pointer-events-none text-on-surface-variant text-[16px]">
                expand_more
              </span>
            </div>

            {/* Menu Button */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen(!menuOpen)}
                className="w-10 h-10 rounded-lg flex items-center justify-center text-on-surface hover:bg-surface-container-high transition-colors cursor-pointer"
                aria-label="User menu"
              >
                <span className="material-symbols-outlined text-[24px]">more_vert</span>
              </button>

              {menuOpen && (
                <div className="absolute right-0 mt-2 w-52 bg-surface-container-high border border-outline-variant rounded-xl shadow-xl py-2 z-50">
                  <div className="px-4 py-2 border-b border-outline-variant">
                    <p className="text-xs text-on-surface-variant">Signed in as</p>
                    <p className="text-sm font-bold text-on-surface truncate">{user?.displayName || user?.email}</p>
                    <span className="inline-block px-2 py-0.5 text-[11px] font-bold uppercase rounded bg-primary-container/20 text-primary-container mt-1">
                      {role || 'trainee'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      toggleTheme();
                      setMenuOpen(false);
                    }}
                    className="w-full px-4 py-2.5 text-left text-sm text-on-surface hover:bg-surface-container flex items-center gap-2 cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[18px]">
                      {theme === 'dark' ? 'light_mode' : 'dark_mode'}
                    </span>
                    <span>{theme === 'dark' ? t('light_mode') : t('dark_mode')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      signOut();
                    }}
                    className="w-full px-4 py-2.5 text-left text-sm text-error hover:bg-surface-container flex items-center gap-2 border-t border-outline-variant cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[18px]">logout</span>
                    <span>{t('sign_out')}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="w-full max-w-[460px] mx-auto px-4 pt-6 pb-12 flex-1 flex flex-col">
        {unauthorizedMessage && (
          <div className="mb-4 p-3.5 rounded-xl bg-primary-container/10 border border-primary-container/30 text-primary-container text-center text-sm font-medium">
            {unauthorizedMessage}
          </div>
        )}

        <div className="mb-6">
          <h1 className="text-[28px] leading-[36px] font-bold text-on-surface">
            {t('home_heading')}
          </h1>
        </div>

        <div className="space-y-5">
          {/* Quality inspection */}
          <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 shadow-sm flex flex-col justify-between transition-colors">
            <div className="mb-5">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-[24px] leading-[32px] font-bold text-on-surface">
                  Quality Inspection
                </h2>
              </div>
              <p className="text-[16px] sm:text-[18px] leading-[24px] sm:leading-[26px] text-on-surface-variant">
                Photograph each finished unit; Gemini flags defects and a person confirms. Try it on real public-dataset parts.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => navigate('/inspect')}
                className="w-full min-h-[56px] py-3.5 px-4 bg-primary-container text-on-primary-container rounded-xl font-bold text-[16px] flex items-center justify-center gap-2 hover:brightness-105 active:scale-[0.99] transition-all shadow cursor-pointer"
              >
                <span className="material-symbols-outlined text-[20px]">photo_camera</span>
                <span>Inspect Station</span>
              </button>
              <button
                type="button"
                onClick={() => navigate('/inspect/gallery')}
                className="w-full min-h-[56px] py-3.5 px-4 bg-surface border border-outline-variant hover:bg-surface-container text-on-surface rounded-xl font-bold text-[16px] flex items-center justify-center gap-2 active:scale-[0.99] transition-all cursor-pointer"
              >
                <span className="material-symbols-outlined text-[20px]">photo_library</span>
                <span>Try real parts (VisA)</span>
              </button>
            </div>
          </section>

          {/* Machine Watch */}
          <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 shadow-sm flex flex-col justify-between transition-colors">
            <div className="mb-5">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-[24px] leading-[32px] font-bold text-on-surface">
                  Machine Watch
                </h2>
              </div>
              <p className="text-[16px] sm:text-[18px] leading-[24px] sm:leading-[26px] text-on-surface-variant">
                A camera you already have reads stack lights, counters and alarm screens. No wiring.
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={() => navigate('/machines/watch')}
                className="w-full min-h-[56px] py-3.5 px-4 bg-primary-container text-on-primary-container rounded-xl font-bold text-[16px] flex items-center justify-center gap-2 hover:brightness-105 active:scale-[0.99] transition-all shadow cursor-pointer"
              >
                <span className="material-symbols-outlined text-[20px]">videocam</span>
                <span>Watch machines</span>
              </button>
              <button
                type="button"
                onClick={() => navigate('/machines/virtual')}
                className="w-full min-h-[56px] py-3.5 px-4 bg-surface-container-high text-on-surface rounded-xl font-bold text-[16px] flex items-center justify-center gap-2 hover:brightness-105 active:scale-[0.99] transition-all cursor-pointer"
              >
                <span className="material-symbols-outlined text-[20px]">precision_manufacturing</span>
                <span>Machine test bench</span>
              </button>
            </div>
          </section>
          {/* CARD 1: Learn a skill */}
          <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 shadow-sm flex flex-col justify-between transition-colors">
            <div className="mb-5">
              <h2 className="text-[24px] leading-[32px] font-bold text-on-surface mb-2">
                {t('card_learn_title')}
              </h2>
              <p className="text-[18px] leading-[26px] text-on-surface-variant">
                {t('card_learn_desc')}
              </p>
            </div>
            {canLearn ? (
              <button
                type="button"
                onClick={() => navigate('/coach')}
                className="w-full min-h-[56px] py-3.5 px-5 bg-primary-container text-on-primary-container rounded-xl font-bold text-[17px] flex items-center justify-center gap-2 hover:brightness-105 active:scale-[0.99] transition-all shadow cursor-pointer"
              >
                <span>{t('card_learn_btn')}</span>
                <span className="material-symbols-outlined text-[22px]">arrow_forward</span>
              </button>
            ) : (
              <div className="w-full min-h-[56px] py-3.5 px-5 bg-surface-container text-on-surface-variant rounded-xl font-medium text-[16px] flex items-center justify-center border border-outline-variant">
                {t('ask_supervisor_access')}
              </div>
            )}
          </section>

          {/* My Certificates Section (Feature A11 Skill Passport) */}
          {myPassports.length > 0 && (
            <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 shadow-sm flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary-container text-[24px]">verified</span>
                  <h2 className="text-[20px] font-bold text-on-surface">My Certificates</h2>
                </div>
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-primary-container/20 text-primary-container">
                  {myPassports.length}
                </span>
              </div>
              <div className="space-y-3">
                {myPassports.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => navigate(`/passport/${p.id}`)}
                    className="p-3.5 bg-surface rounded-xl border border-outline-variant hover:border-primary-container/60 transition-all flex items-center justify-between cursor-pointer group shadow-xs"
                  >
                    <div className="flex items-center gap-3">
                      {p.badge_url ? (
                        <img
                          src={p.badge_url}
                          alt=""
                          className="w-10 h-10 rounded-full object-contain border border-red-700/40"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full border-2 border-red-700/60 bg-red-500/10 text-red-600 font-serif font-bold text-lg flex items-center justify-center">
                          匠
                        </div>
                      )}
                      <div>
                        <p className="font-bold text-on-surface text-[15px] group-hover:text-primary-container transition-colors">
                          {p.skill_title}
                        </p>
                        <p className="text-xs text-on-surface-variant">
                          Taught by {p.master_display_name} • {new Date(p.issued_at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <span className="material-symbols-outlined text-on-surface-variant group-hover:text-primary-container group-hover:translate-x-0.5 transition-all text-[20px]">
                      chevron_right
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* CARD 2: Teach a skill */}
          <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 shadow-sm flex flex-col justify-between transition-colors">
            <div className="mb-5">
              <h2 className="text-[24px] leading-[32px] font-bold text-on-surface mb-2">
                {t('card_teach_title')}
              </h2>
              <p className="text-[18px] leading-[26px] text-on-surface-variant">
                {t('card_teach_desc')}
              </p>
            </div>
            {!canTeach ? (
              <div className="w-full min-h-[56px] py-3.5 px-5 bg-surface-container text-on-surface-variant rounded-xl font-medium text-[16px] flex items-center justify-center border border-outline-variant">
                {t('ask_supervisor_access')}
              </div>
            ) : !isCaptureAvailable ? (
              <div className="w-full min-h-[56px] py-3.5 px-5 bg-surface-container text-on-surface-variant rounded-xl font-medium text-[16px] flex items-center justify-center border border-outline-variant">
                Coming soon
              </div>
            ) : (
              <button
                type="button"
                onClick={() => navigate('/capture')}
                className="w-full min-h-[56px] py-3.5 px-5 bg-primary-container text-on-primary-container rounded-xl font-bold text-[17px] flex items-center justify-center gap-2 hover:brightness-105 active:scale-[0.99] transition-all shadow cursor-pointer"
              >
                <span>{t('card_teach_btn')}</span>
                <span className="material-symbols-outlined text-[22px]">videocam</span>
              </button>
            )}
          </section>

          {/* CARD 3: See my team */}
          <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 shadow-sm flex flex-col justify-between transition-colors">
            <div className="mb-5">
              <h2 className="text-[24px] leading-[32px] font-bold text-on-surface mb-2">
                {t('card_team_title')}
              </h2>
              <p className="text-[18px] leading-[26px] text-on-surface-variant">
                {t('card_team_desc')}
              </p>
            </div>
            {canSeeTeam ? (
              <button
                type="button"
                onClick={() => navigate('/dashboard')}
                className="w-full min-h-[56px] py-3.5 px-5 bg-primary-container text-on-primary-container rounded-xl font-bold text-[17px] flex items-center justify-center gap-2 hover:brightness-105 active:scale-[0.99] transition-all shadow cursor-pointer"
              >
                <span>{t('card_team_btn')}</span>
                <span className="material-symbols-outlined text-[22px]">arrow_forward</span>
              </button>
            ) : null}
            {canSeeTeam ? (
              <button
                type="button"
                onClick={() => navigate('/control')}
                className="mt-3 w-full min-h-[56px] py-3.5 px-5 bg-surface border border-outline-variant hover:bg-surface-container text-on-surface rounded-xl font-bold text-[17px] flex items-center justify-center gap-2 active:scale-[0.99] transition-all cursor-pointer"
              >
                <span className="material-symbols-outlined text-[22px]">monitoring</span>
                <span>Control tower</span>
              </button>
            ) : (
              <div className="w-full min-h-[56px] py-3.5 px-5 bg-surface-container text-on-surface-variant rounded-xl font-medium text-[16px] flex items-center justify-center border border-outline-variant">
                {t('ask_supervisor_access')}
              </div>
            )}
          </section>

        </div>
      </main>
    </div>
  );
};

export default HomeScreen;
