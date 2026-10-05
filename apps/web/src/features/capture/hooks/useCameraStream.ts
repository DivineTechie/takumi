import { useState, useRef, useCallback, useEffect } from 'react';

export interface UseCameraStreamResult {
  stream: MediaStream | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  error: string | null;
  isStarting: boolean;
  startCamera: () => Promise<MediaStream | null>;
  stopCamera: () => void;
  captureFrameBase64: () => string | null;
}

export function useCameraStream(): UseCameraStreamResult {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const startCamera = useCallback(async (): Promise<MediaStream | null> => {
    setIsStarting(true);
    setError(null);

    try {
      // Prefer back camera (environment) at approximately 1280x720 with audio
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      };

      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      setStream(mediaStream);

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        videoRef.current.play().catch((err) => {
          console.warn('Video playback autoplay warning:', err);
        });
      }

      setIsStarting(false);
      return mediaStream;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to access camera/mic:', msg);
      setError('Camera and microphone permission required. Please allow access.');
      setIsStarting(false);
      return null;
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [stream]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [stream]);

  /**
   * Captures a single JPEG frame at ~768px width, quality 0.7 for Gemini Live.
   * Returns base64 string without data:image/jpeg;base64, header.
   */
  const captureFrameBase64 = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) {
      return null;
    }

    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
    }

    const canvas = canvasRef.current;
    const targetWidth = 768;
    const aspectRatio = (video.videoHeight || 9) / (video.videoWidth || 16);
    const targetHeight = Math.round(targetWidth * aspectRatio);

    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
    const commaIndex = dataUrl.indexOf(',');
    return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  }, []);

  return {
    stream,
    videoRef,
    error,
    isStarting,
    startCamera,
    stopCamera,
    captureFrameBase64,
  };
}
