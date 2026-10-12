import React, { useState } from 'react';
import { Camera, FileText, Globe, Sparkles, AlertCircle } from 'lucide-react';
import { useI18n } from '../../../i18n';

export interface SetupFormData {
  skillTitle: string;
  sourceLanguage: 'ja' | 'en' | 'hi' | 'vi' | 'id' | 'fil';
  manualFile: File | null;
}

interface SetupFormProps {
  onStart: (data: SetupFormData) => void;
  isStarting: boolean;
  error?: string | null;
}

// labelKey: language name in the viewer's language (shown under the native name).
const LANGUAGES: Array<{ code: SetupFormData['sourceLanguage']; labelKey: string; native: string }> = [
  { code: 'ja', labelKey: 'app.capture_lang_ja', native: '日本語' },
  { code: 'en', labelKey: 'app.capture_lang_en', native: 'English' },
  { code: 'vi', labelKey: 'app.capture_lang_vi', native: 'Tiếng Việt' },
  { code: 'hi', labelKey: 'app.capture_lang_hi', native: 'हिन्दी' },
  { code: 'id', labelKey: 'app.capture_lang_id', native: 'Bahasa Indonesia' },
  { code: 'fil', labelKey: 'app.capture_lang_fil', native: 'Tagalog' },
];

export const SetupForm: React.FC<SetupFormProps> = ({ onStart, isStarting, error }) => {
  const { t } = useI18n();
  const [skillTitle, setSkillTitle] = useState('Wire a DIN-rail terminal block');
  const [sourceLanguage, setSourceLanguage] = useState<SetupFormData['sourceLanguage']>('ja');
  const [manualFile, setManualFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!skillTitle.trim()) {
      setValidationError('app.capture_title_required');
      return;
    }
    setValidationError(null);
    onStart({
      skillTitle: skillTitle.trim(),
      sourceLanguage,
      manualFile,
    });
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#09090b',
        color: '#f4f4f5',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '1.5rem',
        boxSizing: 'border-box',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '540px',
          backgroundColor: '#18181b',
          borderRadius: '1.25rem',
          border: '1px solid #27272a',
          padding: '2rem 1.5rem',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
        }}
      >
        {/* Header / Brand */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              backgroundColor: 'rgba(245, 158, 11, 0.12)',
              border: '1px solid rgba(245, 158, 11, 0.3)',
              color: '#fbbf24',
              padding: '0.35rem 0.85rem',
              borderRadius: '9999px',
              fontSize: '0.875rem',
              fontWeight: 600,
              marginBottom: '0.75rem',
            }}
          >
            <Sparkles size={16} />
            <span>TAKUMI 匠 · {t('app.capture_studio')}</span>
          </div>
          <h1
            style={{
              fontSize: '1.875rem',
              fontWeight: 800,
              letterSpacing: '-0.025em',
              margin: '0 0 0.5rem 0',
              color: '#ffffff',
            }}
          >
            {t('app.capture_title')}
          </h1>
          <p style={{ color: '#a1a1aa', fontSize: '0.95rem', margin: 0 }}>
            {t('app.capture_subtitle')}
          </p>
        </div>

        {(error || validationError) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              backgroundColor: 'rgba(239, 68, 68, 0.12)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: '#f87171',
              padding: '0.85rem 1rem',
              borderRadius: '0.75rem',
              marginBottom: '1.5rem',
              fontSize: '0.9rem',
            }}
          >
            <AlertCircle size={20} style={{ flexShrink: 0 }} />
            <span>{error || (validationError ? t(validationError) : null)}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Skill Title */}
          <div>
            <label
              htmlFor="skillTitle"
              style={{
                display: 'block',
                fontSize: '0.875rem',
                fontWeight: 600,
                color: '#d4d4d8',
                marginBottom: '0.5rem',
              }}
            >
              {t('app.capture_title_label')}
            </label>
            <input
              id="skillTitle"
              type="text"
              value={skillTitle}
              onChange={(e) => setSkillTitle(e.target.value)}
              placeholder={t('app.capture_title_placeholder')}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                minHeight: '52px',
                padding: '0.75rem 1rem',
                backgroundColor: '#27272a',
                border: '1px solid #3f3f46',
                borderRadius: '0.75rem',
                color: '#ffffff',
                fontSize: '1rem',
                outline: 'none',
                transition: 'border-color 0.2s',
              }}
            />
          </div>

          {/* Source Language Picker */}
          <div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.875rem',
                fontWeight: 600,
                color: '#d4d4d8',
                marginBottom: '0.5rem',
              }}
            >
              <Globe size={16} />
              <span>{t('app.capture_language_label')}</span>
            </label>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: '0.75rem',
              }}
            >
              {LANGUAGES.map((lang) => {
                const isSelected = sourceLanguage === lang.code;
                return (
                  <button
                    key={lang.code}
                    type="button"
                    onClick={() => setSourceLanguage(lang.code)}
                    style={{
                      minHeight: '52px',
                      padding: '0.75rem 1rem',
                      borderRadius: '0.75rem',
                      border: isSelected ? '2px solid #f59e0b' : '1px solid #3f3f46',
                      backgroundColor: isSelected ? 'rgba(245, 158, 11, 0.15)' : '#27272a',
                      color: isSelected ? '#fbbf24' : '#d4d4d8',
                      fontWeight: isSelected ? 700 : 500,
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      justifyContent: 'center',
                      textAlign: 'left',
                      transition: 'all 0.15s ease-in-out',
                    }}
                  >
                    <span style={{ fontSize: '0.95rem' }}>{lang.native}</span>
                    <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>{t(lang.labelKey)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Optional Manual PDF Upload */}
          <div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.875rem',
                fontWeight: 600,
                color: '#d4d4d8',
                marginBottom: '0.5rem',
              }}
            >
              <FileText size={16} />
              <span>{t('app.capture_manual_label')}</span>
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.85rem 1rem',
                backgroundColor: '#27272a',
                border: '1px dashed #52525b',
                borderRadius: '0.75rem',
                cursor: 'pointer',
                minHeight: '52px',
                boxSizing: 'border-box',
              }}
            >
              <input
                type="file"
                accept="application/pdf"
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    setManualFile(e.target.files[0]);
                  }
                }}
              />
              <FileText size={20} color="#a1a1aa" />
              <span
                style={{
                  fontSize: '0.9rem',
                  color: manualFile ? '#34d399' : '#a1a1aa',
                  minWidth: 0,
                  overflowWrap: 'anywhere',
                }}
              >
                {manualFile ? t('app.capture_manual_attached', { name: manualFile.name }) : t('app.capture_manual_upload')}
              </span>
            </label>
          </div>

          {/* Big Tactile Glove-Friendly Start Button */}
          <button
            type="submit"
            disabled={isStarting}
            style={{
              marginTop: '0.5rem',
              minHeight: '64px',
              backgroundColor: isStarting ? '#78350f' : '#f59e0b',
              color: '#000000',
              border: 'none',
              borderRadius: '0.875rem',
              fontSize: '1.15rem',
              fontWeight: 800,
              letterSpacing: '0.02em',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.75rem',
              padding: '0.75rem 1rem',
              textAlign: 'center',
              cursor: isStarting ? 'not-allowed' : 'pointer',
              boxShadow: '0 10px 15px -3px rgba(245, 158, 11, 0.3)',
              transition: 'background-color 0.2s',
            }}
          >
            <Camera size={26} />
            <span>{isStarting ? t('app.capture_starting') : t('app.capture_start_btn')}</span>
          </button>
        </form>
      </div>
    </div>
  );
};
