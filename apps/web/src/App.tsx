import { useMemo } from 'react';
import { RouterProvider } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { I18nProvider } from './i18n';
import { createAppRouter } from './router';

export default function App() {
  const router = useMemo(() => createAppRouter(), []);

  return (
    <I18nProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </I18nProvider>
  );
}
