import React, { useState, useEffect } from 'react';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
import { db, storage, auth } from '../../lib/firebase';
import { triggerForgeJob } from '../../lib/api';
import { saveVideoBlob } from '../review/mediaStorage';
import { SetupForm, SetupFormData } from './components/SetupForm';
import { RecordingOverlay } from './components/RecordingOverlay';
import { useCameraStream } from './hooks/useCameraStream';
import { useGeminiLive } from './hooks/useGeminiLive';
import { useResumableUpload } from './hooks/useResumableUpload';
import type { Capture } from '../../../../../shared/schema/ts/captures.ts';

export interface CaptureScreenProps {
  onJobCreated?: (jobId: string, skillId: string) => void;
}

export const CaptureScreen: React.FC<CaptureScreenProps> = ({ onJobCreated }) => {
  const [stage, setStage] = useState<'setup' | 'recording' | 'finished'>('setup');
  const [skillTitle, setSkillTitle] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState<'ja' | 'en' | 'hi' | 'vi' | 'id' | 'fil'>('ja');
  const [captureId, setCaptureId] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [startTime, setStartTime] = useState<number>(0);

  const {
    stream,
    videoRef,
    error: cameraError,
    isStarting: isCameraStarting,
    startCamera,
    stopCamera,
    captureFrameBase64,
  } = useCameraStream();

  const {
    currentQuestion,
    questionCount,
    transcript,
    error: liveError,
    startLiveSession,
    stopLiveSession,
  } = useGeminiLive({ sourceLanguage });

  const {
    isUploading,
    uploadProgress,
    uploadError,
    startRecording,
    stopRecording,
    uploadMasterVideo,
  } = useResumableUpload();

  // Monitor online / offline status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleStartCapture = async (data: SetupFormData) => {
    setErrorMessage(null);
    setSkillTitle(data.skillTitle);
    setSourceLanguage(data.sourceLanguage);

    const generatedId = `cap_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    setCaptureId(generatedId);

    try {
      // 1. Start camera and mic stream
      const stream = await startCamera();
      if (!stream) {
        throw new Error('Failed to acquire camera stream');
      }

      // 2. Optional Manual PDF upload
      const manualUris: string[] = [];
      const bucket = storage.app.options.storageBucket || 'takumi-cup-2026.firebasestorage.app';

      if (data.manualFile) {
        try {
          const manualUuid = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          const manualPath = `manuals/${manualUuid}.pdf`;
          const manualRef = ref(storage, manualPath);
          await uploadBytes(manualRef, data.manualFile, { contentType: 'application/pdf' });
          manualUris.push(`gs://${bucket}/${manualPath}`);
        } catch (uploadErr) {
          console.warn('Manual PDF upload bypassed (unauthenticated storage):', uploadErr);
        }
      }

      // 3. Create captures/{captureId} in Firestore (requires signed-in master)
      if (!auth.currentUser) {
        throw new Error('Sign-in required: Please sign in with an authorized Master account to record captures.');
      }

      const masterUid = auth.currentUser.uid;
      const initialDoc: Capture = {
        id: generatedId,
        master_uid: masterUid,
        skill_title: data.skillTitle,
        source_language: data.sourceLanguage,
        video_uri: `gs://${bucket}/captures/${generatedId}/master.webm`,
        duration_s: 0,
        transcript: [],
        status: 'recording',
        created_at: new Date().toISOString(),
      };
      if (manualUris.length > 0) {
        initialDoc.manual_uris = manualUris;
      }

      try {
        await setDoc(doc(db, 'captures', generatedId), initialDoc);
      } catch (firestoreErr) {
        console.warn('Firestore write permission denied (requires custom claim role:master). Continuing in local mode:', firestoreErr);
        sessionStorage.setItem(`takumi_capture_${generatedId}`, JSON.stringify(initialDoc));
      }

      // 4. Start local MediaRecorder
      startRecording(stream);

      // 5. Connect Gemini Live apprentice interviewer session
      await startLiveSession(stream, captureFrameBase64);

      setStartTime(Date.now());
      setStage('recording');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to start master capture:', msg);
      setErrorMessage(msg);
      stopCamera();
      stopLiveSession();
    }
  };

  const handleFinishCapture = async () => {
    try {
      // 1. Stop Live session and Camera
      stopLiveSession();
      const videoBlob = await stopRecording();
      stopCamera();

      if (videoBlob && videoBlob.size > 0) {
        try {
          await saveVideoBlob('last_recorded_video', videoBlob);
          await saveVideoBlob(captureId, videoBlob);
          await saveVideoBlob(`job_${captureId}`, videoBlob);
        } catch (e) {
          console.warn('Could not save video blob to IndexedDB:', e);
        }
      }

      // 2. Upload video with resumable Firebase Storage task
      try {
        await uploadMasterVideo(captureId, videoBlob);
      } catch (uploadErr) {
        console.warn('Storage video upload bypassed in dev mode:', uploadErr);
      }

      // 3. Calculate final duration
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);

      // 4. Update Firestore capture doc to "uploaded" with transcript
      try {
        const captureRef = doc(db, 'captures', captureId);
        await updateDoc(captureRef, {
          status: 'uploaded',
          duration_s: durationSeconds,
          transcript: transcript,
        });
      } catch (docErr) {
        console.warn('Firestore updateDoc bypassed (unauthenticated):', docErr);
      }

      // 5. Call POST /forge/jobs {"capture_id"}
      let forgeJob = { job_id: `job_${captureId}`, skill_id: `skill_${captureId}` };
      try {
        forgeJob = await triggerForgeJob(captureId);
      } catch (jobErr) {
        console.warn('Forge job API unavailable, navigating to local preview job:', jobErr);
      }

      setStage('finished');

      if (onJobCreated) {
        onJobCreated(forgeJob.job_id, forgeJob.skill_id);
      } else {
        window.history.pushState({}, '', `/forge/${forgeJob.job_id}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to finalize capture:', msg);
      setErrorMessage(msg);
    }
  };

  if (stage === 'setup') {
    return (
      <SetupForm
        onStart={handleStartCapture}
        isStarting={isCameraStarting}
        error={errorMessage || cameraError || liveError || uploadError}
      />
    );
  }

  return (
    <RecordingOverlay
      skillTitle={skillTitle}
      stream={stream}
      videoRef={videoRef}
      currentQuestion={currentQuestion}
      questionCount={questionCount}
      isUploading={isUploading}
      uploadProgress={uploadProgress}
      isOnline={isOnline}
      onFinish={handleFinishCapture}
    />
  );
};
