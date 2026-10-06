import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Skill } from '../../../../shared/schema/ts/skills';
import type { LanguageCode } from '../i18n';
import {
  LANGUAGE_DISPLAY_NAMES,
  type LiveClientStats,
  type LiveConnectionState,
  type LiveTranscriptItem,
} from '../lib/live/types';
import { GeminiLiveClient } from '../lib/live/client';
import { OutputAudioQueue, setupMicCapture, type MicCaptureHandle } from '../lib/live/audio';
import { isCameraMirrored, captureVideoFrame } from '../lib/live/video';
import { SessionCapTimer } from '../lib/live/sessionCap';

interface CoachLiveViewProps {
  skill: Skill;
  language: LanguageCode;
  stream: MediaStream;
  outputAudioContext: AudioContext;
  micAudioContext: AudioContext;
  onEnd: () => void;
}

export const CoachLiveView: React.FC<CoachLiveViewProps> = ({
  skill,
  language,
  stream,
  outputAudioContext,
  micAudioContext,
  onEnd,
}) => {
  const navigate = useNavigate();
  const isDebug = new URLSearchParams(window.location.search).get('debug') === '1';
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [currentStep, setCurrentStep] = useState<number>(1);
  const [connectionState, setConnectionState] = useState<LiveConnectionState>('connecting');
  const [isCoachSpeaking, setIsCoachSpeaking] = useState<boolean>(false);
  const [latestCoachTranscript, setLatestCoachTranscript] = useState<string>('');
  const [latestTraineeTranscript, setLatestTraineeTranscript] = useState<string>('');
  const [showCaption, setShowCaption] = useState<boolean>(false);
  const [sessionWarning, setSessionWarning] = useState<boolean>(false);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(600);
  const [debugOpen, setDebugOpen] = useState<boolean>(true);
  const [stats, setStats] = useState<LiveClientStats>({
    setupCompleteReceived: false,
    setupCompleteMs: null,
    micChunksSent: 0,
    videoFramesSent: 0,
    audioChunksReceived: 0,
    transcriptsReceived: 0,
    lastCloseCode: null,
    lastCloseReason: '',
  });

  const clientRef = useRef<GeminiLiveClient | null>(null);
  const audioQueueRef = useRef<OutputAudioQueue | null>(null);
  const micHandleRef = useRef<MicCaptureHandle | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const captionFadeTimeoutRef = useRef<number | null>(null);
  const videoFrameIntervalRef = useRef<number | null>(null);
  const isMirroredRef = useRef<boolean>(false);

  // Determine mirroring
  const videoTrack = stream.getVideoTracks()[0];
  const mirrored = isCameraMirrored(videoTrack);
  isMirroredRef.current = mirrored;

  const currentStepRef = useRef<number>(currentStep);
  currentStepRef.current = currentStep;

  // Single place to advance current step (plug-in hook for P5 watcher & P4 verifier)
  const advanceStep = useCallback(() => {
    setCurrentStep((prev) => {
      const next = Math.min(skill.steps.length, prev + 1);
      return next;
    });
  }, [skill.steps.length]);

  // Handle caption updates with 4s auto-fade
  const handleTranscript = useCallback((item: LiveTranscriptItem) => {
    if (item.source === 'coach') {
      setLatestCoachTranscript(item.text);
      setIsCoachSpeaking(true);
      setShowCaption(true);
    } else {
      setLatestTraineeTranscript(item.text);
      setShowCaption(true);
    }

    if (captionFadeTimeoutRef.current !== null) {
      window.clearTimeout(captionFadeTimeoutRef.current);
    }

    captionFadeTimeoutRef.current = window.setTimeout(() => {
      setShowCaption(false);
      setIsCoachSpeaking(false);
      captionFadeTimeoutRef.current = null;
    }, 4000);
  }, []);

  useEffect(() => {
    (window as unknown as { __TAKUMI_ADVANCE_STEP__?: () => void }).__TAKUMI_ADVANCE_STEP__ = advanceStep;
    (window as unknown as { __TAKUMI_SIMULATE_TRANSCRIPT__?: (item: LiveTranscriptItem) => void }).__TAKUMI_SIMULATE_TRANSCRIPT__ = handleTranscript;
    return () => {
      delete (window as unknown as { __TAKUMI_ADVANCE_STEP__?: () => void }).__TAKUMI_ADVANCE_STEP__;
      delete (window as unknown as { __TAKUMI_SIMULATE_TRANSCRIPT__?: (item: LiveTranscriptItem) => void }).__TAKUMI_SIMULATE_TRANSCRIPT__;
    };
  }, [advanceStep, handleTranscript]);

  // Initialize Live Client, Audio Queue, and Mic Capture
  useEffect(() => {
    // 1. Output audio queue
    const audioQueue = new OutputAudioQueue(outputAudioContext);
    audioQueueRef.current = audioQueue;

    // 2. Gemini Live Client
    const client = new GeminiLiveClient({
      skill,
      language,
      getCurrentStep: () => currentStepRef.current,
      callbacks: {
        onStateChange: (state) => {
          setConnectionState(state);
        },
        onAudioChunk: (chunk) => {
          setIsCoachSpeaking(true);
          audioQueue.enqueue(chunk);
        },
        onInterrupted: () => {
          audioQueue.flush();
          setIsCoachSpeaking(false);
        },
        onTranscript: (item) => {
          handleTranscript(item);
        },
        onToolCall: async (call) => {
          // Pass 1: reply to every tool call with "not available yet"
          console.log(`Tool call received: ${call.name}`, call.args);
          return { status: 'not available yet' };
        },
        onError: (err) => {
          console.error('Live client error:', err);
        },
        onStatsUpdate: (s) => {
          setStats(s);
        },
      },
    });
    clientRef.current = client;

    // Connect client
    client.connect();

    // Stats polling interval when ?debug=1 is active
    let statsInterval: number | null = null;
    if (isDebug) {
      statsInterval = window.setInterval(() => {
        if (clientRef.current) {
          setStats(clientRef.current.getStats());
        }
      }, 300);
    }

    // 3. Connect microphone capture
    setupMicCapture(stream, micAudioContext, (b64Audio) => {
      client.sendAudio(b64Audio);
    })
      .then((handle) => {
        micHandleRef.current = handle;
      })
      .catch((err) => {
        console.error('Failed to setup mic capture:', err);
      });

    // 4. Video stream interval (at most 1 frame per second, stopped if document hidden)
    videoFrameIntervalRef.current = window.setInterval(() => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      if (videoRef.current) {
        const frame = captureVideoFrame(videoRef.current, {
          targetWidth: 768,
          mirrored: isMirroredRef.current,
        });
        if (frame) {
          client.sendVideoFrame(frame);
        }
      }
    }, 1000);

    // 5. Screen Wake Lock
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
        }
      } catch (err) {
        console.warn('Wake lock request failed:', err);
      }
    };
    requestWakeLock();

    // 6. Visibility Change listener
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        outputAudioContext.resume().catch(() => {});
        micAudioContext.resume().catch(() => {});
        requestWakeLock();

        // If socket closed while hidden, trigger client reconnect
        if (client.getState() === 'closed' || client.getState() === 'error') {
          client.manualRetry();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // 7. Session Cap Timer (10 minutes)
    const sessionTimer = new SessionCapTimer({
      onWarning: () => {
        setSessionWarning(true);
      },
      onTimeout: () => {
        alert('Session time limit of 10 minutes reached.');
        onEnd();
      },
      onTick: (sec) => {
        setRemainingSeconds(sec);
      },
    });
    sessionTimer.start();

    // Attach video stream
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch((err) => console.warn('Video play error:', err));
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (captionFadeTimeoutRef.current !== null) {
        clearTimeout(captionFadeTimeoutRef.current);
      }
      if (videoFrameIntervalRef.current !== null) {
        clearInterval(videoFrameIntervalRef.current);
      }
      if (statsInterval !== null) {
        clearInterval(statsInterval);
      }
      sessionTimer.stop();
      wakeLockRef.current?.release().catch(() => {});
      audioQueue.flush();
      micHandleRef.current?.stop();
      client.close();
    };
  }, [
    skill,
    language,
    stream,
    outputAudioContext,
    micAudioContext,
    handleTranscript,
    onEnd,
    isDebug,
  ]);

  // Handle "Why?" button action
  const handleAskWhy = () => {
    if (clientRef.current) {
      clientRef.current.sendText('The trainee asks: why is this step done this way?');
    }
  };

  // Handle "End" button action
  const handleEndSession = () => {
    if (window.confirm('Are you sure you want to end this coaching session?')) {
      onEnd();
      navigate('/coach');
    }
  };

  const activeStepObj = skill.steps.find((s) => s.n === currentStep) || skill.steps[0];
  const localizedStep = activeStepObj.translations?.[language];
  const activeInstruction = localizedStep?.instruction || activeStepObj.instruction;
  const isTranslatedLive = !localizedStep && language !== 'en';
  const refImage = activeStepObj.card_image_uri || activeStepObj.keyframe_uri;
  const langDisplay = LANGUAGE_DISPLAY_NAMES[language] || { native: language, english: language };

  return (
    <main className="relative w-full max-w-[420px] mx-auto h-[100dvh] overflow-hidden bg-surface-dim shadow-2xl flex flex-col justify-between font-sans select-none">
      {/* 1. Full-Bleed Edge-to-Edge POV Camera View */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`absolute inset-0 w-full h-full object-cover z-0 ${
          mirrored ? 'scale-x-[-1]' : ''
        }`}
      />

      {/* 2. Overlay Canvas for AR Markers and Reticles */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-10"
      />

      {/* 3. Top Bar: Navigation, Step dots, Language */}
      <header className="relative z-30 w-full backdrop-blur-md bg-black/60 px-4 py-3 border-b border-white/10 flex items-center justify-between min-h-[56px]">
        {/* Left: Back Button */}
        <button
          type="button"
          onClick={handleEndSession}
          aria-label="Back to lessons"
          className="w-11 h-11 flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-white active:scale-95 transition-transform cursor-pointer"
        >
          <span className="material-symbols-outlined text-[24px]">arrow_back</span>
        </button>

        {/* Center: Step Progress & Dots */}
        <div className="flex flex-col items-center justify-center">
          <span className="text-[14px] font-semibold tracking-wide text-white">
            Step {currentStep} of {skill.steps.length}
          </span>
          <div className="flex items-center gap-1.5 mt-1">
            {skill.steps.map((step) => {
              if (step.n < currentStep) {
                // Completed
                return <div key={step.n} className="w-2.5 h-2.5 rounded-full bg-[#22c55e]" />;
              }
              if (step.n === currentStep) {
                // Active
                return (
                  <div
                    key={step.n}
                    className="w-3 h-3 rounded-full bg-primary-container ring-2 ring-primary-container/40"
                  />
                );
              }
              // Pending
              return <div key={step.n} className="w-2 h-2 rounded-full bg-[#64748b]" />;
            })}
          </div>
        </div>

        {/* Right: Language Pill */}
        <div className="flex items-center gap-1.5 h-10 px-3 rounded-full bg-white/10 border border-white/20 text-white">
          <span className="material-symbols-outlined text-[18px] text-primary">translate</span>
          <span className="text-[14px] font-bold tracking-tight">{langDisplay.native}</span>
        </div>
      </header>

      {/* 3.5 Debug Drawer (Enabled via ?debug=1) */}
      {isDebug && (
        <aside
          aria-label="Debug telemetry drawer"
          className="relative z-40 bg-black/90 backdrop-blur-md border-b border-primary/30 px-4 py-2 text-xs font-mono text-white/90 shadow-2xl transition-all"
        >
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="font-bold tracking-wider text-primary uppercase text-[11px]">
                Debug Telemetry (?debug=1)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setDebugOpen((prev) => !prev)}
              className="text-[11px] px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white font-medium cursor-pointer"
            >
              {debugOpen ? 'Hide' : 'Show'}
            </button>
          </div>

          {debugOpen && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 pt-1.5 border-t border-white/10 text-[11px]">
              <div>
                <span className="text-white/60">setupComplete: </span>
                <span
                  className={
                    stats.setupCompleteReceived
                      ? 'text-emerald-400 font-bold'
                      : 'text-amber-300 font-semibold'
                  }
                >
                  {stats.setupCompleteReceived
                    ? `yes (${stats.setupCompleteMs ?? 0}ms)`
                    : 'no'}
                </span>
              </div>
              <div>
                <span className="text-white/60">mic chunks sent: </span>
                <span className="text-white font-bold">{stats.micChunksSent}</span>
              </div>
              <div>
                <span className="text-white/60">video frames sent: </span>
                <span className="text-white font-bold">{stats.videoFramesSent}</span>
              </div>
              <div>
                <span className="text-white/60">audio chunks recvd: </span>
                <span className="text-white font-bold">{stats.audioChunksReceived}</span>
              </div>
              <div>
                <span className="text-white/60">transcripts recvd: </span>
                <span className="text-white font-bold">{stats.transcriptsReceived}</span>
              </div>
              <div className="col-span-2 truncate">
                <span className="text-white/60">last close: </span>
                <span className="text-white/80">
                  {stats.lastCloseCode !== null
                    ? `code ${stats.lastCloseCode}${stats.lastCloseReason ? ` (${stats.lastCloseReason})` : ''}`
                    : 'none'}
                </span>
              </div>
            </div>
          )}
        </aside>
      )}

      {/* 4. 10-Minute Warning Banner (if active) */}
      {sessionWarning && (
        <div className="relative z-30 mx-4 mt-2 p-2.5 rounded-xl bg-amber-500/90 text-black text-center font-bold text-xs tracking-wide shadow-lg">
          Session will end in {remainingSeconds}s (10-minute cap)
        </div>
      )}

      {/* 5. Lower Region: Floating Captions and Bottom Sheet */}
      <div className="relative z-30 flex flex-col justify-end w-full">
        {/* Floating Voice Caption Band (Max 2 lines, auto-fades 4s, <= 20% height) */}
        {showCaption && (latestCoachTranscript || latestTraineeTranscript) && (
          <section
            aria-label="Coach audio guidance"
            className="backdrop-blur-md bg-black/80 border border-white/10 px-4 py-2.5 mx-4 mb-2.5 rounded-xl flex items-center gap-3 shadow-xl max-h-[18vh] overflow-hidden transition-opacity duration-300"
          >
            <div className="w-9 h-9 rounded-lg bg-primary-container/20 border border-primary-container/40 flex items-center justify-center shrink-0 text-primary-container">
              <span className="material-symbols-outlined text-[22px]">
                {isCoachSpeaking ? 'volume_up' : 'mic'}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              {latestCoachTranscript && (
                <p className="text-[16px] leading-[22px] font-bold text-white line-clamp-2">
                  {latestCoachTranscript}
                </p>
              )}
              {latestTraineeTranscript && (
                <p className="text-[13px] leading-[18px] text-on-surface-variant font-medium truncate mt-0.5">
                  You: {latestTraineeTranscript}
                </p>
              )}
            </div>
          </section>
        )}

        {/* Bottom Sheet: SOP Details & Controls */}
        <section
          aria-label="Current SOP verification controls"
          className="backdrop-blur-lg bg-[#0f141b]/95 border-t border-white/15 rounded-t-2xl px-4 pt-2.5 pb-5 shadow-2xl flex flex-col gap-3.5"
        >
          {/* Pull Handle Indicator */}
          <div className="w-12 h-1 bg-white/20 rounded-full mx-auto self-center" />

          {/* Instruction Row */}
          <div className="flex items-start gap-3.5">
            {refImage && (
              <div className="relative w-[72px] h-[72px] shrink-0 rounded-lg border border-white/20 overflow-hidden bg-surface-container-high shadow-md">
                <img
                  src={refImage}
                  alt={`Reference diagram for step ${currentStep}`}
                  className="w-full h-full object-cover"
                />
                <span className="absolute top-1 left-1 px-1.5 py-0.5 bg-black/80 border border-white/20 rounded text-[10px] font-bold text-primary tracking-wider uppercase">
                  REF
                </span>
              </div>
            )}

            <div className="flex-1 min-w-0 flex flex-col justify-center">
              {/* Status Chip */}
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                {connectionState === 'connecting' ? (
                  <>
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
                    <span className="text-[13px] text-amber-300 uppercase tracking-wider font-bold">
                      Connecting…
                    </span>
                  </>
                ) : connectionState === 'reconnecting' ? (
                  <>
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
                    <span className="text-[13px] text-amber-300 uppercase tracking-wider font-bold">
                      Reconnecting…
                    </span>
                  </>
                ) : connectionState === 'error' ? (
                  <>
                    <span className="w-2.5 h-2.5 rounded-full bg-red-500 shrink-0" />
                    <span className="text-[13px] text-red-300 uppercase tracking-wider font-bold">
                      Couldn't connect
                    </span>
                    <button
                      type="button"
                      onClick={() => clientRef.current?.manualRetry()}
                      className="px-2.5 py-0.5 rounded bg-white/10 hover:bg-white/20 active:scale-95 text-white text-[12px] font-bold tracking-wide uppercase border border-white/20 transition-all cursor-pointer"
                    >
                      Retry
                    </button>
                  </>
                ) : isCoachSpeaking ? (
                  <>
                    <span className="w-2.5 h-2.5 rounded-full bg-primary-container animate-pulse shrink-0" />
                    <span className="text-[13px] text-primary-fixed-dim uppercase tracking-wider font-bold">
                      Coach speaking
                    </span>
                  </>
                ) : (
                  <>
                    <span className="w-2.5 h-2.5 rounded-full bg-[#22c55e] animate-pulse shrink-0" />
                    <span className="text-[13px] text-emerald-400 uppercase tracking-wider font-bold">
                      Listening
                    </span>
                  </>
                )}

                {isTranslatedLive && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-surface-container-high border border-outline-variant text-on-surface-variant">
                    Translated live
                  </span>
                )}
              </div>

              {/* Primary Instruction Text in Noto Sans at 22px */}
              <h1 className="text-[22px] leading-[28px] font-bold text-white">
                {activeInstruction}
              </h1>
            </div>
          </div>

          {/* Action Buttons: 56px+ touch target */}
          <div className="flex items-center gap-3 pt-1">
            {/* "Why?" Auxiliary Button */}
            <button
              type="button"
              onClick={handleAskWhy}
              className="h-14 w-1/2 rounded-xl bg-white/10 hover:bg-white/15 active:scale-95 text-white font-semibold text-[17px] flex items-center justify-center gap-2 border border-white/15 transition-all shadow-md cursor-pointer"
            >
              <span className="material-symbols-outlined text-[22px] text-white/80">help</span>
              <span>Why?</span>
            </button>

            {/* "End" Button (Amber outline, distinct from Safety Stop) */}
            <button
              type="button"
              onClick={handleEndSession}
              className="h-14 w-1/2 rounded-xl border-2 border-primary-container text-primary-container bg-primary-container/10 hover:bg-primary-container/20 active:scale-95 font-bold text-[17px] flex items-center justify-center gap-2 transition-all shadow-md cursor-pointer"
            >
              <span className="material-symbols-outlined text-[22px]">stop_circle</span>
              <span>End</span>
            </button>
          </div>
        </section>
      </div>
    </main>
  );
};
