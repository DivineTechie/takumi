import React, { useState } from 'react';
import { ApiError, createProductWithImages, type ProductItem } from '../../lib/api';
import { resizeImageForUpload } from '../../lib/imageResize';

/**
 * Supervisor form: register a product for end-of-line inspection from 3 photos of good units.
 * The photos become the known-good references every inspection compares against.
 */
export const NewProductForm: React.FC<{ onCreated: (p: ProductItem) => void; onCancel: () => void }> = ({
  onCreated,
  onCancel,
}) => {
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
      setError('Could not read that photo.');
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2 || description.trim().length < 3 || photos.some((p) => !p)) {
      setError('Add a name, a short description and 3 photos of good units.');
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
      setError(err instanceof ApiError ? err.message : 'Could not save the product.');
    } finally {
      setBusy(false);
    }
  };

  const inputClass = 'w-full min-h-[48px] mt-1 rounded-lg bg-surface border border-outline-variant px-3 text-on-surface';

  return (
    <form onSubmit={submit} className="bg-surface-container rounded-2xl p-4 space-y-3" aria-label="New product">
      <h3 className="font-bold text-on-surface">New product</h3>
      <label className="block text-sm text-on-surface-variant">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Charger kit" className={inputClass} />
      </label>
      <label className="block text-sm text-on-surface-variant">
        What a finished unit is (one line)
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. charger adapter with cable plugged in, coiled and banded, label on the adapter"
          className={inputClass}
        />
      </label>
      <label className="block text-sm text-on-surface-variant">
        Known defects (comma separated, optional)
        <input
          value={defects}
          onChange={(e) => setDefects(e.target.value)}
          placeholder="e.g. label on the cable, cable not banded, plug not fully in"
          className={inputClass}
        />
      </label>
      <div>
        <div className="text-sm text-on-surface-variant mb-1">3 photos of good units (same angle and distance you will inspect from)</div>
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <label
              key={i}
              className="aspect-square rounded-xl bg-surface border border-dashed border-outline-variant flex items-center justify-center cursor-pointer overflow-hidden"
            >
              {previews[i] ? (
                <img src={previews[i] as string} alt={`Good unit ${i + 1}`} className="w-full h-full object-cover" />
              ) : (
                <span className="text-xs text-on-surface-variant text-center px-1">Photo {i + 1}</span>
              )}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                aria-label={`Photo ${i + 1}`}
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
          {busy ? 'Saving…' : 'Save product'}
        </button>
        <button type="button" onClick={onCancel} className="min-h-[56px] px-4 rounded-xl bg-surface-container-high text-on-surface">
          Cancel
        </button>
      </div>
    </form>
  );
};
