import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Patch Request constructor in test realm to prevent Node undici AbortSignal cross-realm failure with jsdom
const OriginalRequest = globalThis.Request;
if (OriginalRequest) {
  globalThis.Request = class PatchedRequest extends OriginalRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (init && init.signal) {
        delete init.signal;
      }
      super(input, init);
    }
  };
  if (typeof window !== 'undefined') {
    window.Request = globalThis.Request;
  }
}

// Polyfill window.matchMedia in jsdom
if (typeof window !== 'undefined') {
  window.matchMedia =
    window.matchMedia ||
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
}

// Mock getRedirectResult in jsdom environment where redirect operations are unsupported
vi.mock('firebase/auth', async () => {
  const actual = await vi.importActual<typeof import('firebase/auth')>('firebase/auth');
  return {
    ...actual,
    getRedirectResult: vi.fn().mockReturnValue(Promise.resolve(null)),
  };
});
