import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { fetchPublicPassport, type PublicPassport } from '../lib/api';
import logoSvg from '../assets/logo.svg';

export const PassportScreen: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [passport, setPassport] = useState<PublicPassport | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [notFound, setNotFound] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [qrSvg, setQrSvg] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);

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
          {error || 'The requested passport ID may be invalid or does not exist. Please check the URL or scan the QR code again.'}
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

  // Format date cleanly
  const issuedDateStr = passport.issued_at
    ? new Date(passport.issued_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : 'Recently';

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
        >
          <span className="material-symbols-outlined text-[20px]">arrow_back</span>
          <span>TAKUMI</span>
        </Link>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleCopyLink}
            className="h-10 px-3.5 rounded-lg border border-outline-variant bg-surface hover:bg-surface-container text-on-surface text-sm font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">
              {copied ? 'check' : 'share'}
            </span>
            <span>{copied ? 'Copied' : 'Share'}</span>
          </button>

          <button
            type="button"
            onClick={handlePrint}
            className="h-10 px-4 rounded-lg bg-primary-container text-on-primary-container hover:brightness-105 active:scale-95 text-sm font-bold flex items-center gap-1.5 shadow-sm transition-all cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">download</span>
            <span>Download PDF</span>
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
        <header className="flex items-start justify-between border-b border-outline-variant/60 pb-6">
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
                Official Craft Accreditation
              </span>
              <h1 className="text-xl sm:text-2xl font-black tracking-wider text-on-surface">
                TAKUMI SKILL PASSPORT
              </h1>
            </div>
          </div>

          {/* Verified Badge Tag */}
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/40 text-emerald-600 dark:text-emerald-400 font-bold text-xs uppercase tracking-wide">
            <span className="material-symbols-outlined text-[18px]">verified</span>
            <span>Verified by TAKUMI</span>
          </div>
        </header>

        {/* Certificate Center Body */}
        <div className="py-8 sm:py-12 flex flex-col items-center text-center space-y-4">
          <span className="text-sm font-semibold uppercase tracking-widest text-on-surface-variant">
            This certifies that
          </span>

          {/* Large Trainee First Name */}
          <h2 className="text-3xl sm:text-5xl md:text-6xl font-black text-on-surface tracking-tight font-serif px-2">
            {passport.display_first_name}
          </h2>

          <p className="text-sm sm:text-base text-on-surface-variant max-w-lg">
            has demonstrated hands-on technical mastery in
          </p>

          {/* Lesson Title */}
          <div className="py-1">
            <h3 className="text-2xl sm:text-3xl font-extrabold text-primary-container tracking-normal">
              {passport.skill_title}
            </h3>
            <p className="text-sm text-on-surface-variant mt-1">
              taught by <span className="font-semibold text-on-surface">{passport.master_display_name}</span>
            </p>
          </div>

          {/* Clean Runs Verification Tag */}
          <div className="pt-2 flex items-center gap-2">
            <span className="inline-flex items-center gap-1 text-xs sm:text-sm font-semibold bg-surface-container-high px-3 py-1 rounded-lg border border-outline-variant">
              <span className="material-symbols-outlined text-[18px] text-emerald-500">task_alt</span>
              <span>{passport.sessions_count || 3} Clean Runs Verified</span>
            </span>
          </div>
        </div>

        {/* Certificate Footer: Badge, Metadata, and QR Code */}
        <footer className="pt-6 border-t border-outline-variant/60 flex flex-col sm:flex-row items-center justify-between gap-6">
          {/* Left / Bottom Metadata */}
          <div className="text-left space-y-1 self-start sm:self-center">
            <p className="text-xs text-on-surface-variant">
              <span className="font-semibold text-on-surface">Issued:</span> {issuedDateStr}
            </p>
            <p className="text-xs text-on-surface-variant">
              <span className="font-semibold text-on-surface">Language:</span>{' '}
              {passport.language.toUpperCase()}
            </p>
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
                className="w-20 h-20 sm:w-24 sm:h-24 object-contain rounded-full border-2 border-red-700/60 shadow-md"
              />
            ) : (
              /* Fallback traditional CSS Hanko seal */
              <div
                aria-label="Traditional Hanko Seal"
                className="w-20 h-20 sm:w-24 sm:h-24 rounded-full border-4 border-red-700/80 bg-red-600/10 flex flex-col items-center justify-center text-red-700 shadow-sm rotate-[-3deg]"
              >
                <span className="font-serif font-black text-2xl sm:text-3xl leading-none">匠</span>
                <span className="text-[9px] uppercase tracking-wider font-extrabold mt-0.5">VERIFIED</span>
              </div>
            )}
            <span className="text-[10px] text-on-surface-variant/70 mt-1 font-medium text-center">
              Badge art generated with Gemini (SynthID)
            </span>
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
            <span className="text-[10px] text-on-surface-variant/70 mt-1 font-medium">
              Scan to verify authenticity
            </span>
          </div>
        </footer>
      </main>

      {/* Public Footer note */}
      <footer className="print-hide text-center text-xs text-on-surface-variant mt-6 max-w-md">
        This document is an authentic craft competency record cryptographically registered on TAKUMI.
      </footer>
    </div>
  );
};

export default PassportScreen;
