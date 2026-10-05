import React, { useEffect, useState } from 'react';
import { Square, Sparkles, Wifi, WifiOff, UploadCloud, AlertTriangle } from 'lucide-react';

interface RecordingOverlayProps {
  skillTitle: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentQuestion: string | null;
  questionCount: number;
  isUploading: boolean;
  uploadProgress: number;
  isOnline: boolean;
  onFinish: () => void;
}

export const RecordingOverlay: React.FC<RecordingOverlayProps> = ({
  skillTitle,
  videoRef,
  currentQuestion,
  questionCount,
  isUploading,
  uploadProgress,
  isOnline,
  onFinish,
}) => {
  const [secondsElapsed, setSecondsElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsElapsed((s) => s + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    return `${String(mins).padStart(2, '0')}:${String(remSecs).padStart(2, '0')}`;
  };

  const isNearCap = secondsElapsed >= 12 * 60; // > 12 minutes
  const isCapped = secondsElapsed >= 15 * 60; // 15 minutes limit

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: '#000000',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* Background Live Video Feed */}
      <video
        ref={videoRef}
        playsInline
        autoPlay
        muted
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          position: 'absolute',
          inset: 0,
        }}
      />

      {/* Top HUD Bar */}
      <div
        style={{
          position: 'relative',
          zIndex: 10,
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 100%)',
          padding: '1.25rem 1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {/* Pulsing Recording Indicator & Timer */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.6rem',
              backgroundColor: 'rgba(0, 0, 0, 0.75)',
              backdropFilter: 'blur(8px)',
              padding: '0.4rem 0.85rem',
              borderRadius: '9999px',
              border: '1px solid rgba(255, 255, 255, 0.15)',
            }}
          >
            <div
              style={{
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                backgroundColor: '#ef4444',
                boxShadow: '0 0 10px #ef4444',
                animation: 'pulse 1.5s infinite',
              }}
            />
            <span style={{ color: '#ffffff', fontWeight: 700, fontSize: '1rem', fontVariantNumeric: 'tabular-nums' }}>
              {formatTime(secondsElapsed)}
            </span>
            <span style={{ color: '#a1a1aa', fontSize: '0.75rem', fontWeight: 600 }}>/ 15:00</span>
          </div>

          {/* Network & Live Status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                backgroundColor: 'rgba(245, 158, 11, 0.2)',
                border: '1px solid rgba(245, 158, 11, 0.4)',
                color: '#fbbf24',
                padding: '0.4rem 0.75rem',
                borderRadius: '9999px',
                fontSize: '0.8rem',
                fontWeight: 600,
              }}
            >
              <Sparkles size={14} />
              <span>Gemini Live · {questionCount} Qs</span>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                backgroundColor: isOnline ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                border: isOnline ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid rgba(239, 68, 68, 0.4)',
                color: isOnline ? '#34d399' : '#f87171',
                padding: '0.4rem',
                borderRadius: '50%',
              }}
            >
              {isOnline ? <Wifi size={16} /> : <WifiOff size={16} />}
            </div>
          </div>
        </div>

        {/* Task Title */}
        <div style={{ color: '#e4e4e7', fontSize: '0.95rem', fontWeight: 600, textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
          {skillTitle}
        </div>

        {/* 15m Cap Warning */}
        {isNearCap && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              backgroundColor: 'rgba(245, 158, 11, 0.9)',
              color: '#000000',
              padding: '0.5rem 0.75rem',
              borderRadius: '0.5rem',
              fontWeight: 700,
              fontSize: '0.85rem',
            }}
          >
            <AlertTriangle size={16} />
            <span>Approaching 15-minute capture limit ({formatTime(15 * 60 - secondsElapsed)} remaining).</span>
          </div>
        )}
      </div>

      {/* Center Spacer */}
      <div style={{ flex: 1 }} />

      {/* Floating Question Callout (When Apprentice Asks a "Why" Question) */}
      {currentQuestion && (
        <div
          style={{
            position: 'relative',
            zIndex: 10,
            margin: '0 1rem 1rem 1rem',
            backgroundColor: 'rgba(24, 24, 27, 0.92)',
            backdropFilter: 'blur(12px)',
            border: '2px solid #f59e0b',
            borderRadius: '1rem',
            padding: '1rem 1.25rem',
            boxShadow: '0 15px 30px rgba(0,0,0,0.6)',
            animation: 'fadeIn 0.3s ease-out',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              color: '#fbbf24',
              fontSize: '0.8rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: '0.35rem',
            }}
          >
            <Sparkles size={14} />
            <span>Apprentice Interviewer</span>
          </div>
          <div style={{ color: '#ffffff', fontSize: '1.15rem', fontWeight: 700, lineHeight: 1.35 }}>
            &ldquo;{currentQuestion}&rdquo;
          </div>
        </div>
      )}

      {/* Bottom Controls / Upload HUD */}
      <div
        style={{
          position: 'relative',
          zIndex: 10,
          background: 'linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.5) 70%, rgba(0,0,0,0) 100%)',
          padding: '1rem 1.25rem 2rem 1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        }}
      >
        {isUploading ? (
          <div
            style={{
              backgroundColor: 'rgba(24, 24, 27, 0.95)',
              border: '1px solid #3f3f46',
              borderRadius: '1rem',
              padding: '1.25rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#ffffff' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
                <UploadCloud size={20} color="#f59e0b" />
                <span>Uploading Capture to Cloud Storage...</span>
              </div>
              <span style={{ fontWeight: 700, color: '#fbbf24' }}>{uploadProgress}%</span>
            </div>
            {/* Progress bar track */}
            <div style={{ width: '100%', height: '10px', backgroundColor: '#27272a', borderRadius: '5px', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${uploadProgress}%`,
                  height: '100%',
                  backgroundColor: '#f59e0b',
                  transition: 'width 0.2s ease-out',
                }}
              />
            </div>
            {!isOnline && (
              <span style={{ color: '#f87171', fontSize: '0.85rem' }}>
                Offline: Upload paused. Will automatically resume when reconnected.
              </span>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={onFinish}
            disabled={isCapped}
            style={{
              width: '100%',
              minHeight: '64px',
              backgroundColor: '#ef4444',
              color: '#ffffff',
              border: 'none',
              borderRadius: '1rem',
              fontSize: '1.15rem',
              fontWeight: 800,
              letterSpacing: '0.02em',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.75rem',
              cursor: 'pointer',
              boxShadow: '0 10px 25px -5px rgba(239, 68, 68, 0.5)',
              transition: 'transform 0.1s, background-color 0.2s',
            }}
          >
            <Square size={22} fill="#ffffff" />
            <span>FINISH & FORGE LESSON</span>
          </button>
        )}
      </div>
    </div>
  );
};
