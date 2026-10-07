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

/**
 * Creates an animated 1280x720 simulated workbench MediaStream
 * for development or environments without a physical camera.
 */
function createSimulatedStream(): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');

  let frame = 0;
  const draw = () => {
    frame++;
    if (!ctx) return;

    // Dark industrial workbench background
    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, 0, 1280, 720);

    // Workbench grid
    ctx.strokeStyle = '#27272a';
    ctx.lineWidth = 1;
    for (let x = 0; x < 1280; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 720);
      ctx.stroke();
    }
    for (let y = 0; y < 720; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(1280, y);
      ctx.stroke();
    }

    // DIN Rail Terminal Block representation
    ctx.fillStyle = '#3f3f46';
    ctx.fillRect(340, 260, 600, 200);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 4;
    ctx.strokeRect(340, 260, 600, 200);

    // Terminal slots 1 to 4
    for (let i = 0; i < 4; i++) {
      const tx = 380 + i * 140;
      ctx.fillStyle = '#27272a';
      ctx.fillRect(tx, 290, 100, 140);
      ctx.strokeStyle = '#71717a';
      ctx.lineWidth = 2;
      ctx.strokeRect(tx, 290, 100, 140);

      // Screw terminal circle
      ctx.fillStyle = '#d4d4d8';
      ctx.beginPath();
      ctx.arc(tx + 50, 325, 14, 0, Math.PI * 2);
      ctx.fill();

      // Number badge
      ctx.fillStyle = '#f59e0b';
      ctx.font = 'bold 24px monospace';
      ctx.fillText(`${i + 1}`, tx + 42, 385);
    }

    // Animated simulated hand / wire movement
    const wave = Math.sin(frame * 0.05) * 40;
    ctx.fillStyle = '#3b82f6'; // Blue neutral wire
    ctx.beginPath();
    ctx.arc(430, 325 + wave, 12, 0, Math.PI * 2);
    ctx.fill();

    // Live Feed HUD watermark
    ctx.fillStyle = '#22c55e';
    ctx.font = 'bold 20px monospace';
    ctx.fillText('• LIVE WORKBENCH CAM (1280x720 30FPS)', 60, 80);

    ctx.fillStyle = '#a1a1aa';
    ctx.font = '16px monospace';
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    ctx.fillText(`${now} UTC`, 60, 110);
  };

  const timer = setInterval(draw, 1000 / 30);
  draw();

  const stream = canvas.captureStream(30);

  // Audio track simulation (silent audio context destination)
  try {
    const AudioContextClass =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioContextClass) {
      const audioCtx = new AudioContextClass();
      const dest = audioCtx.createMediaStreamDestination();
      const silentOsc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      gain.gain.value = 0.001; // virtually silent
      silentOsc.connect(gain);
      gain.connect(dest);
      silentOsc.start();
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    }
  } catch (e) {
    console.warn('Audio track simulation skipped:', e);
  }

  stream.getTracks().forEach((track) => {
    track.addEventListener('ended', () => clearInterval(timer));
  });

  return stream;
}

export function useCameraStream(): UseCameraStreamResult {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Keep video element synchronized whenever stream or videoRef becomes available
  useEffect(() => {
    if (videoRef.current && stream) {
      if (videoRef.current.srcObject !== stream) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch((err) => {
          console.warn('Video playback autoplay warning:', err);
        });
      }
    }
  }, [stream]);

  const startCamera = useCallback(async (): Promise<MediaStream | null> => {
    setIsStarting(true);
    setError(null);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('navigator.mediaDevices.getUserMedia is not supported');
      }

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
      if (import.meta.env.DEV) {
        console.warn('Physical camera unavailable, falling back to simulated workbench feed (DEV only):', err);
        // Fallback to simulated workbench stream in DEV so developer / tester is never blocked
        const simulatedStream = createSimulatedStream();
        setStream(simulatedStream);

        if (videoRef.current) {
          videoRef.current.srcObject = simulatedStream;
          videoRef.current.play().catch((playErr) => {
            console.warn('Simulated stream autoplay warning:', playErr);
          });
        }

        setIsStarting(false);
        return simulatedStream;
      }

      const msg = err instanceof Error ? err.message : 'Camera or microphone access denied or unavailable.';
      setError(`Camera error: ${msg}`);
      setIsStarting(false);
      throw err;
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
