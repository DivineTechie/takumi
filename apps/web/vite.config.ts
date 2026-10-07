/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

function versionPlugin() {
  return {
    name: 'generate-version-file',
    buildStart() {
      try {
        let commit =
          process.env.SHORT_SHA ||
          (process.env.COMMIT_SHA ? process.env.COMMIT_SHA.slice(0, 7) : '') ||
          process.env.VITE_COMMIT_SHA ||
          '';
        if (!commit) {
          try {
            commit = execSync('git rev-parse --short HEAD').toString().trim();
          } catch {
            commit = 'dev';
          }
        }
        const versionData = {
          version: '1.0.0',
          commit,
          builtAt: new Date().toISOString(),
        };
        const publicDir = path.resolve(__dirname, 'public');
        if (!fs.existsSync(publicDir)) {
          fs.mkdirSync(publicDir, { recursive: true });
        }
        fs.writeFileSync(
          path.resolve(publicDir, 'version.json'),
          JSON.stringify(versionData, null, 2)
        );
      } catch (e) {
        console.warn('Failed to generate version.json:', e);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), versionPlugin()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    env: {
      VITE_FIREBASE_API_KEY: 'test-api-key', // gitleaks:allow
      VITE_FIREBASE_AUTH_DOMAIN: 'takumi-cup-2026.web.app',
      VITE_FIREBASE_PROJECT_ID: 'takumi-cup-2026',
      VITE_FIREBASE_STORAGE_BUCKET: 'takumi-cup-2026.firebasestorage.app',
      VITE_FIREBASE_MESSAGING_SENDER_ID: '123456789012',
      VITE_FIREBASE_APP_ID: '1:123456789012:web:abcdef1234567890',
    },
  },
});
