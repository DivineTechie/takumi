import React, { useState } from 'react';
import { validateTraineeName } from '../lib/nameValidation';

interface NamePromptDialogProps {
  onSave: (name: string) => Promise<void>;
}

export const NamePromptDialog: React.FC<NamePromptDialogProps> = ({ onSave }) => {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!validateTraineeName(trimmed)) {
      setError('Please enter a valid first name (letters, spaces and hyphens only, max 30 characters).');
      return;
    }

    try {
      setSubmitting(true);
      setError(null);
      await onSave(trimmed);
    } catch (err) {
      console.error('Failed to update display name:', err);
      setError('Failed to save name. Please try again.');
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
            What should we call you? (first name)
          </h2>
          <p className="text-sm text-on-surface-variant">
            This name will be printed on your official Skill Passport certificates.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="first-name-input" className="sr-only">
              First name
            </label>
            <input
              id="first-name-input"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              placeholder="Your first name (e.g. Tushar, 太郎, Nguyễn)"
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
            className="w-full h-12 bg-primary-container text-on-primary-container hover:brightness-105 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed rounded-xl font-bold text-[16px] flex items-center justify-center transition-all cursor-pointer shadow-sm"
          >
            {submitting ? 'Saving...' : 'Save & Continue'}
          </button>
        </form>
      </div>
    </div>
  );
};
