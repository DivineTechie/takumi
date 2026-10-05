/* eslint-disable react-refresh/only-export-components */
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import React from 'react';
import { auth } from './firebase';
import { getMe } from './api';

export type Role = 'trainee' | 'master' | 'supervisor';

export interface AuthContextType {
  user: User | null;
  role: Role | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  sendSignInLink: (email: string) => Promise<void>;
  finishSignInWithEmail: (email?: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshRole: () => Promise<void>;
}

const googleProvider = new GoogleAuthProvider();

export async function signInWithGoogleAction(): Promise<void> {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err: unknown) {
    const error = err as { code?: string };
    if (
      error.code === 'auth/popup-blocked' ||
      error.code === 'auth/popup-closed-by-user' ||
      error.code === 'auth/cancelled-popup-request'
    ) {
      await signInWithRedirect(auth, googleProvider);
    } else {
      throw err;
    }
  }
}

export async function sendEmailSignInLink(email: string): Promise<void> {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://takumi-cup-2026.web.app';
  const actionCodeSettings = {
    url: `${origin}/signin/finish`,
    handleCodeInApp: true,
  };
  await sendSignInLinkToEmail(auth, email, actionCodeSettings);
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('emailForSignIn', email);
  }
}

export async function completeEmailSignIn(email?: string): Promise<User> {
  if (typeof window === 'undefined') {
    throw new Error('Window is not defined');
  }

  if (!isSignInWithEmailLink(auth, window.location.href)) {
    throw new Error('Not a valid email sign-in link');
  }

  const targetEmail = email || window.localStorage.getItem('emailForSignIn');
  if (!targetEmail) {
    throw new Error('Email is required to complete sign-in');
  }

  const credential = await signInWithEmailLink(auth, targetEmail, window.location.href);
  window.localStorage.removeItem('emailForSignIn');
  return credential.user;
}

export async function signOutAction(): Promise<void> {
  await firebaseSignOut(auth);
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(() => {
    if (typeof window !== 'undefined' && (window as unknown as { __TAKUMI_MOCK_AUTH__?: { user: User; role: Role } }).__TAKUMI_MOCK_AUTH__) {
      return (window as unknown as { __TAKUMI_MOCK_AUTH__: { user: User; role: Role } }).__TAKUMI_MOCK_AUTH__.user;
    }
    return null;
  });
  const [role, setRole] = useState<Role | null>(() => {
    if (typeof window !== 'undefined' && (window as unknown as { __TAKUMI_MOCK_AUTH__?: { user: User; role: Role } }).__TAKUMI_MOCK_AUTH__) {
      return (window as unknown as { __TAKUMI_MOCK_AUTH__: { user: User; role: Role } }).__TAKUMI_MOCK_AUTH__.role;
    }
    return null;
  });
  const [loading, setLoading] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && (window as unknown as { __TAKUMI_MOCK_AUTH__?: { user: User; role: Role } }).__TAKUMI_MOCK_AUTH__) {
      return false;
    }
    return true;
  });

  const syncUserRole = async (currentUser: User) => {
    try {
      const me = await getMe();
      if (me.role_assigned) {
        // Force refresh ID token to obtain newly assigned custom claim
        await currentUser.getIdToken(true);
      }
      setRole(me.role as Role);
    } catch (err) {
      console.error('Failed to sync user role via /api/me:', err);
      // Fallback to checking existing token claims
      try {
        const tokenResult = await currentUser.getIdTokenResult();
        const claimRole = tokenResult.claims.role as Role | undefined;
        if (claimRole) {
          setRole(claimRole);
        }
      } catch {
        // ignore
      }
    }
  };

  useEffect(() => {
    const mockAuth = typeof window !== 'undefined' ? (window as unknown as { __TAKUMI_MOCK_AUTH__?: { user: User; role: Role } }).__TAKUMI_MOCK_AUTH__ : null;
    if (mockAuth) {
      setUser(mockAuth.user);
      setRole(mockAuth.role);
      setLoading(false);
      return;
    }

    const redirectPromise = getRedirectResult(auth);
    if (redirectPromise && typeof redirectPromise.then === 'function') {
      redirectPromise
        .then((res) => {
          if (res?.user) {
            syncUserRole(res.user);
          }
        })
        .catch((err) => {
          console.warn('Redirect sign-in error:', err);
        });
    }

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        await syncUserRole(currentUser);
      } else {
        setRole(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const refreshRole = async () => {
    if (auth.currentUser) {
      await syncUserRole(auth.currentUser);
    }
  };

  const value: AuthContextType = {
    user,
    role,
    loading,
    signInWithGoogle: signInWithGoogleAction,
    sendSignInLink: sendEmailSignInLink,
    finishSignInWithEmail: async (email) => {
      const newUser = await completeEmailSignIn(email);
      setUser(newUser);
      await syncUserRole(newUser);
    },
    signOut: signOutAction,
    refreshRole,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
