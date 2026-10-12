import React from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';

export const NotFoundScreen: React.FC = () => {
  const { t } = useI18n();

  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-center p-6 text-center text-on-surface">
      <div className="w-16 h-16 rounded-2xl bg-surface-container-high border border-outline-variant flex items-center justify-center mb-4 text-primary-container">
        <span className="material-symbols-outlined text-[36px]">error</span>
      </div>
      <h1 className="font-headline-lg font-bold mb-2">{t('app.not_found_title')}</h1>
      <p className="font-body-md text-on-surface-variant max-w-sm mb-6">{t('app.not_found_desc')}</p>
      <Link
        to="/"
        className="min-h-[56px] px-6 py-3.5 bg-primary-container text-on-primary-container rounded-xl font-bold flex items-center justify-center hover:brightness-105 transition-all shadow"
      >
        {t('app.not_found_home')}
      </Link>
    </div>
  );
};

export default NotFoundScreen;
