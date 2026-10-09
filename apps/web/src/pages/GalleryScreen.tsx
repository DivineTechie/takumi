import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  fetchGallery,
  inspectGallery,
  type GalleryItem,
  type InspectResponse,
} from '../lib/api';
import logoSvg from '../assets/logo.svg';

const CATEGORIES = [
  { id: 'candle', label: 'Candle' },
  { id: 'capsules', label: 'Capsules' },
  { id: 'cashew', label: 'Cashew' },
  { id: 'chewinggum', label: 'Chewing Gum' },
  { id: 'fryum', label: 'Fryum' },
  { id: 'macaroni1', label: 'Macaroni 1' },
  { id: 'macaroni2', label: 'Macaroni 2' },
  { id: 'pcb1', label: 'PCB 1' },
  { id: 'pcb2', label: 'PCB 2' },
  { id: 'pcb3', label: 'PCB 3' },
  { id: 'pcb4', label: 'PCB 4' },
  { id: 'pipe_fryum', label: 'Pipe Fryum' },
];

export const GalleryScreen: React.FC = () => {
  const navigate = useNavigate();

  const [activeCategory, setActiveCategory] = useState<string>('candle');
  const [mode, setMode] = useState<'few_false_alarms' | 'catch_everything'>('few_false_alarms');
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Map from gallery_id to inspection response (stores revealed results)
  const [inspections, setInspections] = useState<Record<string, InspectResponse>>({});
  const [inspectingIds, setInspectingIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchGallery(activeCategory)
      .then((data) => {
        setItems(data);
      })
      .catch((err) => {
        console.error('Failed to load gallery:', err);
        setError('Failed to load VisA benchmark gallery items.');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [activeCategory]);

  const handleInspectTile = async (galleryId: string) => {
    setInspectingIds((prev) => ({ ...prev, [galleryId]: true }));
    try {
      const resp = await inspectGallery({
        gallery_id: galleryId,
        mode,
      });
      setInspections((prev) => ({ ...prev, [galleryId]: resp }));
    } catch (err: unknown) {
      console.error('Gallery inspection error:', err);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = (err as any)?.data?.detail || 'Failed to inspect gallery image';
      alert(msg);
    } finally {
      setInspectingIds((prev) => ({ ...prev, [galleryId]: false }));
    }
  };

  const getEvaluationTag = (resp: InspectResponse) => {
    const rawLabel = (resp.dataset_label || '').toLowerCase().trim();
    const isNormal = rawLabel === 'normal';
    const verdict = resp.ai_verdict;

    if (isNormal && verdict === 'ok') {
      return {
        label: 'HIT — Clean unit verified',
        color: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/40',
        icon: 'check_circle',
      };
    }
    if (!isNormal && verdict === 'defective') {
      return {
        label: `HIT — Defect caught (${resp.defect || resp.dataset_label})`,
        color: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/40',
        icon: 'task_alt',
      };
    }
    if (!isNormal && verdict === 'ok') {
      return {
        label: 'MISS — Anomaly missed',
        color: 'bg-red-500/20 text-red-700 dark:text-red-300 border-red-500/40',
        icon: 'cancel',
      };
    }
    if (isNormal && verdict === 'defective') {
      return {
        label: 'FALSE ALARM — Flagged clean unit',
        color: 'bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500/40',
        icon: 'warning',
      };
    }
    return {
      label: 'REVIEW / TIMEOUT',
      color: 'bg-surface-container text-on-surface-variant border-outline-variant',
      icon: 'hourglass_empty',
    };
  };

  return (
    <div className="bg-background text-on-surface antialiased min-h-screen flex flex-col font-sans">
      {/* Top Header */}
      <header className="bg-surface-container-low border-b border-outline-variant sticky top-0 z-40">
        <div className="max-w-[1200px] mx-auto px-4 min-h-[64px] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/inspect')}
              className="w-10 h-10 rounded-lg flex items-center justify-center text-on-surface hover:bg-surface-container-high transition-colors cursor-pointer"
              aria-label="Back to inspect station"
            >
              <span className="material-symbols-outlined text-[24px]">arrow_back</span>
            </button>
            <img src={logoSvg} alt="TAKUMI" className="w-7 h-7 rounded-lg object-contain" />
            <div>
              <h1 className="text-[17px] font-bold text-on-surface leading-tight">
                Judges' Benchmark Gallery
              </h1>
              <p className="text-[11px] text-on-surface-variant uppercase tracking-wider font-semibold">
                PUBLIC DATA: VisA (Amazon), CC BY 4.0
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'few_false_alarms' | 'catch_everything')}
              className="bg-surface border border-outline-variant rounded-lg text-xs font-bold px-3 py-1.5 text-on-surface focus:outline-none focus:ring-1 focus:ring-primary-container cursor-pointer"
            >
              <option value="few_false_alarms">Few False Alarms (Default)</option>
              <option value="catch_everything">Catch Everything (Recall)</option>
            </select>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="w-full max-w-[1200px] mx-auto px-4 py-6 flex-1 flex flex-col gap-6">
        {/* Banner */}
        <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-5 shadow-xs space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary-container text-[24px]">science</span>
              <h2 className="text-[16px] font-bold text-on-surface">
                Real Benchmark Evaluation Test Units
              </h2>
            </div>
            <span className="text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">
              PUBLIC DATA: VisA (CC BY 4.0)
            </span>
          </div>
          <p className="text-xs text-on-surface-variant max-w-3xl leading-relaxed">
            Test the live Gemini multimodal inspection engine against authentic industrial images from the VisA dataset.
            Labels are concealed until you inspect the part to verify hit and miss decisions honestly without bias.
          </p>
        </section>

        {/* Category Tabs (All 12 categories) */}
        <section className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setActiveCategory(cat.id)}
              className={`min-h-[44px] px-4 py-2 rounded-xl text-xs sm:text-sm font-bold whitespace-nowrap cursor-pointer transition-all border ${
                activeCategory === cat.id
                  ? 'bg-primary-container text-on-primary-container border-primary-container shadow-xs'
                  : 'bg-surface-container-low text-on-surface-variant border-outline-variant hover:bg-surface-container'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </section>

        {/* Gallery Grid */}
        {loading ? (
          <div className="p-16 flex flex-col items-center justify-center gap-3 bg-surface-container-low rounded-2xl border border-outline-variant">
            <div className="w-8 h-8 border-3 border-primary-container border-t-transparent rounded-full animate-spin" />
            <span className="text-xs font-semibold text-on-surface-variant">Loading VisA test images...</span>
          </div>
        ) : error ? (
          <div className="p-8 text-center text-error bg-error/10 border border-error/20 rounded-2xl text-sm font-semibold">
            {error}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {items.map((item) => {
              const resp = inspections[item.id];
              const isInspecting = inspectingIds[item.id];
              const tag = resp ? getEvaluationTag(resp) : null;

              return (
                <div
                  key={item.id}
                  className="bg-surface-container-low border border-outline-variant rounded-2xl overflow-hidden shadow-xs flex flex-col justify-between transition-all hover:border-primary-container/40"
                >
                  <div className="relative aspect-square bg-black/90 flex items-center justify-center overflow-hidden">
                    <img
                      src={item.image_url}
                      alt={item.id}
                      className="w-full h-full object-contain"
                      loading="lazy"
                    />
                    <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/75 text-white/90 text-[10px] font-mono">
                      PUBLIC DATA
                    </span>
                  </div>

                  <div className="p-3.5 space-y-3 flex-1 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="font-mono font-bold text-on-surface truncate">
                          {item.id}
                        </span>
                        <span className="text-[10px] uppercase font-semibold text-on-surface-variant">
                          {item.category}
                        </span>
                      </div>

                      {/* Revealed Result Details */}
                      {resp ? (
                        <div className="space-y-2 pt-1 border-t border-outline-variant/60">
                          {tag && (
                            <div
                              className={`p-2 rounded-lg border text-xs font-bold flex items-center gap-1.5 ${tag.color}`}
                            >
                              <span className="material-symbols-outlined text-[16px]">{tag.icon}</span>
                              <span className="text-[11px] leading-tight">{tag.label}</span>
                            </div>
                          )}

                          <div className="bg-surface rounded-lg p-2 text-[11px] space-y-1 border border-outline-variant">
                            <p className="text-on-surface-variant">
                              <strong className="text-on-surface">Dataset Label:</strong>{' '}
                              <span className="font-semibold capitalize text-primary-container">
                                {resp.dataset_label || 'normal'}
                              </span>
                            </p>
                            <p className="text-on-surface-variant">
                              <strong className="text-on-surface">AI Verdict:</strong>{' '}
                              <span
                                className={`font-bold uppercase ${
                                  resp.ai_verdict === 'ok'
                                    ? 'text-emerald-600'
                                    : resp.ai_verdict === 'defective'
                                    ? 'text-red-600'
                                    : 'text-amber-600'
                                }`}
                              >
                                {resp.ai_verdict}
                              </span>{' '}
                              ({(resp.confidence * 100).toFixed(0)}% • {resp.total_ms} ms)
                            </p>
                          </div>
                        </div>
                      ) : (
                        <p className="text-[11px] text-on-surface-variant italic pt-1">
                          Ground truth concealed until inspected.
                        </p>
                      )}
                    </div>

                    {/* Inspect Button (Min 56px touch target) */}
                    <button
                      type="button"
                      disabled={isInspecting}
                      onClick={() => handleInspectTile(item.id)}
                      className={`w-full min-h-[56px] rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer shadow-xs ${
                        resp
                          ? 'bg-surface border border-outline-variant text-on-surface hover:bg-surface-container'
                          : 'bg-primary-container text-on-primary-container hover:brightness-105 active:scale-[0.99]'
                      }`}
                    >
                      {isInspecting ? (
                        <>
                          <div className="w-5 h-5 border-2 border-primary-container border-t-transparent rounded-full animate-spin" />
                          <span>Inspecting...</span>
                        </>
                      ) : (
                        <>
                          <span className="material-symbols-outlined text-[18px]">
                            {resp ? 'refresh' : 'search'}
                          </span>
                          <span>{resp ? 'Re-inspect' : 'Inspect Unit'}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Attribution Footer */}
      <footer className="w-full border-t border-outline-variant bg-surface-container-low py-4 px-6 text-center text-xs text-on-surface-variant space-y-1">
        <p>
          Images: VisA dataset (Amazon),{' '}
          <a
            href="https://creativecommons.org/licenses/by/4.0/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-primary-container"
          >
            CC BY 4.0
          </a>
          .{' '}
          <a
            href="https://amazon-science.github.io/industrial-anomaly-benchmark/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-primary-container ml-1"
          >
            Dataset Source Link
          </a>
        </p>
        <p className="text-[11px] opacity-75">
          TAKUMI • Dual-Stage Visual Quality Inspection Engine
        </p>
      </footer>
    </div>
  );
};

export default GalleryScreen;
