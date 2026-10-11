import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import {
  fetchProducts,
  inspectUnit,
  submitInspectionDecision,
  type ProductItem,
  type InspectResponse,
} from '../lib/api';
import { resizeImageForUpload } from '../lib/imageResize';
import logoSvg from '../assets/logo.svg';
import { NewProductForm } from '../components/inspect/NewProductForm';
import { useI18n } from '../i18n';

interface StationHistoryItem {
  inspection_id: string;
  unit_id: string;
  product_name: string;
  verdict: 'ok' | 'defective' | 'needs_review';
  defect: string | null;
  confidence: number;
  total_ms: number;
  timestamp: string;
  human_decision?: string | null;
}

export const InspectScreen: React.FC = () => {
  const { role } = useAuth();
  const navigate = useNavigate();
  const { t, language } = useI18n();

  // Errors are stored as translation keys (or raw API messages, which t() passes through unchanged).
  const verdictLabel = (v: string) =>
    ({ ok: t('quality.inspect_verdict_short_ok'), defective: t('quality.inspect_verdict_short_defective'), needs_review: t('quality.inspect_verdict_short_needs_review') })[v] ?? v;
  const decisionLabel = (d: string) =>
    ({ confirmed_defect: t('quality.inspect_decision_confirmed_defect'), overridden_ok: t('quality.inspect_decision_overridden_ok') })[d] ?? d;
  const roleLabel = (r: string) =>
    ({ master: t('quality.inspect_role_master'), trainee: t('quality.inspect_role_trainee'), supervisor: t('quality.inspect_role_supervisor') })[r] ?? r;

  const [products, setProducts] = useState<ProductItem[]>([]);
  const [selectedProductId, setSelectedProductId] = useState<string>('');
  const [showNewProduct, setShowNewProduct] = useState(false);
  const [unitId, setUnitId] = useState<string>('');
  const [unitIdError, setUnitIdError] = useState<string | null>(null);
  const [mode, setMode] = useState<'few_false_alarms' | 'catch_everything'>('few_false_alarms');

  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageResizedDim, setImageResizedDim] = useState<{ width: number; height: number } | null>(null);

  const [loading, setLoading] = useState<boolean>(false);
  const [result, setResult] = useState<InspectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [history, setHistory] = useState<StationHistoryItem[]>([]);
  const [decisionSubmitting, setDecisionSubmitting] = useState<boolean>(false);

  // QR / Barcode scanning state
  const [scannerOpen, setScannerOpen] = useState<boolean>(false);
  const [scannerSupported, setScannerSupported] = useState<boolean>(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Check BarcodeDetector support
    if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
      setScannerSupported(true);
    }

    // Load available products
    fetchProducts()
      .then((prods) => {
        setProducts(prods);
        if (prods.length > 0) {
          setSelectedProductId(prods[0].id);
          setMode(prods[0].default_mode || 'few_false_alarms');
        }
      })
      .catch((err) => {
        console.error('Failed to load products:', err);
        setError('quality.inspect_error_load_products');
      });
  }, []);

  const selectedProduct = products.find((p) => p.id === selectedProductId);

  // Validate serial regex: ^[A-Za-z0-9._-]{1,64}$
  const validateUnitId = (id: string): boolean => {
    if (!id.trim()) {
      setUnitIdError('quality.inspect_error_serial_required');
      return false;
    }
    const regex = /^[A-Za-z0-9._-]{1,64}$/;
    if (!regex.test(id)) {
      setUnitIdError('quality.inspect_error_serial_format');
      return false;
    }
    setUnitIdError(null);
    return true;
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    try {
      const resized = await resizeImageForUpload(file, 1600);
      setImagePreview(resized.dataUrl);
      setImageBase64(resized.base64);
      setImageResizedDim({ width: resized.width, height: resized.height });
      setResult(null);
    } catch (err) {
      console.error('Image resize failed:', err);
      setError('quality.inspect_error_photo');
    }
  };

  // QR Barcode Scanner modal handling
  const startScanner = async () => {
    setScannerOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const BarcodeDetectorClass = (window as any).BarcodeDetector;
      const detector = new BarcodeDetectorClass({ formats: ['qr_code', 'code_128', 'ean_13'] });

      const interval = setInterval(async () => {
        if (!videoRef.current || videoRef.current.readyState < 2) return;
        try {
          const barcodes = await detector.detect(videoRef.current);
          if (barcodes.length > 0) {
            const raw = barcodes[0].rawValue.trim();
            const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
            if (cleaned) {
              setUnitId(cleaned);
              validateUnitId(cleaned);
              stopScanner();
              clearInterval(interval);
            }
          }
        } catch {
          // detector scan iteration failure
        }
      }, 300);
    } catch (err) {
      console.warn('Camera stream error for barcode scanning:', err);
      stopScanner();
      setError('quality.inspect_error_camera');
    }
  };

  const stopScanner = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setScannerOpen(false);
  };

  const handleInspect = async () => {
    if (!validateUnitId(unitId)) return;
    if (!selectedProductId) {
      setError('quality.inspect_error_select_product');
      return;
    }
    if (!imageBase64) {
      setError('quality.inspect_error_need_photo');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const resp = await inspectUnit({
        product_id: selectedProductId,
        image_b64: imageBase64,
        unit_id: unitId.trim(),
        mode,
      });

      setResult(resp);

      // Add to station history
      const historyEntry: StationHistoryItem = {
        inspection_id: resp.inspection_id,
        unit_id: unitId.trim(),
        product_name: selectedProduct?.name || selectedProductId,
        verdict: resp.ai_verdict,
        defect: resp.defect,
        confidence: resp.confidence,
        total_ms: resp.total_ms,
        timestamp: new Date().toLocaleTimeString(language),
      };
      setHistory((prev) => [historyEntry, ...prev]);
    } catch (err: unknown) {
      console.error('Inspection failed:', err);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = (err as any)?.data?.detail || (err as any)?.message || 'quality.inspect_error_request_failed';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleDecision = async (decision: 'confirmed_defect' | 'overridden_ok') => {
    if (!result) return;
    setDecisionSubmitting(true);
    try {
      await submitInspectionDecision(result.inspection_id, decision);
      // Update history item
      setHistory((prev) =>
        prev.map((item) =>
          item.inspection_id === result.inspection_id
            ? { ...item, human_decision: decision }
            : item
        )
      );
      // Update local result
      setResult((prev) => (prev ? { ...prev, dataset_label: decision } : null));
    } catch (err) {
      console.error('Failed to submit decision:', err);
      setError('quality.inspect_error_decision');
    } finally {
      setDecisionSubmitting(false);
    }
  };

  return (
    <div className="bg-background text-on-surface antialiased min-h-screen flex flex-col font-sans">
      {/* Top Header */}
      <header className="bg-surface-container-low border-b border-outline-variant sticky top-0 z-40">
        <div className="max-w-[720px] mx-auto px-4 min-h-[64px] flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="w-10 h-10 rounded-lg flex items-center justify-center text-on-surface hover:bg-surface-container-high transition-colors cursor-pointer"
              aria-label={t('quality.inspect_back_home')}
            >
              <span className="material-symbols-outlined text-[24px]">arrow_back</span>
            </button>
            <img src={logoSvg} alt="TAKUMI" className="w-7 h-7 rounded-lg object-contain" />
            <div className="min-w-0">
              <h1 className="text-[17px] font-bold text-on-surface leading-tight">
                {t('quality.inspect_title')}
              </h1>
              <p className="text-[11px] text-on-surface-variant uppercase tracking-wider font-semibold">
                {t('quality.inspect_subtitle')}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => navigate('/inspect/gallery')}
            aria-label={t('quality.inspect_try_gallery')}
            className="min-h-[44px] shrink-0 px-3 py-1.5 rounded-lg border border-outline-variant hover:bg-surface-container text-xs font-bold text-primary-container flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">photo_library</span>
            <span className="hidden sm:inline">{t('quality.inspect_try_gallery')}</span>
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="w-full max-w-[720px] mx-auto px-4 py-6 flex-1 flex flex-col gap-6">
        {/* Step 1: Product Selection & Mode */}
        <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-5 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[16px] font-bold text-on-surface flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-primary-container/20 text-primary-container text-xs font-bold flex items-center justify-center">
                1
              </span>
              {t('quality.inspect_step1_title')}
            </h2>
            <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              LIVE
            </span>
          </div>

          {role === 'supervisor' &&
            (showNewProduct ? (
              <NewProductForm
                onCancel={() => setShowNewProduct(false)}
                onCreated={(p) => {
                  setProducts((prev) => [p, ...prev]);
                  setSelectedProductId(p.id);
                  setMode(p.default_mode || 'few_false_alarms');
                  setShowNewProduct(false);
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setShowNewProduct(true)}
                className="min-h-[48px] px-4 rounded-xl bg-surface-container-high text-on-surface text-sm font-bold"
              >
                {t('quality.inspect_new_product_button')}
              </button>
            ))}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-on-surface-variant uppercase mb-1.5" htmlFor="prod-select">
                {t('quality.inspect_target_product')}
              </label>
              <select
                id="prod-select"
                value={selectedProductId}
                onChange={(e) => {
                  setSelectedProductId(e.target.value);
                  const p = products.find((x) => x.id === e.target.value);
                  if (p?.default_mode) setMode(p.default_mode);
                }}
                className="w-full min-h-[52px] bg-surface border border-outline-variant rounded-xl px-3.5 text-[15px] font-medium text-on-surface focus:outline-none focus:ring-2 focus:ring-primary-container cursor-pointer"
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.id})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-on-surface-variant uppercase mb-1.5" htmlFor="mode-select">
                {t('quality.inspect_engine_mode')}
              </label>
              <select
                id="mode-select"
                value={mode}
                onChange={(e) => setMode(e.target.value as 'few_false_alarms' | 'catch_everything')}
                className="w-full min-h-[52px] bg-surface border border-outline-variant rounded-xl px-3.5 text-[15px] font-medium text-on-surface focus:outline-none focus:ring-2 focus:ring-primary-container cursor-pointer"
              >
                <option value="few_false_alarms">{t('quality.inspect_mode_few_false_alarms')}</option>
                <option value="catch_everything">{t('quality.inspect_mode_catch_everything')}</option>
              </select>
            </div>
          </div>

          {selectedProduct && (
            <div className="bg-surface rounded-xl p-3 border border-outline-variant/80 text-xs text-on-surface-variant space-y-1">
              <p className="font-semibold text-on-surface">{selectedProduct.description}</p>
              <p>
                <span className="font-bold text-on-surface">{t('quality.inspect_known_defects')}</span>{' '}
                {selectedProduct.defect_types?.join(', ') || t('quality.inspect_general_surface_flaws')}
              </p>
            </div>
          )}
        </section>

        {/* Step 2: Unit Serial Number & QR Scanner */}
        <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-5 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[16px] font-bold text-on-surface flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-primary-container/20 text-primary-container text-xs font-bold flex items-center justify-center">
                2
              </span>
              {t('quality.inspect_step2_title')}
            </h2>
          </div>

          <div className="space-y-2">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={unitId}
                  onChange={(e) => {
                    setUnitId(e.target.value);
                    if (unitIdError) validateUnitId(e.target.value);
                  }}
                  onBlur={() => {
                    if (unitId) validateUnitId(unitId);
                  }}
                  placeholder={t('quality.inspect_serial_placeholder')}
                  className={`w-full min-h-[56px] bg-surface border rounded-xl px-4 text-[17px] font-mono font-bold text-on-surface focus:outline-none focus:ring-2 focus:ring-primary-container ${
                    unitIdError ? 'border-error ring-1 ring-error' : 'border-outline-variant'
                  }`}
                />
              </div>

              {scannerSupported ? (
                <button
                  type="button"
                  onClick={startScanner}
                  className="min-h-[56px] px-4 rounded-xl border border-outline-variant bg-surface hover:bg-surface-container text-on-surface flex items-center gap-2 font-bold text-sm cursor-pointer transition-colors shrink-0"
                  title={t('quality.inspect_scan_qr_title')}
                >
                  <span className="material-symbols-outlined text-[24px]">qr_code_scanner</span>
                  <span className="hidden sm:inline">{t('quality.inspect_scan_qr')}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => alert(t('quality.inspect_scanner_unsupported'))}
                  className="min-h-[56px] px-3 rounded-xl border border-outline-variant bg-surface opacity-60 text-on-surface-variant flex items-center gap-1.5 text-xs shrink-0 cursor-not-allowed"
                >
                  <span className="material-symbols-outlined text-[20px]">qr_code_scanner</span>
                  <span className="hidden sm:inline">{t('quality.inspect_manual_only')}</span>
                </button>
              )}
            </div>

            {unitIdError && (
              <p className="text-xs font-semibold text-error flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">error</span>
                {t(unitIdError)}
              </p>
            )}
          </div>
        </section>

        {/* Step 3: Photo Capture / Upload (Resized client-side to max 1600px) */}
        <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-5 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[16px] font-bold text-on-surface flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-primary-container/20 text-primary-container text-xs font-bold flex items-center justify-center">
                3
              </span>
              {t('quality.inspect_step3_title')}
            </h2>
            <span className="text-xs text-on-surface-variant font-medium">
              {t('quality.inspect_client_resized')}
            </span>
          </div>

          {/* Hidden File Inputs */}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleFileChange}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />

          {/* Image Preview or Action Buttons */}
          {imagePreview ? (
            <div className="space-y-3">
              <div className="relative rounded-xl overflow-hidden border border-outline-variant bg-black flex items-center justify-center max-h-[360px]">
                <img
                  src={imagePreview}
                  alt={t('quality.inspect_preview_alt')}
                  className="max-h-[360px] w-auto object-contain"
                />
                {imageResizedDim && (
                  <span className="absolute bottom-2 right-2 px-2 py-1 rounded bg-black/75 text-white text-[11px] font-mono">
                    {imageResizedDim.width} × {imageResizedDim.height} px
                  </span>
                )}
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => cameraInputRef.current?.click()}
                  className="flex-1 min-h-[52px] rounded-xl border border-outline-variant bg-surface hover:bg-surface-container text-on-surface font-bold text-[15px] flex items-center justify-center gap-2 cursor-pointer transition-colors"
                >
                  <span className="material-symbols-outlined text-[20px]">photo_camera</span>
                  {t('quality.inspect_retake_photo')}
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-1 min-h-[52px] rounded-xl border border-outline-variant bg-surface hover:bg-surface-container text-on-surface font-bold text-[15px] flex items-center justify-center gap-2 cursor-pointer transition-colors"
                >
                  <span className="material-symbols-outlined text-[20px]">upload_file</span>
                  {t('quality.inspect_choose_other')}
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                className="min-h-[72px] rounded-xl border-2 border-dashed border-primary-container/60 hover:border-primary-container bg-primary-container/10 text-primary-container flex flex-col items-center justify-center gap-1 cursor-pointer transition-all active:scale-[0.99]"
              >
                <span className="material-symbols-outlined text-[28px]">photo_camera</span>
                <span className="font-bold text-[16px]">{t('quality.inspect_take_photo')}</span>
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="min-h-[72px] rounded-xl border border-outline-variant hover:border-primary-container/60 bg-surface text-on-surface flex flex-col items-center justify-center gap-1 cursor-pointer transition-all active:scale-[0.99]"
              >
                <span className="material-symbols-outlined text-[28px]">upload_file</span>
                <span className="font-bold text-[16px]">{t('quality.inspect_upload_image')}</span>
              </button>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="p-3.5 rounded-xl bg-error/10 border border-error/30 text-error text-sm font-semibold flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] shrink-0">error</span>
              <span>{t(error)}</span>
            </div>
          )}

          {/* Inspect Action Button (Min 56px touch target for gloves) */}
          <button
            type="button"
            disabled={loading || !imageBase64}
            onClick={handleInspect}
            className={`w-full min-h-[56px] rounded-xl font-bold text-[18px] flex items-center justify-center gap-2 transition-all shadow-md ${
              loading || !imageBase64
                ? 'bg-surface-container text-on-surface-variant cursor-not-allowed border border-outline-variant'
                : 'bg-primary-container text-on-primary-container hover:brightness-105 active:scale-[0.99] cursor-pointer'
            }`}
          >
            {loading ? (
              <>
                <div className="w-6 h-6 border-3 border-on-primary-container border-t-transparent rounded-full animate-spin" />
                <span>{t('quality.inspect_running')}</span>
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-[24px]">verified</span>
                <span>{t('quality.inspect_inspect_unit')}</span>
              </>
            )}
          </button>
        </section>

        {/* Step 4: Inspection Verdict & Human-In-The-Loop Decision */}
        {result && (
          <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 shadow-md space-y-5 animate-in fade-in duration-200">
            {/* Verdict Banner */}
            <div
              className={`p-5 rounded-2xl text-center space-y-1.5 border ${
                result.ai_verdict === 'ok'
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-800 dark:text-emerald-300'
                  : result.ai_verdict === 'defective'
                  ? 'bg-red-500/15 border-red-500/40 text-red-800 dark:text-red-300'
                  : 'bg-amber-500/15 border-amber-500/40 text-amber-800 dark:text-amber-300'
              }`}
            >
              <div className="flex items-center justify-center gap-2">
                <span className="material-symbols-outlined text-[36px]">
                  {result.ai_verdict === 'ok'
                    ? 'check_circle'
                    : result.ai_verdict === 'defective'
                    ? 'cancel'
                    : 'warning'}
                </span>
                <span className="text-[26px] font-black tracking-wide">
                  {result.ai_verdict === 'ok'
                    ? t('quality.inspect_verdict_ok')
                    : result.ai_verdict === 'defective'
                    ? t('quality.inspect_verdict_defective')
                    : t('quality.inspect_verdict_needs_review')}
                </span>
              </div>
              <p className="text-[14px] font-medium opacity-90">
                {t('quality.inspect_confidence_total', { confidence: (result.confidence * 100).toFixed(1), ms: result.total_ms })}
              </p>
            </div>

            {/* Defect Specifics */}
            {result.ai_verdict === 'defective' && (
              <div className="p-4 rounded-xl bg-surface border border-outline-variant space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs uppercase font-bold text-on-surface-variant">
                    {t('quality.inspect_detected_defect_type')}
                  </span>
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-bold uppercase bg-red-500/20 text-red-600 dark:text-red-400">
                    {result.defect || t('quality.inspect_general_flaw')}
                  </span>
                </div>
                {result.where && (
                  <div>
                    <span className="text-xs uppercase font-bold text-on-surface-variant">
                      {t('quality.inspect_location_description')}
                    </span>
                    <p className="text-[15px] font-medium text-on-surface mt-0.5">{result.where}</p>
                  </div>
                )}
              </div>
            )}

            {/* Per-Stage Timing Breakdown */}
            <div className="bg-surface rounded-xl p-4 border border-outline-variant space-y-2">
              <span className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">
                {t('quality.inspect_stage_telemetry')}
              </span>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1 text-center">
                {result.stages.map((st, i) => (
                  <div key={i} className="p-2.5 rounded-lg bg-surface-container text-xs">
                    <p className="font-bold text-on-surface uppercase">{st.stage}</p>
                    <p className="text-on-surface-variant font-mono">{t('quality.inspect_ms', { ms: st.ms })}</p>
                    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold mt-1 bg-surface-container-high">
                      {st.defective ? t('quality.inspect_stage_flagged') : t('quality.inspect_stage_clean')}
                    </span>
                  </div>
                ))}
                <div className="p-2.5 rounded-lg bg-surface-container text-xs">
                  <p className="font-bold text-on-surface uppercase">{t('quality.inspect_total_api')}</p>
                  <p className="text-on-surface-variant font-mono">{t('quality.inspect_ms', { ms: result.total_ms })}</p>
                  <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold mt-1 bg-surface-container-high">
                    {result.mode}
                  </span>
                </div>
              </div>
            </div>

            {/* Human-In-The-Loop Decision (Only supervisor can confirm or override) */}
            {(result.ai_verdict === 'defective' || result.ai_verdict === 'needs_review') && (
              <div className="pt-2 border-t border-outline-variant space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-[15px] font-bold text-on-surface">{t('quality.inspect_decision_gate')}</h3>
                    <p className="text-xs text-on-surface-variant">
                      {t('quality.inspect_decision_gate_desc')}
                    </p>
                  </div>
                  <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-primary-container/20 text-primary-container">
                    {t('quality.inspect_supervisor_gate')}
                  </span>
                </div>

                {role === 'supervisor' ? (
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      disabled={decisionSubmitting}
                      onClick={() => handleDecision('confirmed_defect')}
                      className="min-h-[56px] rounded-xl font-bold text-[16px] bg-red-600 hover:bg-red-700 text-white flex items-center justify-center gap-2 cursor-pointer transition-all active:scale-[0.99] shadow"
                    >
                      <span className="material-symbols-outlined text-[20px]">thumb_down</span>
                      <span>{t('quality.inspect_confirm_defect')}</span>
                    </button>
                    <button
                      type="button"
                      disabled={decisionSubmitting}
                      onClick={() => handleDecision('overridden_ok')}
                      className="min-h-[56px] rounded-xl font-bold text-[16px] bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center gap-2 cursor-pointer transition-all active:scale-[0.99] shadow"
                    >
                      <span className="material-symbols-outlined text-[20px]">thumb_up</span>
                      <span>{t('quality.inspect_override_ok')}</span>
                    </button>
                  </div>
                ) : (
                  <div className="p-3 rounded-xl bg-surface border border-outline-variant text-xs text-on-surface-variant text-center">
                    {t('quality.inspect_review_note', { role: roleLabel(role || 'trainee') })
                      .split('{status}')
                      .map((part, i) => (
                        <React.Fragment key={i}>
                          {i > 0 && <strong className="text-on-surface">{t('quality.inspect_status_needs_review')}</strong>}
                          {part}
                        </React.Fragment>
                      ))}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* Station History */}
        {history.length > 0 && (
          <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-5 shadow-sm space-y-3">
            <h2 className="text-[15px] font-bold text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-primary-container">history</span>
              {t('quality.inspect_history_title', { count: history.length })}
            </h2>

            <div className="space-y-2">
              {history.map((item, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-xl bg-surface border border-outline-variant flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-[13px] text-on-surface">{item.unit_id}</span>
                      <span className="text-on-surface-variant">• {item.product_name}</span>
                    </div>
                    <p className="text-on-surface-variant mt-0.5">
                      {item.defect ? `${t('quality.inspect_history_defect', { defect: item.defect })} • ` : ''}
                      {t('quality.inspect_history_conf', { confidence: (item.confidence * 100).toFixed(0), ms: item.total_ms })}
                      {item.human_decision && ` • ${t('quality.inspect_history_decision', { decision: decisionLabel(item.human_decision) })}`}
                    </p>
                  </div>

                  <span
                    className={`px-2.5 py-1 rounded-full font-bold uppercase text-[11px] ${
                      item.verdict === 'ok'
                        ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                        : item.verdict === 'defective'
                        ? 'bg-red-500/20 text-red-600 dark:text-red-400'
                        : 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {verdictLabel(item.verdict)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* QR Scanner Modal */}
      {scannerOpen && (
        <div className="fixed inset-0 bg-black/80 z-50 flex flex-col items-center justify-center p-4">
          <div className="bg-surface-container-high rounded-2xl max-w-sm w-full p-4 border border-outline-variant space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-on-surface text-[16px]">{t('quality.inspect_scanner_title')}</h3>
              <button
                type="button"
                onClick={stopScanner}
                aria-label={t('quality.inspect_scanner_close')}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-on-surface hover:bg-surface-container cursor-pointer"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>
            <div className="rounded-xl overflow-hidden aspect-square bg-black relative flex items-center justify-center">
              <video ref={videoRef} className="w-full h-full object-cover" autoPlay playsInline muted />
              <div className="absolute inset-8 border-2 border-primary-container rounded-lg pointer-events-none animate-pulse" />
            </div>
            <p className="text-xs text-center text-on-surface-variant">
              {t('quality.inspect_scanner_hint')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default InspectScreen;
