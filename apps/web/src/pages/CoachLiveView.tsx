import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Skill } from '../../../../shared/schema/ts/skills';
import type { LanguageCode } from '../i18n';
import { useTranslation } from '../i18n';
import {
  LANGUAGE_DISPLAY_NAMES,
  type LiveClientStats,
  type LiveConnectionState,
  type LiveTranscriptItem,
} from '../lib/live/types';
import { GeminiLiveClient, computeMedian } from '../lib/live/client';
import { OutputAudioQueue, setupMicCapture, type MicCaptureHandle } from '../lib/live/audio';
import { isCameraMirrored, captureVideoFrame, captureVideoFrameAsync } from '../lib/live/video';
import { SessionCapTimer } from '../lib/live/sessionCap';
import { renderReticles, type ReticlePoint } from '../lib/live/reticle';
import { verify, point, watch, createSession, postSessionEvent, endSession, type WatchRequest } from '../lib/api';
import { SafetyStop } from '../components/SafetyStop';
import { watcherReducer, INITIAL_WATCHER_STATE, type WatcherStreakState } from '../lib/live/watcher';

interface CoachLiveViewProps {
  skill: Skill;
  language: LanguageCode;
  stream: MediaStream;
  outputAudioContext: AudioContext;
  micAudioContext: AudioContext;
  speakerMode?: boolean;
  onEnd: () => void;
}

export const CoachLiveView: React.FC<CoachLiveViewProps> = ({
  skill,
  language,
  stream,
  outputAudioContext,
  micAudioContext,
  speakerMode = true,
  onEnd,
}) => {
  const { t } = useTranslation();
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
  const [isLessonComplete, setIsLessonComplete] = useState<boolean>(false);
  const [activeReticles, setActiveReticles] = useState<ReticlePoint[]>([]);

  // Watcher & Safety Stop state (Features A3/A4)
  const [isSafetyStopOpen, setIsSafetyStopOpen] = useState<boolean>(false);
  const [activeHazardRule, setActiveHazardRule] = useState<string | null>(null);
  const [watcherChipState, setWatcherChipState] = useState<'in_progress' | 'checking' | 'cant_see'>('in_progress');
  const [watcherStreakDisplay, setWatcherStreakDisplay] = useState<string>('none x 0');
  const [watchReadsCount, setWatchReadsCount] = useState<number>(0);
  const [watchP50Ms, setWatchP50Ms] = useState<number | null>(null);
  const [decisionToAudioDisplay, setDecisionToAudioDisplay] = useState<string>('n/a');

  const [stats, setStats] = useState<LiveClientStats>({
    setupCompleteReceived: false,
    setupCompleteMs: null,
    micChunksSent: 0,
    videoFramesSent: 0,
    audioChunksReceived: 0,
    transcriptsReceived: 0,
    lastCloseCode: null,
    lastCloseReason: '',
    interruptedCount: 0,
    playbackUnderruns: 0,
    isGating: false,
    tokenFetchMs: null,
    timeToFirstAudioMs: null,
    lastVerifyLatencyMs: null,
    medianVerifyLatencyMs: null,
    lastPointLatencyMs: null,
    medianPointLatencyMs: null,
    lastToolLatencyMs: null,
    medianToolLatencyMs: null,
  });

  const clientRef = useRef<GeminiLiveClient | null>(null);
  const audioQueueRef = useRef<OutputAudioQueue | null>(null);
  const micHandleRef = useRef<MicCaptureHandle | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const captionFadeTimeoutRef = useRef<number | null>(null);
  const videoFrameIntervalRef = useRef<number | null>(null);
  const reticleClearTimeoutRef = useRef<number | null>(null);
  const isEncodingFrameRef = useRef<boolean>(false);
  const isMirroredRef = useRef<boolean>(false);
  const sessionIdRef = useRef<string | null>(null);
  const sessionStartTimeRef = useRef<number>(Date.now());

  // Watcher loop refs
  const isToolInFlightRef = useRef<boolean>(false);
  const isWatchInFlightRef = useRef<boolean>(false);
  const watcherStateRef = useRef<WatcherStreakState>(INITIAL_WATCHER_STATE);
  const watchReadsCountRef = useRef<number>(0);
  const watchLatenciesRef = useRef<number[]>([]);
  const lastCameraEventRef = useRef<string>('');
  const decisionToAudioLatenciesRef = useRef<number[]>([]);
  const pendingAudioCallbackRef = useRef<(() => void) | null>(null);

  // Determine mirroring
  const videoTrack = stream.getVideoTracks()[0];
  const mirrored = isCameraMirrored(videoTrack);
  isMirroredRef.current = mirrored;

  const currentStepRef = useRef<number>(currentStep);
  currentStepRef.current = currentStep;
  const isCompletedRef = useRef<boolean>(false);

  // Advance step hook (idempotent: advances only if currentStepRef matches fromStep)
  const advanceStep = useCallback(
    (fromStep?: number): boolean => {
      const stepToAdvance = fromStep !== undefined ? fromStep : currentStepRef.current;
      if (currentStepRef.current !== stepToAdvance) {
        return false;
      }
      if (isCompletedRef.current) {
        return false;
      }
      if (stepToAdvance >= skill.steps.length) {
        isCompletedRef.current = true;
        currentStepRef.current = skill.steps.length + 1;
        return true;
      }
      const next = stepToAdvance + 1;
      currentStepRef.current = next;
      setCurrentStep(next);
      return true;
    },
    [skill.steps.length]
  );

  // Decision-to-audio timing helper
  const trackDecisionToAudio = useCallback(
    (
      type: 'step_done' | 'mistake',
      step: number,
      reason: string,
      onPosted?: () => void
    ) => {
      const decisionTime = performance.now();
      let resolved = false;

      const triggerPost = (arrivalMs: number) => {
        if (resolved) return;
        resolved = true;
        pendingAudioCallbackRef.current = null;
        const latencyMs = Math.round(arrivalMs - decisionTime);
        decisionToAudioLatenciesRef.current.push(latencyMs);
        const last = latencyMs;
        const med = computeMedian(decisionToAudioLatenciesRef.current) ?? last;
        setDecisionToAudioDisplay(`${last}ms / med ${med}ms`);

        if (sessionIdRef.current) {
          postSessionEvent(sessionIdRef.current, {
            step,
            type,
            source: 'watcher',
            reason,
            latency_ms: latencyMs,
          })
            .then(() => onPosted?.())
            .catch((err) => {
              console.warn(`Failed to log ${type} event:`, err);
              onPosted?.();
            });
        } else {
          onPosted?.();
        }
      };

      pendingAudioCallbackRef.current = () => triggerPost(performance.now());

      window.setTimeout(() => {
        triggerPost(decisionTime + 3000);
      }, 3000);
    },
    []
  );

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

  // Expose advance and simulate transcript hooks for testing/preview harness
  useEffect(() => {
    if (isDebug) {
      (window as unknown as { __TAKUMI_ADVANCE_STEP__?: (fromStep?: number) => boolean }).__TAKUMI_ADVANCE_STEP__ =
        (fromStep?: number) => advanceStep(fromStep ?? currentStepRef.current);
    }
    (window as unknown as { __TAKUMI_SIMULATE_TRANSCRIPT__?: (item: LiveTranscriptItem) => void }).__TAKUMI_SIMULATE_TRANSCRIPT__ = handleTranscript;
    return () => {
      delete (window as unknown as { __TAKUMI_ADVANCE_STEP__?: unknown }).__TAKUMI_ADVANCE_STEP__;
      delete (window as unknown as { __TAKUMI_SIMULATE_TRANSCRIPT__?: unknown }).__TAKUMI_SIMULATE_TRANSCRIPT__;
    };
  }, [advanceStep, handleTranscript, isDebug]);

  // Canvas reticle animation loop
  useEffect(() => {
    if (activeReticles.length === 0) {
      if (canvasRef.current && typeof canvasRef.current.getContext === 'function') {
        try {
          const ctx = canvasRef.current.getContext('2d');
          ctx?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        } catch {
          // ignore in environments without canvas package
        }
      }
      return;
    }

    let animId: number;
    const renderLoop = (timestamp: number) => {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (canvas && video && video.videoWidth && video.videoHeight) {
        if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
          canvas.width = canvas.clientWidth;
          canvas.height = canvas.clientHeight;
        }

        try {
          const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
          if (ctx) {
            renderReticles(
              ctx,
              activeReticles,
              {
                videoWidth: video.videoWidth,
                videoHeight: video.videoHeight,
                screenWidth: canvas.clientWidth,
                screenHeight: canvas.clientHeight,
              },
              timestamp
            );
          }
        } catch {
          // ignore
        }
      }
      animId = requestAnimationFrame(renderLoop);
    };

    animId = requestAnimationFrame(renderLoop);
    return () => {
      cancelAnimationFrame(animId);
    };
  }, [activeReticles]);

  // 1. Initialize session document on mount (fire and forget)
  useEffect(() => {
    let isMounted = true;
    createSession({
      skill_id: skill.id,
      language,
    })
      .then((session) => {
        if (isMounted) {
          sessionIdRef.current = session.id;
        }
      })
      .catch((err) => {
        console.warn('Failed to initialize session doc:', err);
      });

    return () => {
      isMounted = false;
    };
  }, [skill.id, language]);

  // 2. Initialize Live Client, Audio Queue, Mic, and Video Loop
  useEffect(() => {
    const audioQueue = new OutputAudioQueue(outputAudioContext);
    audioQueueRef.current = audioQueue;

    const client = new GeminiLiveClient({
      skill,
      language,
      speakerMode,
      audioQueue,
      getCurrentStep: () => currentStepRef.current,
      callbacks: {
        onStateChange: (state) => {
          setConnectionState(state);
        },
        onAudioChunk: (chunk) => {
          setIsCoachSpeaking(true);
          audioQueue.enqueue(chunk);
          if (pendingAudioCallbackRef.current) {
            const cb = pendingAudioCallbackRef.current;
            pendingAudioCallbackRef.current = null;
            cb();
          }
        },
        onInterrupted: () => {
          audioQueue.flush();
          setIsCoachSpeaking(false);
        },
        onTranscript: (item) => {
          handleTranscript(item);
        },
        onToolCall: async (call) => {
          // --- Tool 1: verify_step ---
          if (call.name === 'verify_step') {
            isToolInFlightRef.current = true;
            try {
              const stepN = currentStepRef.current;
              const modelStep =
                typeof call.args?.step === 'number'
                  ? (call.args.step as number)
                  : stepN;
              const stepDiffers = modelStep !== stepN;
              const stepObj =
                skill.steps.find((s) => s.n === stepN) || skill.steps[0];
              const frame = videoRef.current
                ? captureVideoFrame(videoRef.current, {
                    targetWidth: 1280,
                    mirrored: isMirroredRef.current,
                    quality: 0.85,
                  })
                : null;

              if (!frame) {
                const res: Record<string, unknown> = {
                  passed: false,
                  visible: false,
                  reason: 'Camera frame not available',
                  fix: 'Hold camera steady and ensure workspace is visible',
                };
                if (stepDiffers) {
                  res.current_step = stepN;
                }
                return res;
              }

              const start = performance.now();
              try {
                const resp = await verify({
                  step: stepN,
                  instruction: stepObj.instruction,
                  success_criteria: Array.isArray(stepObj.success_criteria)
                    ? stepObj.success_criteria.join('; ')
                    : String(stepObj.success_criteria),
                  safety_rules: skill.safety_rules || [],
                  image_b64: frame,
                });
                const latencyMs = Math.round(performance.now() - start);

                // Log verify event
                if (sessionIdRef.current) {
                  postSessionEvent(sessionIdRef.current, {
                    step: stepN,
                    type: 'verify',
                    source: 'verify',
                    reason: JSON.stringify({
                      passed: resp.passed,
                      visible: resp.visible,
                      reason: resp.reason,
                      fix: resp.fix,
                    }),
                    latency_ms: latencyMs,
                  }).catch((err) => console.warn('Failed to log verify event:', err));
                }

                if (resp.passed) {
                  const advanced = advanceStep(stepN);
                  if (advanced && sessionIdRef.current) {
                    const postPromise = postSessionEvent(sessionIdRef.current, {
                      step: stepN,
                      type: 'step_done',
                      source: 'verify',
                      latency_ms: latencyMs,
                    });

                    if (stepN >= skill.steps.length) {
                      setIsLessonComplete(true);
                      try {
                        await Promise.race([
                          postPromise,
                          new Promise((resolve) => setTimeout(resolve, 3000)),
                        ]);
                      } catch (err) {
                        console.warn('Failed or timed out posting final step_done:', err);
                      }
                      if (sessionIdRef.current) {
                        try {
                          await endSession(sessionIdRef.current, 'completed');
                        } catch (err) {
                          console.warn('Failed to complete session:', err);
                        }
                      }
                    }
                  } else if (advanced && stepN >= skill.steps.length) {
                    setIsLessonComplete(true);
                    if (sessionIdRef.current) {
                      try {
                        await endSession(sessionIdRef.current, 'completed');
                      } catch (err) {
                        console.warn('Failed to complete session:', err);
                      }
                    }
                  }
                }

                const result: Record<string, unknown> = {
                  passed: resp.passed,
                  visible: resp.visible,
                  reason: resp.reason,
                  fix: resp.fix,
                };
                if (stepDiffers) {
                  result.current_step = stepN;
                }
                return result;
              } catch (err) {
                console.error('verify_step execution failed:', err);
                const errResult: Record<string, unknown> = {
                  passed: false,
                  visible: false,
                  reason: 'Verification request failed',
                  fix: 'Please try again',
                };
                if (stepDiffers) {
                  errResult.current_step = stepN;
                }
                return errResult;
              }
            } finally {
              isToolInFlightRef.current = false;
            }
          }

          // --- Tool 2: point_at ---
          if (call.name === 'point_at') {
            isToolInFlightRef.current = true;
            try {
              const target = String(call.args?.target || 'target component');
              const frame = videoRef.current
                ? captureVideoFrame(videoRef.current, {
                    targetWidth: 1280,
                    mirrored: isMirroredRef.current,
                    quality: 0.85,
                  })
                : null;

              if (!frame) {
                return { result: { status: 'no visible target' } };
              }

              const start = performance.now();
              try {
                const resp = await point({ target, image_b64: frame });
                const latencyMs = Math.round(performance.now() - start);

                if (sessionIdRef.current) {
                  postSessionEvent(sessionIdRef.current, {
                    step: currentStepRef.current,
                    type: 'point',
                    source: 'coach',
                    reason: target,
                    latency_ms: latencyMs,
                  }).catch((err) => console.warn('Failed to log point event:', err));
                }

                if (resp.points && resp.points.length > 0) {
                  setActiveReticles(resp.points);
                  if (reticleClearTimeoutRef.current !== null) {
                    clearTimeout(reticleClearTimeoutRef.current);
                  }
                  reticleClearTimeoutRef.current = window.setTimeout(() => {
                    setActiveReticles([]);
                    reticleClearTimeoutRef.current = null;
                  }, 6000);

                  return { result: { shown: resp.points.length } };
                } else {
                  setActiveReticles([]);
                  return { result: { status: 'no visible target' } };
                }
              } catch (err) {
                console.error('point_at execution failed:', err);
                return { result: { status: 'no visible target' } };
              }
            } finally {
              isToolInFlightRef.current = false;
            }
          }

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

    // Connect microphone capture
    setupMicCapture(stream, micAudioContext, (b64Audio) => {
      client.sendAudio(b64Audio);
    })
      .then((handle) => {
        micHandleRef.current = handle;
      })
      .catch((err) => {
        console.error('Failed to setup mic capture:', err);
      });

    // Async video stream interval (at most 1 frame per second, stopped if document hidden)
    videoFrameIntervalRef.current = window.setInterval(async () => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      if (isEncodingFrameRef.current) {
        return;
      }
      if (videoRef.current) {
        isEncodingFrameRef.current = true;
        try {
          const frame = await captureVideoFrameAsync(videoRef.current, {
            targetWidth: 768,
            mirrored: isMirroredRef.current,
          });
          if (frame) {
            client.sendVideoFrame(frame);
          }
        } catch (err) {
          console.warn('Async frame capture failed:', err);
        } finally {
          isEncodingFrameRef.current = false;
        }
      }
    }, 1000);

    // Screen Wake Lock
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

    // Visibility Change listener
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        outputAudioContext.resume().catch(() => {});
        micAudioContext.resume().catch(() => {});
        requestWakeLock();

        if (client.getState() === 'closed' || client.getState() === 'error') {
          client.manualRetry();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // 10-Minute Session Cap Timer
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
      try {
        const playPromise = videoRef.current.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch((err) => console.warn('Video play error:', err));
        }
      } catch (err) {
        console.warn('Video play sync error:', err);
      }
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (captionFadeTimeoutRef.current !== null) {
        clearTimeout(captionFadeTimeoutRef.current);
      }
      if (reticleClearTimeoutRef.current !== null) {
        clearTimeout(reticleClearTimeoutRef.current);
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
    speakerMode,
    handleTranscript,
    advanceStep,
    onEnd,
    isDebug,
  ]);

  // Sync speakerMode updates dynamically
  useEffect(() => {
    clientRef.current?.setSpeakerMode(speakerMode);
  }, [speakerMode]);

  // 3. Watcher Loop (Features A3 & A4)
  useEffect(() => {
    if (connectionState !== 'connected' || isLessonComplete || isSafetyStopOpen) {
      return;
    }

    let isCancelled = false;
    let loopTimeout: number | null = null;

    const runWatcherTick = async () => {
      if (isCancelled || connectionState !== 'connected' || isLessonComplete || isSafetyStopOpen) {
        return;
      }

      // Skip conditions: tool call in flight, watch in flight, or tab hidden
      if (
        document.visibilityState === 'hidden' ||
        isToolInFlightRef.current ||
        isWatchInFlightRef.current
      ) {
        loopTimeout = window.setTimeout(runWatcherTick, 400);
        return;
      }

      const video = videoRef.current;
      if (!video || !video.videoWidth || !video.videoHeight) {
        loopTimeout = window.setTimeout(runWatcherTick, 400);
        return;
      }

      const stepN = currentStepRef.current;
      const stepObj = skill.steps.find((s) => s.n === stepN) || skill.steps[0];
      const frame = captureVideoFrame(video, {
        targetWidth: 640,
        mirrored: isMirroredRef.current,
        quality: 0.8,
      });

      if (!frame) {
        loopTimeout = window.setTimeout(runWatcherTick, 400);
        return;
      }

      isWatchInFlightRef.current = true;
      setWatcherChipState('checking');

      try {
        const watchReq: WatchRequest = {
          step: stepN,
          instruction: stepObj.instruction,
          success_criteria: Array.isArray(stepObj.success_criteria)
            ? stepObj.success_criteria.join('; ')
            : String(stepObj.success_criteria),
          common_mistakes: stepObj.common_mistakes || [],
          safety_rules: skill.safety_rules || [],
          image_b64: frame,
        };

        const resp = await watch(watchReq);

        watchReadsCountRef.current++;
        setWatchReadsCount(watchReadsCountRef.current);
        const watchLatencyMs = Math.round(resp.secs * 1000);
        watchLatenciesRef.current.push(watchLatencyMs);
        setWatchP50Ms(computeMedian(watchLatenciesRef.current));

        if (resp.state === 'not_visible') {
          setWatcherChipState('cant_see');
        } else {
          setWatcherChipState('in_progress');
        }

        const now = Date.now();
        const { state: nextWatcherState, effect } = watcherReducer(
          watcherStateRef.current,
          {
            type: 'READ',
            step: stepN,
            watchResponse: resp,
            now,
          }
        );
        watcherStateRef.current = nextWatcherState;
        setWatcherStreakDisplay(
          `${nextWatcherState.lastState ?? 'none'} x ${nextWatcherState.consecutiveCount}`
        );

        // Process effect
        if (effect.type === 'SAFETY_STOP') {
          // Hazard x1 -> SAFETY STOP immediately
          setIsSafetyStopOpen(true);
          const hazardRule = effect.rule ?? null;
          setActiveHazardRule(hazardRule);
          audioQueueRef.current?.flush();
          clientRef.current?.stopGating();

          const ruleText = hazardRule || 'Unsafe condition';
          const msg = `SAFETY STOP: ${ruleText}. Tell the trainee to stop and keep their hands away, in under 8 words, now.`;
          clientRef.current?.sendCameraEvent(msg);
          lastCameraEventRef.current = msg;

          // Event timing: post safety_stop IMMEDIATELY with latency_ms = watch latency
          if (sessionIdRef.current) {
            postSessionEvent(sessionIdRef.current, {
              step: stepN,
              type: 'safety_stop',
              source: 'watcher',
              reason: hazardRule || 'Unsafe condition',
              latency_ms: watchLatencyMs,
            }).catch((err) => console.warn('Failed to log safety_stop event:', err));
          }
        } else if (effect.type === 'ADVANCE_STEP') {
          // done x2 -> advance step
          const advanced = advanceStep(stepN);
          if (advanced) {
            const nextStepObj = skill.steps.find((s) => s.n === stepN + 1);
            const isLast = stepN >= skill.steps.length;

            if (isLast) {
              const msg =
                'All steps are verified complete. Congratulate the trainee in one sentence.';
              clientRef.current?.sendCameraEvent(msg);
              lastCameraEventRef.current = msg;
            } else {
              const nextInstruction = nextStepObj?.instruction || 'Next step';
              const msg = `Step ${stepN} is verified complete (${effect.reason}). Give brief praise and announce step ${stepN + 1}: ${nextInstruction}`;
              clientRef.current?.sendCameraEvent(msg);
              lastCameraEventRef.current = msg;
            }

            // Post step_done when first coach audio arrives (or at 3s timeout)
            trackDecisionToAudio('step_done', stepN, effect.reason, () => {
              if (isLast) {
                setIsLessonComplete(true);
                if (sessionIdRef.current) {
                  endSession(sessionIdRef.current, 'completed').catch((err) =>
                    console.warn('Failed to complete session:', err)
                  );
                }
              }
            });
          }
        } else if (effect.type === 'WARN_MISTAKE') {
          // mistake x2
          const msg = `Mistake on step ${stepN}: ${effect.reason}. Fix: ${effect.fix}. Tell the trainee now in one sentence and call point_at on the exact thing to fix.`;
          clientRef.current?.sendCameraEvent(msg);
          lastCameraEventRef.current = msg;
          trackDecisionToAudio('mistake', stepN, effect.reason);
        } else if (effect.type === 'NUDGE_NOT_VISIBLE') {
          // not_visible x4
          const msg =
            'The camera cannot see the work area. In one short sentence, ask the trainee to move their hands aside or hold the phone steady.';
          clientRef.current?.sendCameraEvent(msg);
          lastCameraEventRef.current = msg;

          if (sessionIdRef.current) {
            postSessionEvent(sessionIdRef.current, {
              step: stepN,
              type: 'blocked',
              source: 'watcher',
              reason: effect.reason || "Can't see work area",
              latency_ms: 0,
            }).catch((err) => console.warn('Failed to log blocked event:', err));
          }
        }
      } catch (err) {
        console.warn('Watcher tick error:', err);
      } finally {
        isWatchInFlightRef.current = false;
        if (!isCancelled) {
          loopTimeout = window.setTimeout(runWatcherTick, 400);
        }
      }
    };

    loopTimeout = window.setTimeout(runWatcherTick, 400);

    return () => {
      isCancelled = true;
      if (loopTimeout !== null) {
        clearTimeout(loopTimeout);
      }
    };
  }, [
    connectionState,
    isLessonComplete,
    isSafetyStopOpen,
    skill,
    advanceStep,
    trackDecisionToAudio,
  ]);

  // Handle "I've made it safe" in Safety Stop overlay
  const handleMadeSafe = () => {
    setIsSafetyStopOpen(false);
    setActiveHazardRule(null);
    watcherStateRef.current = {
      ...watcherStateRef.current,
      lastState: null,
      consecutiveCount: 0,
    };
    setWatcherStreakDisplay('none x 0');
    const stepN = currentStepRef.current;
    const stepObj = skill.steps.find((s) => s.n === stepN) || skill.steps[0];
    const msg = `The trainee says the hazard is fixed. Continue with step ${stepN}: ${stepObj.instruction}`;
    clientRef.current?.sendCameraEvent(msg);
    lastCameraEventRef.current = msg;
  };

  // Simulate hazard for testing and debug mode
  const triggerSimulatedHazard = useCallback(() => {
    setIsSafetyStopOpen(true);
    const hazardRule =
      skill.safety_rules && skill.safety_rules.length > 0
        ? skill.safety_rules[0]
        : null;
    setActiveHazardRule(hazardRule);
    audioQueueRef.current?.flush();
    clientRef.current?.stopGating();
    const ruleText = hazardRule || 'Unsafe condition';
    const msg = `SAFETY STOP: ${ruleText}. Tell the trainee to stop and keep their hands away, in under 8 words, now.`;
    clientRef.current?.sendCameraEvent(msg);
    lastCameraEventRef.current = msg;

    if (sessionIdRef.current) {
      postSessionEvent(sessionIdRef.current, {
        step: currentStepRef.current,
        type: 'safety_stop',
        source: 'watcher',
        reason: ruleText,
        latency_ms: 0,
      }).catch((err) => console.warn('Failed to log simulated safety_stop event:', err));
    }
  }, [skill.safety_rules]);

  // Expose simulated hazard in debug mode for test harness
  useEffect(() => {
    if (isDebug) {
      (window as unknown as { __TAKUMI_SIMULATE_HAZARD__?: () => void }).__TAKUMI_SIMULATE_HAZARD__ =
        triggerSimulatedHazard;
    }
    return () => {
      delete (window as unknown as { __TAKUMI_SIMULATE_HAZARD__?: unknown }).__TAKUMI_SIMULATE_HAZARD__;
    };
  }, [triggerSimulatedHazard, isDebug]);

  // Handle "Why?" button action
  const handleAskWhy = () => {
    if (clientRef.current) {
      clientRef.current.sendText('The trainee asks: why is this step done this way?');
    }
    if (sessionIdRef.current) {
      postSessionEvent(sessionIdRef.current, {
        step: currentStepRef.current,
        type: 'ask_why',
        source: 'trainee',
        latency_ms: 0,
      }).catch((err) => console.warn('Failed to log ask_why event:', err));
    }
  };

  // Handle "End" button action
  const handleEndSession = () => {
    if (window.confirm('Are you sure you want to end this coaching session?')) {
      if (sessionIdRef.current) {
        const finalStatus =
          currentStepRef.current >= skill.steps.length ? 'completed' : 'abandoned';
        endSession(sessionIdRef.current, finalStatus).catch((err) =>
          console.warn('Failed to end session:', err)
        );
      }
      onEnd();
      navigate('/coach');
    }
  };

  // Restart for "Practise again" on Lesson Complete
  const handlePractiseAgain = () => {
    isCompletedRef.current = false;
    setIsLessonComplete(false);
    setCurrentStep(1);
    currentStepRef.current = 1;
    sessionStartTimeRef.current = Date.now();
    clientRef.current?.sendText(
      '[SESSION RESTART] The trainee wants to practise again from step 1. Greet them and announce step 1.'
    );
  };

  const activeStepObj =
    skill.steps.find((s) => s.n === currentStep) ||
    skill.steps[skill.steps.length - 1] ||
    skill.steps[0];
  const localizedStep = activeStepObj.translations?.[language];
  const activeInstruction = localizedStep?.instruction || activeStepObj.instruction;
  const isTranslatedLive = !localizedStep && language !== 'en';
  const refImage = activeStepObj.card_image_uri || activeStepObj.keyframe_uri;
  const langDisplay = LANGUAGE_DISPLAY_NAMES[language] || { native: language, english: language };

  const audioTrack = stream.getAudioTracks()[0];
  const audioSettings = audioTrack?.getSettings?.() || {};

  // Formatted duration for Lesson Complete
  const sessionElapsedSeconds = Math.max(
    1,
    Math.round((Date.now() - sessionStartTimeRef.current) / 1000)
  );
  const elapsedMin = Math.floor(sessionElapsedSeconds / 60);
  const elapsedSec = sessionElapsedSeconds % 60;

  // Render 06_lesson_complete screen if all steps are done
  if (isLessonComplete) {
    return (
      <main className="w-full min-h-screen bg-surface text-on-surface flex items-center justify-center p-4 font-sans select-none">
        <div className="w-full max-w-[420px] bg-surface flex flex-col justify-between overflow-hidden shadow-2xl relative border border-outline-variant/30 rounded-2xl p-6">
          <header className="flex items-center justify-between pb-4 border-b border-outline-variant/30">
            <button
              type="button"
              onClick={() => {
                onEnd();
                navigate('/coach');
              }}
              aria-label="Back to lessons"
              className="w-12 h-12 -ml-2 flex items-center justify-center text-on-surface hover:bg-surface-container-high rounded transition-transform active:scale-95 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[28px]">arrow_back</span>
            </button>
            <span className="font-headline-md font-bold tracking-wider text-on-surface">TAKUMI</span>
            <div className="w-10" />
          </header>

          <section className="flex flex-col items-center text-center my-6">
            <div className="relative w-20 h-20 rounded-full bg-secondary-container/20 border-2 border-secondary flex items-center justify-center mb-4 shadow-[0_0_24px_rgba(74,225,118,0.25)]">
              <span
                className="material-symbols-outlined text-[44px] text-secondary font-bold"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                check_circle
              </span>
            </div>
            <h1 className="text-[28px] leading-[34px] font-extrabold text-on-surface mb-2">
              All {skill.steps.length} steps done
            </h1>
            <p className="text-[16px] text-on-surface-variant max-w-[320px]">
              {skill.title} completed
            </p>
            <div className="mt-4 inline-flex items-center gap-2 bg-surface-container-low px-4 py-1.5 rounded-full border border-secondary/40">
              <span
                className="material-symbols-outlined text-secondary text-[20px]"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                verified
              </span>
              <span className="text-[13px] text-secondary tracking-wide uppercase font-bold">
                {skill.steps.length} OF {skill.steps.length} STEPS VERIFIED
              </span>
            </div>
          </section>

          <section className="bg-surface-container border border-outline-variant/50 rounded-xl p-4 my-4 space-y-3">
            <div className="flex items-center justify-between pb-3 border-b border-outline-variant/30">
              <div className="flex items-center gap-2 text-on-surface-variant">
                <span className="material-symbols-outlined text-[22px]">timer</span>
                <span className="text-[15px]">Time taken</span>
              </div>
              <span className="text-[17px] font-bold text-on-surface font-mono">
                {elapsedMin > 0 ? `${elapsedMin} min ${elapsedSec} s` : `${elapsedSec} s`}
              </span>
            </div>

            <div className="flex items-center justify-between pb-3 border-b border-outline-variant/30">
              <div className="flex items-center gap-2 text-on-surface-variant">
                <span className="material-symbols-outlined text-primary-container text-[22px]">
                  shield_with_heart
                </span>
                <span className="text-[15px]">Mistakes caught</span>
              </div>
              <div className="flex items-center gap-1.5 bg-surface-container-high px-2.5 py-1 rounded border border-primary-container/40">
                <span className="material-symbols-outlined text-primary-container text-[16px]">
                  check
                </span>
                <span className="text-[13px] text-primary-fixed-dim font-bold">0 mistakes</span>
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center gap-2 text-on-surface-variant">
                <span className="material-symbols-outlined text-[22px]">school</span>
                <span className="text-[15px]">Instructor</span>
              </div>
              <div className="text-right">
                <div className="text-[15px] font-bold text-on-surface">Master K.</div>
                <div className="text-[13px] text-on-surface-variant font-medium">ST-EL-01</div>
              </div>
            </div>
          </section>

          <footer className="flex flex-col gap-3 pt-2">
            <button
              type="button"
              onClick={() => {
                onEnd();
                navigate('/coach');
              }}
              className="w-full min-h-[56px] h-14 bg-primary-container hover:brightness-105 active:scale-[0.98] text-on-primary-container rounded-xl font-bold text-[17px] flex items-center justify-center gap-2 shadow-md cursor-pointer transition-transform"
            >
              <span>Back to skills</span>
              <span className="material-symbols-outlined text-[22px]">arrow_forward</span>
            </button>
            <button
              type="button"
              onClick={handlePractiseAgain}
              className="w-full min-h-[56px] h-14 bg-surface-container-high hover:bg-surface-bright active:scale-[0.98] text-on-surface border border-outline-variant rounded-xl font-semibold text-[17px] flex items-center justify-center gap-2 cursor-pointer transition-transform"
            >
              <span className="material-symbols-outlined text-[22px]">replay</span>
              <span>Practise again</span>
            </button>
          </footer>
        </div>
      </main>
    );
  }

  return (
    <main className="relative w-full max-w-[420px] lg:max-w-none lg:w-full mx-auto h-[100dvh] overflow-hidden bg-surface-dim shadow-2xl flex flex-col lg:flex-row justify-between font-sans select-none">
      {/* =========================================================================
          LEFT / PRIMARY POV CAMERA REGION
          On Mobile (< 1024px): Absolute full-bleed background.
          On Laptop (>= 1024px): Flex-1 fills entire left area completely unoccluded.
          ========================================================================= */}
      <div className="absolute inset-0 lg:relative lg:flex-1 lg:h-full lg:overflow-hidden lg:bg-black z-0">
        <div
          className="w-full h-full cursor-pointer relative"
          onClick={() => {
            clientRef.current?.stopGating();
          }}
          data-testid="camera-view"
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-cover ${mirrored ? 'scale-x-[-1]' : ''}`}
          />
          {/* Overlay Canvas for AR Reticles & Pulsing Rings */}
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none z-10"
          />
        </div>

        {/* 10-Minute Warning Banner */}
        {sessionWarning && (
          <div className="absolute top-16 left-4 right-4 z-30 p-2.5 rounded-xl bg-amber-500/90 text-black text-center font-bold text-xs tracking-wide shadow-lg">
            Session will end in {remainingSeconds}s (10-minute cap)
          </div>
        )}

        {/* Floating Captions on Mobile (< 1024px) */}
        <div className="lg:hidden absolute bottom-[180px] left-0 right-0 z-30 px-4">
          {showCaption && (latestCoachTranscript || latestTraineeTranscript) && (
            <section
              aria-label="Coach voice guidance"
              className="backdrop-blur-md bg-black/85 border border-white/10 px-4 py-2.5 rounded-xl flex items-center gap-3 shadow-xl max-h-[18vh] overflow-hidden transition-opacity duration-300"
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
        </div>
      </div>

      {/* =========================================================================
          RIGHT SIDE PANEL ON LAPTOP (>= 1024px) / BOTTOM SHEET ON MOBILE (< 1024px)
          On Mobile: Top bar overlaid at top, instruction sheet at bottom.
          On Laptop: Fixed ~400px side panel, camera feed completely uncovered.
          ========================================================================= */}
      <div className="relative z-30 flex flex-col justify-between w-full lg:w-[400px] xl:w-[440px] lg:h-full lg:bg-[#0f141b] lg:border-l lg:border-white/10 shrink-0 pointer-events-auto">
        {/* Top Header */}
        <header className="w-full backdrop-blur-md bg-black/60 lg:bg-[#0f141b] px-4 py-3 border-b border-white/10 flex items-center justify-between min-h-[56px] shrink-0">
          <button
            type="button"
            onClick={handleEndSession}
            aria-label="Back to lessons"
            className="w-11 h-11 flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-white active:scale-95 transition-transform cursor-pointer"
          >
            <span className="material-symbols-outlined text-[24px]">arrow_back</span>
          </button>

          <div className="flex flex-col items-center justify-center">
            <span className="text-[14px] font-semibold tracking-wide text-white">
              Step {currentStep} of {skill.steps.length}
            </span>
            <div className="flex items-center gap-1.5 mt-1">
              {skill.steps.map((step) => {
                if (step.n < currentStep) {
                  return <div key={step.n} className="w-2.5 h-2.5 rounded-full bg-[#22c55e]" />;
                }
                if (step.n === currentStep) {
                  return (
                    <div
                      key={step.n}
                      className="w-3 h-3 rounded-full bg-primary-container ring-2 ring-primary-container/40"
                    />
                  );
                }
                return <div key={step.n} className="w-2 h-2 rounded-full bg-[#64748b]" />;
              })}
            </div>
          </div>

          <div className="flex items-center gap-1.5 h-10 px-3 rounded-full bg-white/10 border border-white/20 text-white">
            <span className="material-symbols-outlined text-[18px] text-primary">translate</span>
            <span className="text-[14px] font-bold tracking-tight">{langDisplay.native}</span>
          </div>
        </header>

        {/* Debug Drawer (?debug=1) */}
        {isDebug && (
          <aside
            aria-label="Debug telemetry drawer"
            className="bg-black/95 backdrop-blur-md border-b border-primary/30 px-4 py-2 text-xs font-mono text-white/90 shadow-2xl transition-all"
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
                  <span className="text-white/60">token fetch: </span>
                  <span className="text-white font-bold">
                    {stats.tokenFetchMs != null ? `${stats.tokenFetchMs}ms` : 'n/a'}
                  </span>
                </div>
                <div>
                  <span className="text-white/60">first audio: </span>
                  <span className="text-white font-bold">
                    {stats.timeToFirstAudioMs != null ? `${stats.timeToFirstAudioMs}ms` : 'n/a'}
                  </span>
                </div>
                <div>
                  <span className="text-white/60">mic chunks: </span>
                  <span className="text-white font-bold">{stats.micChunksSent}</span>
                </div>
                <div>
                  <span className="text-white/60">video frames: </span>
                  <span className="text-white font-bold">{stats.videoFramesSent}</span>
                </div>
                <div>
                  <span className="text-white/60">audio recvd: </span>
                  <span className="text-white font-bold">{stats.audioChunksReceived}</span>
                </div>
                <div>
                  <span className="text-white/60">transcripts: </span>
                  <span className="text-white font-bold">{stats.transcriptsReceived}</span>
                </div>
                <div>
                  <span className="text-white/60">interrupted: </span>
                  <span className="text-white font-bold">{stats.interruptedCount}</span>
                </div>
                <div>
                  <span className="text-white/60">underruns: </span>
                  <span className="text-white font-bold">{stats.playbackUnderruns}</span>
                </div>
                <div>
                  <span className="text-white/60">gating: </span>
                  <span
                    className={
                      stats.isGating
                        ? 'text-amber-400 font-bold'
                        : 'text-emerald-400 font-bold'
                    }
                  >
                    {stats.isGating ? 'ON (silence)' : 'OFF (live)'}
                  </span>
                </div>
                <div>
                  <span className="text-white/60">verify ms: </span>
                  <span className="text-white font-bold">
                    {stats.lastVerifyLatencyMs != null
                      ? `${stats.lastVerifyLatencyMs} / med ${stats.medianVerifyLatencyMs}`
                      : 'n/a'}
                  </span>
                </div>
                <div>
                  <span className="text-white/60">point ms: </span>
                  <span className="text-white font-bold">
                    {stats.lastPointLatencyMs != null
                      ? `${stats.lastPointLatencyMs} / med ${stats.medianPointLatencyMs}`
                      : 'n/a'}
                  </span>
                </div>
                <div className="col-span-2">
                  <span className="text-white/60">tool round-trip: </span>
                  <span className="text-white font-bold">
                    {stats.lastToolLatencyMs != null
                      ? `${stats.lastToolLatencyMs}ms / med ${stats.medianToolLatencyMs}ms`
                      : 'n/a'}
                  </span>
                </div>
                <div className="col-span-2 truncate">
                  <span className="text-white/60">mic settings: </span>
                  <span className="text-white/80">
                    {`AEC: ${String(audioSettings.echoCancellation ?? 'n/a')}, NS: ${String(
                      audioSettings.noiseSuppression ?? 'n/a'
                    )}, AGC: ${String(audioSettings.autoGainControl ?? 'n/a')}`}
                  </span>
                </div>
                <div className="col-span-2 truncate">
                  <span className="text-white/60">last close: </span>
                  <span className="text-white/80">
                    {stats.lastCloseCode !== null
                      ? `code ${stats.lastCloseCode}${stats.lastCloseReason ? ` (${stats.lastCloseReason})` : ''}`
                      : 'none'}
                  </span>
                </div>
                <div>
                  <span className="text-white/60">watch reads: </span>
                  <span className="text-white font-bold">{watchReadsCount}</span>
                </div>
                <div>
                  <span className="text-white/60">watch p50: </span>
                  <span className="text-white font-bold">
                    {watchP50Ms != null ? `${watchP50Ms}ms` : 'n/a'}
                  </span>
                </div>
                <div>
                  <span className="text-white/60">streak: </span>
                  <span className="text-white font-bold">{watcherStreakDisplay}</span>
                </div>
                <div>
                  <span className="text-white/60">decision-to-audio: </span>
                  <span className="text-white font-bold">{decisionToAudioDisplay}</span>
                </div>
                <div className="col-span-2 truncate">
                  <span className="text-white/60">last camera event: </span>
                  <span className="text-white/80" title={lastCameraEventRef.current}>
                    {lastCameraEventRef.current || 'none'}
                  </span>
                </div>
                <div className="col-span-2 pt-2 border-t border-white/10 flex items-center justify-between">
                  <span className="text-white/60">hazard test:</span>
                  <button
                    type="button"
                    onClick={triggerSimulatedHazard}
                    data-testid="simulate-hazard-btn"
                    className="px-2.5 py-1 rounded bg-red-600 hover:bg-red-500 active:scale-95 text-white font-bold text-[11px] uppercase tracking-wider transition-all cursor-pointer"
                  >
                    Simulate Hazard
                  </button>
                </div>
              </div>
            )}
          </aside>
        )}

        {/* Captions in Laptop Sidebar (>= 1024px) */}
        <div className="hidden lg:block px-5 py-3">
          {showCaption && (latestCoachTranscript || latestTraineeTranscript) && (
            <section
              aria-label="Coach voice guidance"
              className="backdrop-blur-md bg-black/60 border border-white/10 p-3.5 rounded-xl flex items-center gap-3 shadow-md"
            >
              <div className="w-8 h-8 rounded-lg bg-primary-container/20 border border-primary-container/40 flex items-center justify-center shrink-0 text-primary-container">
                <span className="material-symbols-outlined text-[20px]">
                  {isCoachSpeaking ? 'volume_up' : 'mic'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                {latestCoachTranscript && (
                  <p className="text-[15px] leading-[20px] font-bold text-white line-clamp-3">
                    {latestCoachTranscript}
                  </p>
                )}
                {latestTraineeTranscript && (
                  <p className="text-[12px] leading-[16px] text-on-surface-variant font-medium truncate mt-1">
                    You: {latestTraineeTranscript}
                  </p>
                )}
              </div>
            </section>
          )}
        </div>

        {/* SOP Instruction Sheet / Side Content */}
        <section
          aria-label="Current SOP verification controls"
          className="backdrop-blur-lg bg-[#0f141b]/95 lg:bg-transparent border-t lg:border-t-0 border-white/15 rounded-t-2xl lg:rounded-none px-4 lg:px-5 pt-3 lg:pt-0 pb-5 shadow-2xl flex flex-col gap-4 flex-1 justify-between"
        >
          {/* Pull Handle Indicator (Mobile only) */}
          <div className="lg:hidden w-12 h-1 bg-white/20 rounded-full mx-auto self-center" />

          {/* SOP Instruction Row */}
          <div className="flex items-start gap-3.5 my-auto">
            {refImage && (
              <div className="relative w-[76px] h-[76px] lg:w-[92px] lg:h-[92px] shrink-0 rounded-lg border border-white/20 overflow-hidden bg-surface-container-high shadow-md">
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
              {/* Dynamic Status Chip */}
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
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

                {/* Watcher Status Chip (A3 Step Watcher) */}
                {connectionState === 'connected' && (
                  <span
                    data-testid="watcher-status-chip"
                    className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold tracking-wide border transition-colors ${
                      watcherChipState === 'checking'
                        ? 'bg-blue-500/20 text-blue-300 border-blue-500/40'
                        : watcherChipState === 'cant_see'
                        ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                        : 'bg-white/10 text-white/80 border-white/15'
                    }`}
                  >
                    {watcherChipState === 'checking' && (
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping" />
                    )}
                    {watcherChipState === 'cant_see' && (
                      <span className="material-symbols-outlined text-[12px]">visibility_off</span>
                    )}
                    {watcherChipState === 'checking'
                      ? t('watcher_checking')
                      : watcherChipState === 'cant_see'
                      ? t('watcher_cant_see')
                      : t('watcher_in_progress', { step: currentStep })}
                  </span>
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

          {/* Action Buttons: 56px touch target */}
          <div className="flex items-center gap-3 pt-2">
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

      {/* Safety Stop Full-Screen Overlay (A4 Safety Sentinel) */}
      {isSafetyStopOpen && (
        <SafetyStop
          rule={activeHazardRule}
          onMadeSafe={handleMadeSafe}
          outputAudioContext={outputAudioContext}
        />
      )}
    </main>
  );
};

export default CoachLiveView;
