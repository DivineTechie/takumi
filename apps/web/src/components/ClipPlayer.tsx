import React, { useEffect, useRef, useState, useCallback } from 'react';

export interface ClipPlayerProps {
  url: string;
  start_s?: number;
  end_s?: number;
  kind: 'master_clip' | 'mistake_clip';
  why?: string;
  why_lang?: string;
  translated?: boolean;
  label?: string;
  onClose: (playedSeconds: number) => void;
  isDesktopInline?: boolean;
}

export const ClipPlayer: React.FC<ClipPlayerProps> = ({
  url,
  start_s = 0,
  end_s,
  kind,
  why,
  translated = true,
  label,
  onClose,
  isDesktopInline = false,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [needsUserUnmute, setNeedsUserUnmute] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const startTimeRef = useRef<number>(Date.now());
  const completedRef = useRef(false);

  const duration = Math.max(0.1, (end_s !== undefined ? end_s : 10) - start_s);

  const handleFinish = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    const elapsedSeconds = Math.min(duration, (Date.now() - startTimeRef.current) / 1000);
    onClose(elapsedSeconds);
  }, [duration, onClose]);

  useEffect(() => {
    startTimeRef.current = Date.now();
    completedRef.current = false;

    // Hard safety timeout cap at 25 seconds
    const safetyTimer = setTimeout(() => {
      handleFinish();
    }, 25000);

    return () => clearTimeout(safetyTimer);
  }, [handleFinish]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onLoadedMetadata = () => {
      if (start_s > 0) {
        video.currentTime = start_s;
      }
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            setIsPlaying(true);
            setNeedsUserUnmute(false);
          })
          .catch(() => {
            // Autoplay unmuted blocked by browser policy -> fall back to muted
            video.muted = true;
            setNeedsUserUnmute(true);
            video
              .play()
              .then(() => setIsPlaying(true))
              .catch((err) => console.warn('Muted autoplay also blocked:', err));
          });
      }
    };

    const onTimeUpdate = () => {
      const current = video.currentTime;
      if (end_s !== undefined && current >= end_s) {
        video.pause();
        handleFinish();
        return;
      }
      const played = Math.max(0, current - start_s);
      setProgressPct(Math.min(100, (played / duration) * 100));
    };

    const onEnded = () => {
      handleFinish();
    };

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('ended', onEnded);

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('ended', onEnded);
    };
  }, [url, start_s, end_s, duration, handleFinish]);

  const unmuteAudio = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (video) {
      video.muted = false;
      setNeedsUserUnmute(false);
    }
  };

  const isMaster = kind === 'master_clip';

  return (
    <div
      role="dialog"
      aria-label={isMaster ? "Master demonstration" : "Mistake demonstration"}
      className={`z-40 bg-zinc-900/95 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden backdrop-blur-md flex flex-col ${
        isDesktopInline
          ? 'w-full'
          : 'fixed bottom-28 right-4 lg:static lg:bottom-auto lg:right-auto lg:w-full w-[52%] min-w-[220px] max-w-[340px] lg:max-w-none lg:mb-3'
      }`}
    >
      {/* Header with badge & large 44px close button */}
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-950/80 border-b border-zinc-800">
        <div className="flex items-center gap-1.5 overflow-hidden">
          {isMaster ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40 truncate">
              Master's own demonstration
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-red-950/80 text-red-300 border border-red-500 truncate">
              {label || 'AI-generated example of the wrong way'}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => handleFinish()}
          className="min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-amber-400"
          aria-label="Close clip"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Video Container */}
      <div className="relative aspect-video bg-black flex items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          src={url}
          playsInline
          preload="auto"
          className="w-full h-full object-contain"
        />

        {/* Unmute button when browser autoplay policy mutes audio */}
        {needsUserUnmute && isPlaying && (
          <button
            type="button"
            onClick={unmuteAudio}
            className="absolute inset-0 m-auto w-fit h-fit px-3 py-2 bg-black/80 hover:bg-black text-white text-xs font-bold rounded-lg border border-amber-400/60 shadow-lg flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-amber-400"
          >
            <span>🔊</span>
            <span>Tap for sound</span>
          </button>
        )}

        {/* Progress bar */}
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-800">
          <div
            className={`h-full transition-all duration-100 ${isMaster ? 'bg-amber-400' : 'bg-red-500'}`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Subtitles (why explanation) */}
      {why && (
        <div className="p-3 bg-zinc-950 text-white flex flex-col gap-1.5 border-t border-zinc-800/80">
          <div className="flex items-center gap-2">
            {!translated && (
              <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700 uppercase tracking-wider">
                translated
              </span>
            )}
          </div>
          <p className="text-[20px] font-bold leading-snug text-zinc-100">{why}</p>
        </div>
      )}
    </div>
  );
};
