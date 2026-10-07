import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { fetchPublicPassport, type PublicPassport } from '../lib/api';
import { getTranslation, type LanguageCode } from '../i18n';
import logoSvg from '../assets/logo.svg';

const NATIVE_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ja: '日本語',
  vi: 'Tiếng Việt',
  hi: 'हिन्दी',
  id: 'Bahasa Indonesia',
  fil: 'Filipino',
};

function getNativeLanguageName(code: string): string {
  const lower = code?.toLowerCase() || '';
  return NATIVE_LANGUAGE_NAMES[lower] || code;
}

const SUPPORTED_LANG_CODES: LanguageCode[] = ['en', 'ja', 'vi', 'hi', 'id', 'fil'];

export const PassportScreen: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [passport, setPassport] = useState<PublicPassport | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [notFound, setNotFound] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [qrSvg, setQrSvg] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [badgeLoaded, setBadgeLoaded] = useState<boolean>(false);

  useEffect(() => {
    if (!id) {
      setNotFound(true);
      setLoading(false);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setNotFound(false);
    setError(null);
    setBadgeLoaded(false);

    fetchPublicPassport(id)
      .then((data) => {
        if (!isMounted) return;
        setPassport(data);
        setLoading(false);

        // Generate client-side SVG QR code for verification URL
        const verifyUrl = `${window.location.origin}/passport/${id}`;
        QRCode.toString(verifyUrl, {
          type: 'svg',
          margin: 1,
          color: { dark: '#1e293b', light: '#00000000' },
        })
          .then((svg) => {
            if (isMounted) setQrSvg(svg);
          })
          .catch((err) => {
            console.error('Failed to generate verification QR code:', err);
          });
      })
      .catch((err) => {
        if (!isMounted) return;
        setLoading(false);
        if (err?.status === 404 || err?.message?.includes('not be found')) {
          setNotFound(true);
        } else {
          setError(err?.message || 'Failed to load certificate');
        }
      });

    return () => {
      isMounted = false;
    };
  }, [id]);

  const handlePrint = () => {
    window.print();
  };

  const handleCopyLink = () => {
    if (typeof window !== 'undefined') {
      navigator.clipboard.writeText(window.location.href).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  // Loading state
  if (loading) {
    return (
      <main className="min-h-screen bg-surface flex flex-col items-center justify-center p-4">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-primary-container border-t-transparent rounded-full animate-spin" />
          <span className="text-on-surface-variant font-medium">Verifying Skill Passport...</span>
        </div>
      </main>
    );
  }

  // 404 / Not Found state
  if (notFound || !passport) {
    return (
      <main className="min-h-screen bg-surface flex flex-col items-center justify-center p-6 text-center text-on-surface">
        <div className="w-20 h-20 rounded-3xl bg-surface-container-high border border-outline-variant flex items-center justify-center mb-6 text-on-surface-variant">
          <span className="material-symbols-outlined text-[44px]">search_off</span>
        </div>
        <h1 className="text-2xl sm:text-3xl font-extrabold mb-3 text-on-surface">
          {error ? 'Failed to load certificate' : 'This certificate could not be found.'}
        </h1>
        <p className="text-on-surface-variant max-w-md mb-8 text-[16px]">
          {error ||
            'The requested passport ID may be invalid or does not exist. Please check the URL or scan the QR code again.'}
        </p>
        <Link
          to="/"
          className="min-h-[52px] px-8 py-3.5 bg-primary-container text-on-primary-container font-bold rounded-xl flex items-center gap-2 hover:brightness-105 active:scale-95 transition-all shadow cursor-pointer"
        >
          <span className="material-symbols-outlined text-[20px]">arrow_back</span>
          <span>Return to TAKUMI</span>
        </Link>
      </main>
    );
  }

  // Extract certificate language and translation helpers
  const lowerLang = passport.language?.toLowerCase() as LanguageCode;
  const certLang: LanguageCode = SUPPORTED_LANG_CODES.includes(lowerLang) ? lowerLang : 'en';
  const isEnglish = certLang === 'en';

  const tCert = (key: string, params?: Record<string, string | number>) =>
    getTranslation(certLang, key, params);
  const tEn = (key: string, params?: Record<string, string | number>) =>
    getTranslation('en', key, params);

  // Format dates in certificate locale and English
  const certLocaleMap: Record<LanguageCode, string> = {
    en: 'en-US',
    ja: 'ja-JP',
    vi: 'vi-VN',
    hi: 'hi-IN',
    id: 'id-ID',
    fil: 'fil-PH',
  };
  const certLocale = certLocaleMap[certLang] || 'en-US';

  const issuedDateStr = passport.issued_at
    ? new Date(passport.issued_at).toLocaleDateString(certLocale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : 'Recently';

  const issuedDateEnStr = passport.issued_at
    ? new Date(passport.issued_at).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : 'Recently';

  const nativeLanguageName = getNativeLanguageName(passport.language);

  return (
    <div className="min-h-screen bg-surface-dim text-on-surface flex flex-col items-center py-6 sm:py-10 px-4">
      {/* Print Stylesheet for A4 landscape certificate */}
      <style>{`
        @media print {
          body {
            background: #ffffff !important;
            margin: 0 !important;
            padding: 0 !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          @page {
            size: A4 landscape;
            margin: 8mm;
          }
          .print-hide {
            display: none !important;
          }
          .certificate-card {
            box-shadow: none !important;
            border: 2px solid #000000 !important;
            width: 100% !important;
            max-width: 100% !important;
            margin: 0 !important;
            padding: 24px !important;
          }
        }
      `}</style>

      {/* Top Header / Actions Bar (Hidden in Print) */}
      <header className="print-hide w-full max-w-4xl flex items-center justify-between pb-6">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-on-surface-variant hover:text-on-surface font-semibold text-sm transition-colors"
          aria-label="Back to TAKUMI"
        >
          <span className="material-symbols-outlined text-[20px]">arrow_back</span>
          <img src={logoSvg} alt="" className="w-6 h-6 object-contain" width={24} height={24} />
          <span className="hidden sm:inline font-bold">TAKUMI</span>
        </Link>

        <div className="flex items-center gap-2 sm:gap-3">
          <button
            type="button"
            onClick={handleCopyLink}
            className="h-10 px-3 sm:px-3.5 rounded-lg border border-outline-variant bg-surface hover:bg-surface-container text-on-surface text-sm font-semibold flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
          >
            <span className="material-symbols-outlined text-[18px]">
              {copied ? 'check' : 'share'}
            </span>
            <span>{copied ? tCert('passport_share_copied') : tCert('passport_share')}</span>
          </button>

          <button
            type="button"
            onClick={handlePrint}
            className="h-10 px-3.5 sm:px-4 rounded-lg bg-primary-container text-on-primary-container hover:brightness-105 active:scale-95 text-sm font-bold flex items-center gap-1.5 shadow-sm transition-all cursor-pointer whitespace-nowrap"
          >
            <span className="material-symbols-outlined text-[18px]">download</span>
            <span>PDF</span>
          </button>
        </div>
      </header>

      {/* Main Certificate Card (Printable) */}
      <main
        role="region"
        aria-label="Skill Passport Certificate"
        className="certificate-card w-full max-w-4xl bg-surface border-2 border-primary-container/40 rounded-3xl p-6 sm:p-10 shadow-2xl relative overflow-hidden flex flex-col justify-between selection:bg-primary-container selection:text-on-primary-container"
      >
        {/* Subtle decorative background watermark */}
        <div
          aria-hidden="true"
          className="absolute -right-16 -bottom-16 w-80 h-80 opacity-5 pointer-events-none select-none"
        >
          <img src={logoSvg} alt="" className="w-full h-full object-contain" />
        </div>

        {/* Certificate Header */}
        <header className="flex items-start justify-between border-b border-outline-variant/60 pb-6 gap-4">
          <div className="flex items-center gap-3">
            <img
              src={logoSvg}
              alt="TAKUMI Logo"
              className="w-12 h-12 rounded-xl object-contain shadow-sm border border-outline-variant/40"
              width={48}
              height={48}
            />
            <div>
              <span className="text-xs uppercase font-extrabold tracking-widest text-primary-container block">
                {tCert('passport_cert_type')}
              </span>
              {!isEnglish && (
                <span className="text-[10px] uppercase font-semibold tracking-wider text-primary-container/80 block -mt-0.5">
                  {tEn('passport_cert_type')}
                </span>
              )}
              <h1 className="text-xl sm:text-2xl font-black tracking-wider text-on-surface">
                {tCert('passport_cert_title')}
              </h1>
              {!isEnglish && tCert('passport_cert_title') !== tEn('passport_cert_title') && (
                <span className="text-xs font-bold tracking-wide text-on-surface-variant/80 block">
                  {tEn('passport_cert_title')}
                </span>
              )}
            </div>
          </div>

          {/* Verified Badge Tag */}
          <div className="flex flex-col items-end">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/40 text-emerald-600 dark:text-emerald-400 font-bold text-xs uppercase tracking-wide whitespace-nowrap">
              <span className="material-symbols-outlined text-[18px]">verified</span>
              <span>{tCert('passport_verified_tag')}</span>
            </div>
            {!isEnglish && (
              <span className="text-[10px] text-emerald-600/80 dark:text-emerald-400/80 font-medium mt-0.5 pr-1">
                {tEn('passport_verified_tag')}
              </span>
            )}
          </div>
        </header>

        {/* Certificate Center Body */}
        <div className="py-6 sm:py-10 flex flex-col items-center text-center space-y-3 sm:space-y-4">
          <div className="space-y-0.5">
            <span className="text-sm font-semibold uppercase tracking-widest text-on-surface-variant block">
              {tCert('passport_this_certifies')}
            </span>
            {!isEnglish && (
              <span className="text-xs font-normal uppercase tracking-wider text-on-surface-variant/70 block">
                {tEn('passport_this_certifies')}
              </span>
            )}
          </div>

          {/* Large Trainee First Name */}
          <h2 className="text-3xl sm:text-5xl md:text-6xl font-black text-on-surface tracking-tight font-serif px-2">
            {passport.display_first_name}
          </h2>

          <div className="space-y-0.5 max-w-lg">
            <p className="text-sm sm:text-base text-on-surface-variant">
              {tCert('passport_completed_under_coaching')}
            </p>
            {!isEnglish && (
              <p className="text-xs text-on-surface-variant/70">
                {tEn('passport_completed_under_coaching')}
              </p>
            )}
          </div>

          {/* Lesson Title */}
          <div className="py-1">
            <h3 className="text-2xl sm:text-3xl font-extrabold text-primary-container tracking-normal">
              {passport.skill_title}
            </h3>
            <div className="mt-1 space-y-0.5">
              <p className="text-sm text-on-surface-variant">
                {tCert('passport_taught_by', { master: passport.master_display_name })}
              </p>
              {!isEnglish && (
                <p className="text-xs text-on-surface-variant/70">
                  {tEn('passport_taught_by', { master: passport.master_display_name })}
                </p>
              )}
            </div>
          </div>

          {/* Clean Runs Verification Tag: "<n> times with no safety stops" */}
          <div className="pt-2 flex flex-col items-center">
            <div className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-semibold bg-surface-container-high px-3.5 py-1.5 rounded-lg border border-outline-variant">
              <span className="material-symbols-outlined text-[18px] text-emerald-500">task_alt</span>
              <span>{tCert('passport_clean_runs', { count: passport.sessions_count || 3 })}</span>
            </div>
            {!isEnglish && (
              <span className="text-[11px] text-on-surface-variant/70 mt-1">
                {tEn('passport_clean_runs', { count: passport.sessions_count || 3 })}
              </span>
            )}
          </div>
        </div>

        {/* Certificate Footer: Badge, Metadata, and QR Code */}
        <footer className="pt-6 border-t border-outline-variant/60 flex flex-col sm:flex-row items-center justify-between gap-6">
          {/* Left / Bottom Metadata */}
          <div className="text-left space-y-1.5 self-start sm:self-center">
            <div>
              <p className="text-xs text-on-surface-variant">
                <span className="font-semibold text-on-surface">{tCert('passport_issued')}:</span>{' '}
                {issuedDateStr}
              </p>
              {!isEnglish && (
                <p className="text-[10px] text-on-surface-variant/70">
                  {tEn('passport_issued')}: {issuedDateEnStr}
                </p>
              )}
            </div>

            <div>
              <p className="text-xs text-on-surface-variant">
                <span className="font-semibold text-on-surface">{tCert('passport_language_label')}:</span>{' '}
                {nativeLanguageName}
              </p>
              {!isEnglish && (
                <p className="text-[10px] text-on-surface-variant/70">
                  {tEn('passport_language_label')}: {nativeLanguageName}
                </p>
              )}
            </div>

            <p className="text-[11px] font-mono text-on-surface-variant/70">
              ID: {passport.id}
            </p>
          </div>

          {/* Center: Hanko Seal / Badge Art */}
          <div className="flex flex-col items-center">
            {passport.badge_url ? (
              <img
                src={passport.badge_url}
                alt="Skill Seal Badge"
                onLoad={() => setBadgeLoaded(true)}
                onError={() => setBadgeLoaded(false)}
                className="w-20 h-20 sm:w-24 sm:h-24 object-contain rounded-full border-2 border-red-700/60 shadow-md"
              />
            ) : (
              /* Fallback traditional CSS Hanko seal - NO SynthID label */
              <div
                aria-label="Traditional Hanko Seal"
                className="w-20 h-20 sm:w-24 sm:h-24 rounded-full border-4 border-red-700/80 bg-red-600/10 flex flex-col items-center justify-center text-red-700 shadow-sm rotate-[-3deg]"
              >
                <span className="font-serif font-black text-2xl sm:text-3xl leading-none">匠</span>
                <span className="text-[9px] uppercase tracking-wider font-extrabold mt-0.5">VERIFIED</span>
              </div>
            )}

            {/* Label displayed ONLY when Gemini badge image is active and loaded */}
            {Boolean(passport.badge_url && badgeLoaded) && (
              <div className="mt-1 text-center">
                <span className="text-[10px] text-on-surface-variant/80 block font-medium">
                  {tCert('passport_badge_synthid')}
                </span>
                {!isEnglish && (
                  <span className="text-[9px] text-on-surface-variant/60 block">
                    {tEn('passport_badge_synthid')}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Right: Client-side SVG QR Code */}
          <div className="flex flex-col items-center sm:items-end">
            {qrSvg ? (
              <div
                className="w-20 h-20 sm:w-24 sm:h-24 p-1 bg-white rounded-lg border border-outline-variant shadow-sm flex items-center justify-center"
                dangerouslySetInnerHTML={{ __html: qrSvg }}
                aria-label="Scan QR Code to verify passport"
              />
            ) : (
              <div className="w-20 h-20 sm:w-24 sm:h-24 bg-surface-container rounded-lg border border-outline-variant animate-pulse" />
            )}
            <span className="text-[10px] text-on-surface-variant/80 mt-1 font-medium text-center sm:text-right">
              {tCert('passport_scan_qr_desc')}
            </span>
            {!isEnglish && (
              <span className="text-[9px] text-on-surface-variant/60 text-center sm:text-right">
                {tEn('passport_scan_qr_desc')}
              </span>
            )}
          </div>
        </footer>
      </main>

      {/* Public Footer note */}
      <footer className="print-hide text-center text-xs text-on-surface-variant mt-6 max-w-xl px-4">
        <p>{tCert('passport_footer_check', { id: passport.id })}</p>
        {!isEnglish && (
          <p className="text-[11px] text-on-surface-variant/75 mt-1">
            {tEn('passport_footer_check', { id: passport.id })}
          </p>
        )}
      </footer>
    </div>
  );
};

export default PassportScreen;
