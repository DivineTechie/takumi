import React from 'react';
import { Link } from 'react-router-dom';

export const EvalsScreen: React.FC = () => {
  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-center p-6 text-center text-on-surface">
      <div className="w-16 h-16 rounded-2xl bg-surface-container-high border border-outline-variant flex items-center justify-center mb-4 text-primary-container">
        <span className="material-symbols-outlined text-[36px]">science</span>
      </div>
      <h1 className="text-[26px] font-bold mb-2">Evaluations & Benchmarks</h1>
      <p className="text-[15px] text-on-surface-variant max-w-md mb-6 leading-relaxed">
        Offline evaluation suite is running across all 12 categories of the public industrial benchmark.
        Full benchmark metrics will be published here upon completion.
      </p>

      <div className="flex flex-col sm:flex-row gap-3 mb-8">
        <Link
          to="/inspect/gallery"
          className="min-h-[56px] px-6 py-3.5 bg-primary-container text-on-primary-container rounded-xl font-bold flex items-center justify-center gap-2 transition-all shadow-sm"
        >
          <span className="material-symbols-outlined text-[20px]">photo_library</span>
          <span>Try VisA Benchmark Gallery</span>
        </Link>
        <Link
          to="/"
          className="min-h-[56px] px-6 py-3.5 bg-surface-container hover:bg-surface-container-high text-on-surface border border-outline-variant rounded-xl font-bold flex items-center justify-center transition-all"
        >
          Return to Home
        </Link>
      </div>

      <footer className="text-xs text-on-surface-variant/80 border-t border-outline-variant/60 pt-4 max-w-sm">
        Benchmark dataset:{' '}
        <a
          href="https://amazon-science.github.io/industrial-anomaly-benchmark/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline text-primary-container font-semibold"
        >
          VisA (Amazon)
        </a>
        ,{' '}
        <a
          href="https://creativecommons.org/licenses/by/4.0/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline text-primary-container"
        >
          CC BY 4.0
        </a>
        .
      </footer>
    </div>
  );
};

export default EvalsScreen;
