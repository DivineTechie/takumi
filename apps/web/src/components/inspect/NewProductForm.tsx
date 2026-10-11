import React, { useState } from 'react';
import { ApiError, createProductWithImages, type ProductItem } from '../../lib/api';
import { resizeImageForUpload } from '../../lib/imageResize';
import { useI18n } from '../../i18n';

/**
 * Supervisor form: register a product for end-of-line inspection from 3 photos of good units.
 * The photos become the known-good references every inspection compares against.
 */
export const NewProductForm: React.FC<{ onCreated: (p: ProductItem) => void; onCancel: () => void }> = ({
  onCreated,
  onCancel,
}) => {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [defects, setDefects] = useState('');
  const [photos, setPhotos] = useState<(string | null)[]>([null, null, null]);
  const [previews, setPreviews] = useState<(string | null)[]>([null, null, null]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (i: number, file: File | undefined) => {
    if (!file) return;
    try {
      // Small enough that three photos fit one request, still above the size the inspector uses.
      const r = await resizeImageForUpload(file, 1280, 0.82);
      setPhotos((p) => p.map((x, j) => (j === i ? r.base64 : x)));
      setPreviews((p) => p.map((x, j) => (j === i ? r.dataUrl : x)));
    } catch {
      setError(t('quality.newproduct_error_photo'));
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2 || description.trim().length < 3 || photos.some((p) => !p)) {
      setError(t('quality.newproduct_error_incomplete'));
      return;
    }
    setBusy(true);
    try {
      const product = await createProductWithImages({
        name: name.trim(),
        description: description.trim(),
        defect_types: defects
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean),
        images_b64: photos as string[],
      });
      onCreated(product);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('quality.newproduct_error_save'));
    } finally {
      setBusy(false);
    }
  };

  const inputClass = 'w-full min-h-[48px] mt-1 rounded-lg bg-surface border border-outline-variant px-3 text-on-surface';

  return (
    <form onSubmit={submit} className="bg-surface-container rounded-2xl p-4 space-y-3" aria-label={t('quality.newproduct_title')}>
      <h3 className="font-bold text-on-surface">{t('quality.newproduct_title')}</h3>
      <label className="block text-sm text-on-surface-variant">
        {t('quality.newproduct_name')}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('quality.newproduct_name_placeholder')} className={inputClass} />
      </label>
      <label className="block text-sm text-on-surface-variant">
        {t('quality.newproduct_description')}
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('quality.newproduct_description_placeholder')}
          className={inputClass}
        />
      </label>
      <label className="block text-sm text-on-surface-variant">
        {t('quality.newproduct_defects')}
        <input
          value={defects}
          onChange={(e) => setDefects(e.target.value)}
          placeholder={t('quality.newproduct_defects_placeholder')}
          className={inputClass}
        />
      </label>
      <div>
        <div className="text-sm text-on-surface-variant mb-1">{t('quality.newproduct_photos_hint')}</div>
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <label
              key={i}
              className="aspect-square rounded-xl bg-surface border border-dashed border-outline-variant flex items-center justify-center cursor-pointer overflow-hidden"
            >
              {previews[i] ? (
                <img src={previews[i] as string} alt={t('quality.newproduct_good_unit_alt', { n: i + 1 })} className="w-full h-full object-cover" />
              ) : (
                <span className="text-xs text-on-surface-variant text-center px-1 break-words">{t('quality.newproduct_photo_n', { n: i + 1 })}</span>
              )}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                aria-label={t('quality.newproduct_photo_n', { n: i + 1 })}
                onChange={(e) => pick(i, e.target.files?.[0])}
              />
            </label>
          ))}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="min-h-[56px] flex-1 rounded-xl bg-primary text-on-primary font-bold disabled:opacity-50">
          {busy ? t('quality.newproduct_saving') : t('quality.newproduct_save')}
        </button>
        <button type="button" onClick={onCancel} className="min-h-[56px] px-4 rounded-xl bg-surface-container-high text-on-surface">
          {t('quality.newproduct_cancel')}
        </button>
      </div>
    </form>
  );
};
