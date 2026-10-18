import React, { useState, type ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth, type Role } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { useTranslation, SUPPORTED_LANGUAGES, type LanguageCode } from '../i18n';
import logoSvg from '../assets/logo.svg';

const primaryBtn =
  'w-full min-h-[56px] py-3.5 px-4 bg-primary-container text-on-primary-container rounded-xl font-bold text-[16px] flex items-center justify-center gap-2 hover:brightness-105 active:scale-[0.99] transition-all shadow cursor-pointer';
const secondaryBtn =
  'w-full min-h-[56px] py-3.5 px-4 bg-surface border border-outline-variant hover:bg-surface-container text-on-surface rounded-xl font-bold text-[16px] flex items-center justify-center gap-2 active:scale-[0.99] transition-all cursor-pointer';
const noAccess =
  'w-full min-h-[56px] py-3.5 px-5 bg-surface-container text-on-surface-variant rounded-xl font-medium text-[16px] flex items-center justify-center text-center border border-outline-variant';

const DEMO_ROLES: { role: Role; icon: string }[] = [
  { role: 'trainee', icon: 'front_hand' },
  { role: 'supervisor', icon: 'monitoring' },
  { role: 'master', icon: 'videocam' },
];

/** Demo: lets a person who signed in with their own account try every role (the shared test accounts keep theirs). */
const RolePicker: React.FC<{ role: Role | null; pickRole: (r: Role) => Promise<void> }> = ({ role, pickRole }) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<Role | null>(null);
  const [failed, setFailed] = useState(false);
  const choose = async (next: Role) => {
    if (next === role || busy) return;
    setBusy(next);
    setFailed(false);
    try {
      await pickRole(next);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label={t('app.home_role_picker_title')} className="mb-6 rounded-2xl border border-primary-container/40 bg-primary-container/10 p-4">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="lg:w-72 shrink-0">
          <h2 className="font-bold text-on-surface">{t('app.home_role_picker_title')}</h2>
          <p className="text-sm text-on-surface-variant">{t('app.home_role_picker_desc')}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 flex-1" role="radiogroup">
          {DEMO_ROLES.map(({ role: r, icon }) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={role === r}
              onClick={() => choose(r)}
              className={`min-h-[56px] rounded-xl px-3 py-2 text-left flex items-center gap-3 border transition-colors cursor-pointer ${
                role === r ? 'bg-primary-container text-on-primary-container border-primary-container' : 'bg-surface border-outline-variant hover:bg-surface-container text-on-surface'
              }`}
            >
              <span className="material-symbols-outlined text-[22px]">{icon}</span>
              <span>
                <span className="block font-bold">{busy === r ? t('app.home_role_switching') : t(`app.home_role_pick_${r}`)}</span>
                <span className="block text-xs opacity-80">{t(`app.home_role_pick_${r}_desc`)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
      {failed && <p className="mt-2 text-sm text-error">{t('app.home_role_failed')}</p>}
    </section>
  );
};

const Card: React.FC<{ title: string; desc: string; children: ReactNode }> = ({ title, desc, children }) => (
  <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 shadow-sm flex flex-col justify-between transition-colors">
    <div className="mb-5">
      <h2 className="text-[24px] leading-[32px] font-bold text-on-surface mb-2">{title}</h2>
      <p className="text-[16px] sm:text-[18px] leading-[24px] sm:leading-[26px] text-on-surface-variant">{desc}</p>
    </div>
    <div className="flex flex-col gap-3">{children}</div>
  </section>
);

export const HomeScreen: React.FC = () => {
  const { user, role, signOut, canPickRole, pickRole } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { language, setLanguage, t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const unauthorizedMessage = (location.state as { unauthorizedMessage?: string })?.unauthorizedMessage;

  const isSupervisor = role === 'supervisor';
  const isMaster = role === 'master';
  const canWatchStations = role === 'trainee' || isSupervisor || isMaster;

  const button = (to: string, icon: string, label: string, primary = true) => (
    <button type="button" onClick={() => navigate(to)} className={primary ? primaryBtn : secondaryBtn}>
      <span className="material-symbols-outlined text-[20px]">{icon}</span>
      <span>{label}</span>
    </button>
  );
  const askForAccess = <div className={noAccess}>{t('ask_supervisor_access')}</div>;

  return (
    <div className="bg-background text-on-surface antialiased min-h-screen flex flex-col font-sans">
      <header className="bg-surface-container-low border-b border-outline-variant sticky top-0 z-40">
        <div className="max-w-[460px] lg:max-w-6xl mx-auto px-4 lg:px-8 min-h-[64px] flex items-center justify-between">
          <div className="flex items-center gap-3 shrink-0">
            <img
              src={logoSvg}
              alt={t('app.home_logo_alt')}
              className="w-8 h-8 rounded-lg shrink-0 object-contain shadow-sm"
              width={32}
              height={32}
            />
            <span className="text-[20px] font-bold tracking-wider text-on-surface shrink-0">TAKUMI</span>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative flex items-center">
              <label className="sr-only" htmlFor="header-language-select">
                {t('app.home_select_language')}
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

            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen(!menuOpen)}
                className="w-10 h-10 rounded-lg flex items-center justify-center text-on-surface hover:bg-surface-container-high transition-colors cursor-pointer"
                aria-label={t('app.home_user_menu')}
              >
                <span className="material-symbols-outlined text-[24px]">more_vert</span>
              </button>

              {menuOpen && (
                <div className="absolute right-0 mt-2 w-52 bg-surface-container-high border border-outline-variant rounded-xl shadow-xl py-2 z-50">
                  <div className="px-4 py-2 border-b border-outline-variant">
                    <p className="text-xs text-on-surface-variant">{t('app.home_signed_in_as')}</p>
                    <p className="text-sm font-bold text-on-surface truncate">{user?.displayName || user?.email}</p>
                    <span className="inline-block px-2 py-0.5 text-[11px] font-bold uppercase rounded bg-primary-container/20 text-primary-container mt-1">
                      {t(`app.home_role_${role || 'trainee'}`)}
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

      <main className="w-full max-w-[460px] lg:max-w-6xl mx-auto px-4 lg:px-8 pt-6 pb-12 flex-1 flex flex-col">
        {unauthorizedMessage && (
          <div className="mb-4 p-3.5 rounded-xl bg-primary-container/10 border border-primary-container/30 text-primary-container text-center text-sm font-medium">
            {unauthorizedMessage}
          </div>
        )}

        <h1 className="mb-6 text-[28px] leading-[36px] font-bold text-on-surface">{t('home_heading')}</h1>

        {canPickRole && <RolePicker role={role} pickRole={pickRole} />}

        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5">
          <Card title={t('app.home_inspection_title')} desc={t('app.home_inspection_desc')}>
            {button('/inspect', 'photo_camera', t('app.home_inspection_station_btn'))}
            {button('/inspect/gallery', 'photo_library', t('app.home_inspection_gallery_btn'), false)}
          </Card>

          <Card title={t('app.home_machines_title')} desc={t('app.home_machines_desc')}>
            {button('/machines/watch', 'videocam', t('app.home_machines_watch_btn'))}
            {button('/machines/virtual', 'precision_manufacturing', t('app.home_machines_bench_btn'), false)}
          </Card>

          <Card title={t('app.home_station_title')} desc={t('app.home_station_desc')}>
            {canWatchStations ? button('/coach', 'front_hand', t('app.home_station_btn')) : askForAccess}
          </Card>

          <Card title={t('app.home_supervisor_title')} desc={t('app.home_supervisor_desc')}>
            {isSupervisor ? (
              <>
                {button('/control', 'monitoring', t('app.home_team_control_btn'))}
                {button('/dashboard', 'dashboard', t('app.home_supervisor_dashboard_btn'), false)}
              </>
            ) : (
              askForAccess
            )}
          </Card>

          <Card title={t('app.home_studio_title')} desc={t('app.home_studio_desc')}>
            {isMaster && button('/capture', 'videocam', t('app.home_studio_record_btn'))}
            {isMaster || isSupervisor
              ? button('/library', 'menu_book', t('app.home_studio_library_btn'), !isMaster)
              : askForAccess}
          </Card>

          <Card title={t('app.home_evidence_title')} desc={t('app.home_evidence_desc')}>
            {button('/evals', 'query_stats', t('app.home_evidence_evals_btn'), false)}
            {button('/tour', 'travel_explore', t('app.home_evidence_tour_btn'), false)}
          </Card>
        </div>
      </main>
    </div>
  );
};

export default HomeScreen;
