import { arrayBufferToBase64 } from './audio';

/**
 * Determines whether the video preview and sent frames should be mirrored.
 * Rule: mirrored = (track's facingMode is not "environment"), including when facingMode is missing (laptops).
 */
export function isCameraMirrored(track?: MediaStreamTrack): boolean {
  if (!track) return true;
  const settings = track.getSettings();
  const facingMode = settings.facingMode;
  return facingMode !== 'environment';
}

/**
 * Captures a scaled JPEG frame from an HTMLVideoElement.
 * If mirrored, flips the horizontal axis so the model sees what the trainee sees.
 */
export function captureVideoFrame(
  video: HTMLVideoElement,
  options: {
    targetWidth?: number;
    mirrored?: boolean;
    quality?: number;
  } = {}
): string | null {
  if (!video.videoWidth || !video.videoHeight) {
    return null;
  }

  const targetWidth = options.targetWidth ?? 768;
  const mirrored = options.mirrored ?? false;
  const quality = options.quality ?? 0.75;

  const aspect = video.videoHeight / video.videoWidth;
  const width = Math.min(video.videoWidth, targetWidth);
  const height = Math.round(width * aspect);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  if (mirrored) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }

  ctx.drawImage(video, 0, 0, width, height);

  // Export JPEG data URI and strip 'data:image/jpeg;base64,' prefix
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const base64 = dataUrl.split(',')[1];
  return base64 || null;
}

/**
 * Captures a scaled JPEG frame asynchronously using canvas.toBlob.
 * Encodes off the audio scheduling tick, returning base64.
 */
export function captureVideoFrameAsync(
  video: HTMLVideoElement,
  options: {
    targetWidth?: number;
    mirrored?: boolean;
    quality?: number;
  } = {}
): Promise<string | null> {
  if (!video.videoWidth || !video.videoHeight) {
    return Promise.resolve(null);
  }

  const targetWidth = options.targetWidth ?? 768;
  const mirrored = options.mirrored ?? false;
  const quality = options.quality ?? 0.75;

  const aspect = video.videoHeight / video.videoWidth;
  const width = Math.min(video.videoWidth, targetWidth);
  const height = Math.round(width * aspect);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);

  if (mirrored) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }

  ctx.drawImage(video, 0, 0, width, height);

  return new Promise<string | null>((resolve) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(
        async (blob) => {
          if (!blob) {
            resolve(null);
            return;
          }
          try {
            const buffer = await blob.arrayBuffer();
            resolve(arrayBufferToBase64(buffer));
          } catch {
            resolve(null);
          }
        },
        'image/jpeg',
        quality
      );
    } else {
      // Fallback for environments where toBlob is absent
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      const base64 = dataUrl.split(',')[1];
      resolve(base64 || null);
    }
  });
}
