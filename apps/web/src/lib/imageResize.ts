/**
 * Client-side image resizing utility for phone camera uploads.
 * Resizes images on the client to max 1600 px on the longest side
 * and encodes to JPEG before uploading (fast on mobile data).
 */

export interface ResizedImageResult {
  blob: Blob;
  base64: string; // raw base64 data without data URL prefix
  dataUrl: string; // full data URL for preview
  width: number;
  height: number;
}

export async function resizeImageForUpload(
  fileOrBlob: File | Blob,
  maxLongSide = 1600,
  quality = 0.85
): Promise<ResizedImageResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to decode image data'));
      img.onload = () => {
        let { width, height } = img;
        const longSide = Math.max(width, height);

        if (longSide > maxLongSide) {
          const scale = maxLongSide / longSide;
          width = Math.max(1, Math.round(width * scale));
          height = Math.max(1, Math.round(height * scale));
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas 2D context not available'));
          return;
        }

        // Draw and export to JPEG
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('Failed to convert canvas to JPEG blob'));
              return;
            }
            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            const base64 = dataUrl.split(',')[1] || '';
            resolve({
              blob,
              base64,
              dataUrl,
              width,
              height,
            });
          },
          'image/jpeg',
          quality
        );
      };

      if (typeof reader.result === 'string') {
        img.src = reader.result;
      } else {
        reject(new Error('Invalid reader result'));
      }
    };

    reader.readAsDataURL(fileOrBlob);
  });
}
