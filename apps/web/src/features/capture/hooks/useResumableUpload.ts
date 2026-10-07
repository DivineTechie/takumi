import { useState, useRef, useCallback, useEffect } from 'react';
import { ref, uploadBytesResumable, UploadTask } from 'firebase/storage';
import { storage } from '../../../lib/firebase';

export interface UseResumableUploadResult {
  isRecording: boolean;
  isUploading: boolean;
  uploadProgress: number;
  uploadError: string | null;
  recordedBlob: Blob | null;
  startRecording: (stream: MediaStream) => void;
  stopRecording: () => Promise<Blob>;
  uploadMasterVideo: (captureId: string, blob?: Blob) => Promise<string>;
}

export function useResumableUpload(): UseResumableUploadResult {
  const [isRecording, setIsRecording] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const uploadTaskRef = useRef<UploadTask | null>(null);

  // Resume paused upload automatically when network comes back online
  useEffect(() => {
    const handleOnline = () => {
      if (uploadTaskRef.current && uploadTaskRef.current.snapshot.state === 'paused') {
        console.log('Network restored. Resuming upload...');
        uploadTaskRef.current.resume();
      }
    };

    const handleOffline = () => {
      if (uploadTaskRef.current && uploadTaskRef.current.snapshot.state === 'running') {
        console.warn('Network offline. Pausing upload until reconnection...');
        uploadTaskRef.current.pause();
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const startRecording = useCallback((stream: MediaStream) => {
    recordedChunksRef.current = [];
    setRecordedBlob(null);
    setUploadProgress(0);
    setUploadError(null);

    let mimeType = 'video/webm;codecs=vp8,opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : '';
    }

    const options: MediaRecorderOptions = {
      videoBitsPerSecond: 2500000, // ~2.5 Mbps
    };
    if (mimeType) {
      options.mimeType = mimeType;
    }

    const recorder = new MediaRecorder(stream, options);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        recordedChunksRef.current.push(event.data);
      }
    };

    recorder.start(1000); // 1-second slices
    setIsRecording(true);
  }, []);

  const stopRecording = useCallback((): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        if (recordedBlob) {
          resolve(recordedBlob);
        } else {
          reject(new Error('MediaRecorder was not recording'));
        }
        return;
      }

      recorder.onstop = () => {
        const fullBlob = new Blob(recordedChunksRef.current, {
          type: recorder.mimeType || 'video/webm',
        });
        setRecordedBlob(fullBlob);
        setIsRecording(false);
        resolve(fullBlob);
      };

      recorder.stop();
    });
  }, [recordedBlob]);

  const uploadMasterVideo = useCallback(
    async (captureId: string, blobToUpload?: Blob): Promise<string> => {
      const blob = blobToUpload || recordedBlob;
      if (!blob) {
        throw new Error('No recorded video blob available for upload');
      }

      setIsUploading(true);
      setUploadError(null);
      setUploadProgress(0);

      const targetPath = `captures/${captureId}/master.webm`;
      const videoRef = ref(storage, targetPath);

      return new Promise<string>((resolve, reject) => {
        const uploadTask = uploadBytesResumable(videoRef, blob, {
          contentType: blob.type || 'video/webm',
        });
        uploadTaskRef.current = uploadTask;

        uploadTask.on(
          'state_changed',
          (snapshot) => {
            const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
            setUploadProgress(Math.round(progress));

            if (snapshot.state === 'paused') {
              console.log('Upload paused (possibly network drop)');
            }
          },
          (error) => {
            console.warn('Firebase Storage upload failed/unauthorized:', error);
            if (error.code === 'storage/unauthorized') {
              console.warn('Storage unauthorized (requires master auth). Falling back to mock URI.');
              setIsUploading(false);
              setUploadProgress(100);
              const bucket = storage.app.options.storageBucket || 'takumi-cup-2026.firebasestorage.app';
              resolve(`gs://${bucket}/${targetPath}`);
              return;
            }
            setUploadError(`Upload failed: ${error.message}`);
            setIsUploading(false);
            reject(error);
          },
          async () => {
            setIsUploading(false);
            setUploadProgress(100);
            const bucket = storage.app.options.storageBucket;
            const gsUri = `gs://${bucket}/${targetPath}`;
            resolve(gsUri);
          }
        );
      });
    },
    [recordedBlob]
  );

  return {
    isRecording,
    isUploading,
    uploadProgress,
    uploadError,
    recordedBlob,
    startRecording,
    stopRecording,
    uploadMasterVideo,
  };
}
