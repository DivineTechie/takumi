import React, { useState } from 'react';
import { validateTraineeName } from '../lib/nameValidation';
import { useI18n } from '../i18n';

interface NamePromptDialogProps {
  onSave: (name: string) => Promise<void>;
}

export const NamePromptDialog: React.FC<NamePromptDialogProps> = ({ onSave }) => {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!validateTraineeName(trimmed)) {
      setError(t('station.name_prompt_error_invalid'));
      return;
    }

    try {
      setSubmitting(true);
      setError(null);
      await onSave(trimmed);
    } catch (err) {
      console.error('Failed to update display name:', err);
      setError(t('station.name_prompt_error_save'));
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="name-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in"
    >
      <div className="w-full max-w-md bg-surface text-on-surface border border-outline-variant rounded-2xl p-6 shadow-2xl space-y-5">
        <div className="space-y-1.5">
          <h2 id="name-dialog-title" className="text-xl font-bold text-on-surface">
            {t('station.name_prompt_title')}
          </h2>
          <p className="text-sm text-on-surface-variant">
            {t('station.name_prompt_desc')}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="first-name-input" className="sr-only">
              {t('station.name_prompt_label')}
            </label>
            <input
              id="first-name-input"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              placeholder={t('station.name_prompt_placeholder')}
              maxLength={30}
              autoFocus
              disabled={submitting}
              className="w-full h-12 px-4 rounded-xl bg-surface-container-high border border-outline-variant text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary-container text-[16px]"
            />
            {error && (
              <p className="text-xs text-rose-500 mt-1.5 font-medium">{error}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="w-full min-h-[48px] px-3 py-2 bg-primary-container text-on-primary-container hover:brightness-105 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed rounded-xl font-bold text-[16px] flex items-center justify-center transition-all cursor-pointer shadow-sm"
          >
            {submitting ? t('station.name_prompt_saving') : t('station.name_prompt_save_btn')}
          </button>
        </form>
      </div>
    </div>
  );
};
