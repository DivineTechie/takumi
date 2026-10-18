import React, { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useTranslation, SUPPORTED_LANGUAGES, type LanguageCode } from '../i18n';
import logoSvg from '../assets/logo.svg';

export const SignInScreen: React.FC = () => {
  const { user, loading, signInWithGoogle, sendSignInLink, signInWithPassword, signInAsGuest } = useAuth();
  const { language, setLanguage, t } = useTranslation();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [showTestAccount, setShowTestAccount] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [testPassword, setTestPassword] = useState('');
  const [isTestSubmitting, setIsTestSubmitting] = useState(false);
  const [isGuestSubmitting, setIsGuestSubmitting] = useState(false);

  if (!loading && user) {
    const fromPath = (location.state as { from?: { pathname: string } })?.from?.pathname || '/';
    return <Navigate to={fromPath} replace />;
  }

  const handleGuestSignIn = async () => {
    try {
      setErrorMessage(null);
      setIsGuestSubmitting(true);
      await signInAsGuest();
    } catch (err: unknown) {
      console.error('Guest sign-in error:', err);
      setErrorMessage(t('app.signin_guest_failed'));
    } finally {
      setIsGuestSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    try {
      setErrorMessage(null);
      await signInWithGoogle();
    } catch (err: unknown) {
      console.error('Google sign-in error:', err);
      const msg = err instanceof Error ? err.message : t('app.signin_google_failed');
      setErrorMessage(msg);
    }
  };

  const handleEmailLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    try {
      setIsSubmitting(true);
      setErrorMessage(null);
      await sendSignInLink(email);
      setEmailSent(true);
    } catch (err: unknown) {
      console.error('Email link error:', err);
      const msg = err instanceof Error ? err.message : t('app.signin_link_failed');
      setErrorMessage(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTestAccountSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testEmail || !testPassword) return;
    try {
      setIsTestSubmitting(true);
      setErrorMessage(null);
      await signInWithPassword(testEmail, testPassword);
    } catch (err: unknown) {
      console.error('Test account sign-in error:', err);
      const msg = err instanceof Error ? err.message : t('app.signin_test_invalid');
      setErrorMessage(msg);
    } finally {
      setIsTestSubmitting(false);
    }
  };

  return (
    <div className="bg-background text-on-surface antialiased min-h-screen flex items-center justify-center p-0 m-0 overflow-x-hidden font-sans">
      <main className="w-full max-w-[420px] min-h-screen flex flex-col justify-between items-center bg-surface px-8 py-10 relative">
        {/* Top bar with language switcher */}
        <div className="w-full flex justify-end items-center">
          <div className="relative flex items-center">
            <span className="material-symbols-outlined absolute left-2 pointer-events-none text-on-surface-variant text-[18px]">
              language
            </span>
            <select
              aria-label={t('app.home_select_language')}
              value={language}
              onChange={(e) => setLanguage(e.target.value as LanguageCode)}
              className="appearance-none bg-surface-container-high border border-outline-variant text-on-surface text-[14px] font-medium rounded-lg pl-8 pr-7 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary-container cursor-pointer transition-colors"
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.native}
                </option>
              ))}
            </select>
            <span className="material-symbols-outlined absolute right-1.5 pointer-events-none text-on-surface-variant text-[16px]">
              expand_more
            </span>
          </div>
        </div>

        {/* Center Hero Section */}
        <div className="w-full flex flex-col items-center text-center my-auto">
          <div className="w-36 h-36 mb-6 flex items-center justify-center">
            <img
              src={logoSvg}
              alt={t('app.home_logo_alt')}
              className="w-[120px] h-[120px] object-contain rounded-2xl mx-auto shadow-2xl"
              width={120}
              height={120}
            />
          </div>

          <h1 className="text-[32px] leading-[40px] font-extrabold tracking-wider text-on-surface uppercase mb-3">
            TAKUMI
          </h1>
          <p className="text-[19px] leading-[28px] text-on-surface-variant font-normal max-w-[320px]">
            {t('tagline')}
          </p>
          <Link to="/tour" className="mt-4 min-h-[44px] inline-flex items-center gap-1 font-bold text-primary underline-offset-4 hover:underline">
            {t('app.signin_tour_link')}
            <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
          </Link>
        </div>

        {/* Action Section */}
        <div className="w-full flex flex-col justify-end items-center pt-6 space-y-4">
          <div className="w-full p-3.5 rounded-xl bg-primary-container/10 border border-primary-container/40 text-sm text-on-surface text-left">
            <p className="font-bold mb-1">{t('app.signin_judges_title')}</p>
            <p className="text-on-surface-variant">{t('app.signin_judges_desc')}</p>
          </div>
          {errorMessage && (
            <div className="w-full p-3.5 rounded-xl bg-error-container/30 border border-error/50 text-error text-center text-sm">
              {errorMessage}
            </div>
          )}

          {emailSent ? (
            <div className="w-full p-4 rounded-xl bg-surface-container-high border border-outline-variant text-center">
              <span className="material-symbols-outlined text-primary-container text-3xl mb-2">mark_email_read</span>
              <p className="font-body-md font-semibold text-on-surface mb-1">
                {t('sign_in_email_sent_title')}
              </p>
              <p className="font-label-md text-on-surface-variant text-sm">
                {t('sign_in_email_sent_desc', { email })}
              </p>
            </div>
          ) : (
            <>
              {/* Guest: the fastest way in for judges, no account or personal data */}
              <button
                type="button"
                onClick={handleGuestSignIn}
                disabled={isGuestSubmitting}
                className="w-full min-h-[64px] py-2 bg-primary-container text-on-primary-container rounded-lg px-4 flex flex-col items-center justify-center shadow transition-all hover:brightness-105 active:scale-[0.99] disabled:opacity-60 cursor-pointer"
              >
                <span className="flex items-center gap-2 text-[18px] font-bold">
                  <span className="material-symbols-outlined text-[22px]">person</span>
                  {isGuestSubmitting ? t('app.signin_guest_signing_in') : t('app.signin_guest_btn')}
                </span>
                <span className="text-[13px] font-medium opacity-80">{t('app.signin_guest_hint')}</span>
              </button>

              {/* Google Sign In Button */}
              <button
                type="button"
                onClick={handleGoogleSignIn}
                className="w-full min-h-[56px] py-2 bg-white hover:bg-neutral-50 active:bg-neutral-100 border border-neutral-300 rounded-lg px-4 flex items-center justify-center gap-3 shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-primary-container/80 active:scale-[0.99] cursor-pointer"
              >
                <svg className="w-6 h-6 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335" />
                </svg>
                <span className="text-[18px] font-semibold text-[#1f1f1f] tracking-normal">
                  {t('sign_in_google')}
                </span>
              </button>

              {/* Divider */}
              <div className="w-full flex items-center my-2">
                <div className="flex-1 border-t border-outline-variant" />
                <span className="px-3 text-xs font-semibold text-on-surface-variant uppercase tracking-wider">
                  {t('sign_in_or')}
                </span>
                <div className="flex-1 border-t border-outline-variant" />
              </div>

              {/* Email Link Form */}
              <form onSubmit={handleEmailLinkSubmit} className="w-full space-y-3">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('sign_in_email_placeholder')}
                  className="w-full min-h-[56px] h-[56px] bg-surface-container border border-outline-variant rounded-lg px-4 text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-2 focus:ring-primary-container text-[17px]"
                />
                <button
                  type="submit"
                  disabled={isSubmitting || !email}
                  className="w-full min-h-[56px] py-2 px-4 text-center bg-surface-container-high hover:bg-surface-container-highest active:bg-surface-container border border-outline rounded-lg text-on-surface font-bold text-[17px] flex items-center justify-center gap-2 transition-all disabled:opacity-50 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[20px]">mail</span>
                  <span>{isSubmitting ? t('sign_in_email_sending') : t('sign_in_email_button')}</span>
                </button>
              </form>

              {/* Test Account Section for Judges / QA */}
              <div className="w-full pt-1 flex flex-col items-center">
                <button
                  type="button"
                  onClick={() => setShowTestAccount(!showTestAccount)}
                  className="min-h-[44px] text-xs font-semibold text-on-surface-variant hover:text-on-surface flex items-center gap-1 cursor-pointer transition-colors py-1"
                >
                  <span>{t('app.signin_test_toggle')}</span>
                  <span className="material-symbols-outlined text-[16px]">
                    {showTestAccount ? 'expand_less' : 'expand_more'}
                  </span>
                </button>

                {showTestAccount && (
                  <form onSubmit={handleTestAccountSubmit} className="w-full space-y-2.5 mt-2.5 pt-2.5 border-t border-outline-variant/60">
                    <input
                      type="email"
                      required
                      value={testEmail}
                      onChange={(e) => setTestEmail(e.target.value)}
                      placeholder="judge-trainee@takumi-cup-2026.web.app"
                      className="w-full min-h-[48px] h-[48px] bg-surface-container border border-outline-variant rounded-lg px-3.5 text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary-container text-[15px]"
                    />
                    <input
                      type="password"
                      required
                      value={testPassword}
                      onChange={(e) => setTestPassword(e.target.value)}
                      placeholder={t('app.signin_test_password')}
                      className="w-full min-h-[48px] h-[48px] bg-surface-container border border-outline-variant rounded-lg px-3.5 text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary-container text-[15px]"
                    />
                    <button
                      type="submit"
                      disabled={isTestSubmitting || !testEmail || !testPassword}
                      className="w-full min-h-[48px] py-2 px-4 text-center bg-primary text-on-primary hover:bg-primary/90 active:bg-primary rounded-lg font-semibold text-[15px] flex items-center justify-center gap-2 transition-all disabled:opacity-50 cursor-pointer shadow-sm"
                    >
                      <span className="material-symbols-outlined text-[18px]">badge</span>
                      <span>{isTestSubmitting ? t('app.signin_test_signing_in') : t('app.signin_test_submit')}</span>
                    </button>
                  </form>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
};

export default SignInScreen;
