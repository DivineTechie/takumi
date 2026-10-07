import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isSignInWithEmailLink } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { useAuth } from '../lib/auth';

export const SignInFinishScreen: React.FC = () => {
  const { finishSignInWithEmail } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [needsEmail, setNeedsEmail] = useState(false);
  const [statusText, setStatusText] = useState('Verifying your sign-in link...');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const completeAuth = useCallback(
    async (emailToUse: string) => {
      try {
        setSubmitting(true);
        setError(null);
        setStatusText('Signing you in...');
        await finishSignInWithEmail(emailToUse);
        navigate('/', { replace: true });
      } catch (err: unknown) {
        console.error('Error completing email sign-in:', err);
        const msg = err instanceof Error ? err.message : 'Failed to complete sign-in';
        setError(msg);
        setSubmitting(false);
      }
    },
    [finishSignInWithEmail, navigate]
  );

  useEffect(() => {
    if (!isSignInWithEmailLink(auth, window.location.href)) {
      setError('This sign-in link is invalid or has expired. Please request a new link.');
      return;
    }

    const savedEmail = window.localStorage.getItem('emailForSignIn');
    if (savedEmail) {
      completeAuth(savedEmail);
    } else {
      setNeedsEmail(true);
      setStatusText('Please confirm your email address to complete sign-in.');
    }
  }, [completeAuth]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      setError('Please enter your email');
      return;
    }
    completeAuth(email);
  };

  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-center p-6 text-on-surface">
      <div className="w-full max-w-[420px] bg-surface-container-low border border-outline-variant rounded-2xl p-8 flex flex-col items-center text-center shadow-lg">
        <div className="w-16 h-16 rounded-2xl bg-surface-container-high border border-outline-variant flex items-center justify-center mb-6 text-primary-container">
          <span className="material-symbols-outlined text-[36px]">mail</span>
        </div>

        <h1 className="font-headline-md font-bold mb-3">Sign in with Email Link</h1>
        <p className="font-body-md text-on-surface-variant mb-6">{statusText}</p>

        {error && (
          <div className="w-full p-4 mb-6 rounded-xl bg-error-container/30 border border-error/50 text-error text-left text-sm">
            {error}
          </div>
        )}

        {needsEmail && !error && (
          <form onSubmit={handleSubmit} className="w-full space-y-4">
            <div>
              <label htmlFor="confirm-email" className="block text-left text-sm font-semibold mb-2 text-on-surface">
                Confirm your email
              </label>
              <input
                id="confirm-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                className="w-full min-h-[56px] h-[56px] bg-surface-container border border-outline-variant rounded-xl px-4 text-on-surface focus:outline-none focus:ring-2 focus:ring-primary-container text-base"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full min-h-[56px] h-[56px] bg-primary-container hover:brightness-105 active:scale-[0.99] text-on-primary-container font-bold rounded-xl flex items-center justify-center transition-all disabled:opacity-50"
            >
              {submitting ? 'Signing in...' : 'Complete Sign In'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export default SignInFinishScreen;
