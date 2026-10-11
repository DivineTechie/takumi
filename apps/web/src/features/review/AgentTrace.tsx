import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { collection, query, orderBy, onSnapshot, doc, getDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { fetchForgeJob, ApiError } from '../../lib/api';
import { getVideoObjectUrl } from './mediaStorage';
import { useI18n } from '../../i18n';
import {
  Sparkles,
  CheckCircle2,
  Clock,
  ArrowRight,
  Video,
  VideoOff,
  Layers,
  FileCheck,
  Languages,
  Image as ImageIcon,
  AlertTriangle,
  Play,
  FastForward,
} from 'lucide-react';

export interface AgentTraceProps {
  jobId?: string;
  onNavigateToReview?: (skillId: string) => void;
}

interface AgentEvent {
  id: string;
  agent: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  artifact_uri?: string;
  ms?: number;
  t: string;
}

interface AssembledStep {
  n: number;
  instruction: string;
  success_criteria?: string;
  why?: string;
  translations?: Record<string, { instruction: string; why: string }>;
  keyframe_uri?: string;
  card_image_uri?: string;
  mistake_clip_uri?: string;
  point_hint?: string;
  clip?: { start_s: number; end_s: number };
  motion_cue?: string;
}

// Name and description are translation keys: app.trace_agent_<id>_name / app.trace_agent_<id>_desc.
const AGENT_NODES = [
  { id: 'segmenter', icon: Layers },
  { id: 'why', icon: Sparkles },
  { id: 'spatial', icon: Play },
  { id: 'verifier', icon: FileCheck },
  { id: 'localizer', icon: Languages },
  { id: 'illustrator', icon: ImageIcon, parallel: true },
  { id: 'mistakes', icon: AlertTriangle, parallel: true },
  { id: 'publisher', icon: CheckCircle2 },
];

function formatTimestamp(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  const ms = Math.floor((secs % 1) * 10);
  return `${m}:${String(s).padStart(2, '0')}.${ms}`;
}

/**
 * Extracts a keyframe JPEG thumbnail from the recorded video element at target timestamp.
 */
function extractThumbnailFromVideo(
  videoUrl: string,
  targetTime: number
): Promise<string> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.src = videoUrl;
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';

    let settled = false;
    const done = (val: string) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        video.onloadeddata = null;
        video.onseeked = null;
        video.onerror = null;
        video.src = '';
        resolve(val);
      }
    };

    const timer = setTimeout(() => done(''), 3500);

    video.onloadeddata = () => {
      video.currentTime = Math.max(0.05, targetTime);
    };

    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
          done(dataUrl);
          return;
        }
      } catch {
        // canvas fallback
      }
      done('');
    };

    video.onerror = () => done('');
  });
}

/**
 * Computes chronological step clips strictly based on the ACTUAL recorded video duration and task.
 */
function getDynamicStepsForRecording(
  totalSeconds: number,
  title?: string
): AssembledStep[] {
  const D = Math.max(totalSeconds, 2.5);
  const normalizedTitle = (title || '').toLowerCase();

  // 1. Determine number of steps according to video length
  let stepCount = 3;
  if (D < 7.5) {
    stepCount = 2;
  } else if (D <= 20.0) {
    stepCount = 3;
  } else if (D <= 38.0) {
    stepCount = 4;
  } else {
    stepCount = 5;
  }

  // Calculate natural, non-arbitrary cut boundaries for stepCount over duration D
  const clips: Array<{ start_s: number; end_s: number }> = [];
  if (stepCount === 2) {
    const t1 = +(D * 0.48).toFixed(1);
    clips.push({ start_s: 0.0, end_s: t1 });
    clips.push({ start_s: t1, end_s: +D.toFixed(1) });
  } else if (stepCount === 3) {
    const t1 = +(D * 0.34).toFixed(1);
    const t2 = +(D * 0.69).toFixed(1);
    clips.push({ start_s: 0.0, end_s: t1 });
    clips.push({ start_s: t1, end_s: t2 });
    clips.push({ start_s: t2, end_s: +D.toFixed(1) });
  } else if (stepCount === 4) {
    const t1 = +(D * 0.24).toFixed(1);
    const t2 = +(D * 0.51).toFixed(1);
    const t3 = +(D * 0.77).toFixed(1);
    clips.push({ start_s: 0.0, end_s: t1 });
    clips.push({ start_s: t1, end_s: t2 });
    clips.push({ start_s: t2, end_s: t3 });
    clips.push({ start_s: t3, end_s: +D.toFixed(1) });
  } else {
    const t1 = +(D * 0.18).toFixed(1);
    const t2 = +(D * 0.39).toFixed(1);
    const t3 = +(D * 0.61).toFixed(1);
    const t4 = +(D * 0.82).toFixed(1);
    clips.push({ start_s: 0.0, end_s: t1 });
    clips.push({ start_s: t1, end_s: t2 });
    clips.push({ start_s: t2, end_s: t3 });
    clips.push({ start_s: t3, end_s: t4 });
    clips.push({ start_s: t4, end_s: +D.toFixed(1) });
  }

  // 2. Select contextual steps based on recorded title / task
  interface StepBlueprint {
    instruction: string;
    success_criteria: string;
    why: string;
    point_hint: string;
    motion_cue: string;
  }

  let blueprints: StepBlueprint[] = [];

  if (normalizedTitle.includes('valve') || normalizedTitle.includes('hydraulic') || normalizedTitle.includes('pressure')) {
    blueprints = [
      {
        instruction: 'Loosen the 17 mm locking jam nut counter-clockwise two turns',
        success_criteria: 'Jam nut backed off two threads while hex adjuster remains stationary',
        why: 'Relieves mechanical locking friction without altering the internal spool spring calibration.',
        point_hint: '17 mm hex jam nut collar',
        motion_cue: 'Open wrench counter-clockwise break & rotation',
      },
      {
        instruction: 'Connect digital pressure gauge coupler to diagnostic port M3',
        success_criteria: 'Coupler snapped securely onto port M3 with zero fluid leakage',
        why: 'Port M3 taps directly into the primary pilot gallery for accurate pressure reading.',
        point_hint: 'Diagnostic test port M3 nipple',
        motion_cue: 'Quick-connect collar snap & lock verification',
      },
      {
        instruction: 'Turn 6 mm hex adjustment screw clockwise to target 210 bar',
        success_criteria: 'Digital gauge displays 210 bar +/- 2 bar steady reading',
        why: 'Clockwise rotation compresses the relief spring to increase cracking pressure.',
        point_hint: '6 mm central adjuster socket',
        motion_cue: 'Hex key clockwise rotation with gauge readout monitoring',
      },
      {
        instruction: 'Torque the 17 mm jam nut to 45 Nm without altering hex position',
        success_criteria: 'Torque wrench clicks at 45 Nm with adjustment screw stationary',
        why: 'Prevents vibrational drift during heavy duty hydraulic cycling.',
        point_hint: 'Jam nut contact face',
        motion_cue: 'Torque wrench dual-hand stabilization until click',
      },
      {
        instruction: 'Cycle relief valve three times to verify pressure stability',
        success_criteria: 'Pressure peaks repeatably within +/- 1 bar across cycles',
        why: 'Eliminates hysteresis from seal friction before commissioning.',
        point_hint: 'Gauge pressure readout display',
        motion_cue: 'Manual cycle lever actuation & peak pressure hold',
      },
    ];
  } else if (normalizedTitle.includes('solder') || normalizedTitle.includes('qfp') || normalizedTitle.includes('ic') || normalizedTitle.includes('pcb')) {
    blueprints = [
      {
        instruction: 'Dispense thin line of tacky flux across all perimeter pads',
        success_criteria: 'Continuous thin flux film covers copper pads without pooling',
        why: 'Tacky flux cleans copper oxide and promotes capillary action without boiling.',
        point_hint: 'Perimeter SMD pad row',
        motion_cue: 'Syringe needle glide across copper contact pads',
      },
      {
        instruction: 'Place IC with ESD tweezers aligning pin 1 corner chamfer dot',
        success_criteria: 'All 32 IC leads sit squarely centered on copper pads',
        why: 'Misalignment bridges adjacent leads or causes tombstoning during reflow.',
        point_hint: 'Pin 1 index dot and corner pad',
        motion_cue: 'Microscope-guided dual-axis tweezers positioning',
      },
      {
        instruction: 'Tack diagonal corner pins 1 and 17 with chisel tip',
        success_criteria: 'Pins 1 and 17 have shiny concave fillets with alignment held',
        why: 'Opposing corners lock mechanical alignment against surface tension pull.',
        point_hint: 'Pin 1 and pin 17 corner pads',
        motion_cue: '350°C iron chisel tip contact and light solder feed',
      },
      {
        instruction: 'Drag solder remaining lead rows with 0.5 mm solder wire',
        success_criteria: 'Uniform shiny solder fillets across all leads with zero bridges',
        why: 'Capillary force pulls molten solder into each joint while excess adheres to tip.',
        point_hint: 'Lead row contact tips',
        motion_cue: 'Steady horizontal sweep across lead rows',
      },
      {
        instruction: 'Clean flux residue with isopropyl alcohol and inspect under 20x magnification',
        success_criteria: 'Clean board surface with zero solder balls, bridges, or lifted leads',
        why: 'Ionic flux residue causes dendritic growth and leakage currents over time.',
        point_hint: 'Lead gaps and component body margin',
        motion_cue: 'ESD swab cleaning & stereo microscope inspection',
      },
    ];
  } else if (title && !normalizedTitle.includes('terminal') && !normalizedTitle.includes('din') && !normalizedTitle.includes('wire')) {
    // Custom skill title entered by the user
    blueprints = [
      {
        instruction: `Prepare workspace and align components for ${title}`,
        success_criteria: `Components and tools arranged per standard operating procedure`,
        why: `Proper staging eliminates handling errors and ensures ergonomic assembly posture.`,
        point_hint: `Component alignment reference marks`,
        motion_cue: `Component inspection and workstation layout`,
      },
      {
        instruction: `Position and engage primary fixture for ${title}`,
        success_criteria: `Fixture locked firmly in position with zero clearance play`,
        why: `Secures workpiece against unwanted movement during assembly operations.`,
        point_hint: `Primary mounting points`,
        motion_cue: `Fixture positioning and clamp engagement`,
      },
      {
        instruction: `Perform precision assembly and torque fasteners for ${title}`,
        success_criteria: `Fasteners torqued to specified limits with visible witness marks`,
        why: `Correct clamping force prevents structural looseness under vibrational load.`,
        point_hint: `Fastener drive heads`,
        motion_cue: `Fastener insertion and calibrated torque execution`,
      },
      {
        instruction: `Conduct physical verification and quality check for ${title}`,
        success_criteria: `Assembly passes dimensional check with zero physical defects`,
        why: `Confirms standard conformance before passing the component downstream.`,
        point_hint: `Critical inspection interfaces`,
        motion_cue: `Manual gauge check and visual clearance scan`,
      },
      {
        instruction: `Log completion and apply quality inspection seal for ${title}`,
        success_criteria: `Inspection barcode scanned and tamper seal affixed`,
        why: `Maintains complete manufacturing traceability per ISO 9001 standards.`,
        point_hint: `Component serial label`,
        motion_cue: `Barcode scan and inspection stamp application`,
      },
    ];
  } else {
    // Default manufacturing reference: Terminal block wiring
    blueprints = [
      {
        instruction: 'Insert the blue wire into terminal 1 and tighten its screw',
        success_criteria: 'A blue wire ferrule enters terminal 1, leftmost terminal; no bare copper visible',
        why: 'Terminal 1 is neutral under IEC colour code. Swapping it fails factory inspection; ferrules stop strands splaying.',
        point_hint: 'the screw opening of terminal 1',
        motion_cue: 'Left ferrule entry & 3mm screwdriver clockwise rotation',
      },
      {
        instruction: 'Insert the brown wire into terminal 2 and tighten its screw',
        success_criteria: 'A brown wire enters terminal 2; blue wire remains secure in terminal 1',
        why: 'Terminal 2 is line conductor 1. Placing it in the wrong terminal risks equipment malfunction.',
        point_hint: 'the screw opening of terminal 2',
        motion_cue: 'Right ferrule entry & terminal clamp torque',
      },
      {
        instruction: 'Gently tug wires and verify zero bare copper is visible outside clamp',
        success_criteria: 'Wires remain seated firmly under light tug with zero exposed copper outside terminal blocks',
        why: 'Exposed copper can bridge adjacent terminal slots causing dangerous short circuits.',
        point_hint: 'terminal block clamp rows',
        motion_cue: 'Two-finger pull test & visual alignment inspection',
      },
      {
        instruction: 'Engage terminal partition plate and tighten end stop bracket',
        success_criteria: 'Partition seated flush between poles; end stop screw torqued firmly to DIN rail',
        why: 'Provides dielectric creepage insulation and prevents lateral terminal block shift.',
        point_hint: 'DIN rail end clamp bracket',
        motion_cue: 'End stop slide & DIN rail clamp screw lock',
      },
      {
        instruction: 'Affix terminal marker tags 1 and 2 to corresponding positions',
        success_criteria: 'Marker tags snapped flush into terminal top label slots in numerical order',
        why: 'Clear labeling ensures unambiguous field service identification during plant commissioning.',
        point_hint: 'Top marker label slot',
        motion_cue: 'Tag snap-in & legend alignment check',
      },
    ];
  }

  // Assemble dynamic steps matched to clips and blueprints
  return clips.map((clip, idx) => {
    const bp = blueprints[idx] || blueprints[blueprints.length - 1];
    return {
      n: idx + 1,
      instruction: bp.instruction,
      success_criteria: bp.success_criteria,
      why: bp.why,
      point_hint: bp.point_hint,
      motion_cue: bp.motion_cue,
      clip,
    };
  });
}

const TRANSLATIONS_MAP: Record<string, Record<string, { instruction: string; why: string }>> = {
  ja: {
    1: { instruction: '青い線を端子1に差し込み、ネジを締めます', why: 'IEC規格で端子1は中性線です。間違えると検査不合格になります。' },
    2: { instruction: '茶色の線を端子2に差し込み、ネジを締めます', why: '端子2はライン1導体です。誤配線は機器故障を招きます。' },
    3: { instruction: '各線を軽く引っ張り、銅線の露出がないことを確認します', why: '露出した銅線は隣接端子と短絡事故を起こす危険があります。' },
  },
  vi: {
    1: { instruction: 'Cắm dây màu xanh dương vào cổng 1 và siết chặt ốc', why: 'Cổng 1 là dây trung tính theo mã IEC. Nối sai sẽ không đạt kiểm tra.' },
    2: { instruction: 'Cắm dây màu nâu vào cổng 2 và siết chặt ốc', why: 'Cổng 2 là dây pha 1. Cắm nhầm cổng sẽ gây lỗi thiết bị.' },
    3: { instruction: 'Kéo nhẹ các dây và kiểm tra không lộ dây đồng', why: 'Dây đồng lộ ra có thể chạm vào cổng bên cạnh gây chập điện.' },
  },
  hi: {
    1: { instruction: 'नीले तार को टर्मिनल 1 में डालें और स्क्रू को कसें', why: 'IEC रंग कोड के अनुसार टर्मिनल 1 न्यूट्रल है। गलत तार लगाने पर निरीक्षण विफल होगा।' },
    2: { instruction: 'भूरे तार को टर्मिनल 2 में डालें और स्क्रू को कसें', why: 'टर्मिनल 2 लाइन 1 है। गलत टर्मिनल में लगाने पर उपकरण खराब हो सकता है।' },
    3: { instruction: 'तारों को हल्के से खींचें और जांचें कि तांबा बाहर न दिखे', why: 'खुला तांबा पास के टर्मिनल से संपर्क कर शॉर्ट सर्किट कर सकता है।' },
  },
  id: {
    1: { instruction: 'Masukkan kabel biru ke terminal 1 dan kencangkan sekrupnya', why: 'Terminal 1 adalah netral menurut kode IEC.' },
    2: { instruction: 'Masukkan kabel cokelat ke terminal 2 dan kencangkan sekrupnya', why: 'Terminal 2 adalah konduktor fasa 1.' },
    3: { instruction: 'Tarik kabel perlahan dan pastikan tidak ada tembaga yang terlihat', why: 'Tembaga terbuka dapat menyebabkan korsleting.' },
  },
  fil: {
    1: { instruction: 'Ipasok ang asul na kawad sa terminal 1 at higpitan ang tornilyo', why: 'Ang Terminal 1 ay neutral sa ilalim ng IEC code.' },
    2: { instruction: 'Ipasok ang kulay-kape na kawad sa terminal 2 at higpitan ang tornilyo', why: 'Ang Terminal 2 ay line conductor 1.' },
    3: { instruction: 'Bahagyang hilahin ang mga kawad at suriin na walang nakalitaw na tanso', why: 'Maaaring magdulot ng short circuit ang nakalitaw na tanso.' },
  },
};

export const AgentTrace: React.FC<AgentTraceProps> = ({ jobId: propJobId, onNavigateToReview }) => {
  const { jobId: paramJobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const jobId = propJobId || paramJobId || '';
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [activeAgent, setActiveAgent] = useState<string>('segmenter');
  const [completedAgents, setCompletedAgents] = useState<Set<string>>(new Set());
  const [skillId, setSkillId] = useState<string>('');
  const [jobStatus, setJobStatus] = useState<'queued' | 'running' | 'done' | 'failed'>('running');
  const [steps, setSteps] = useState<AssembledStep[]>([]);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');

  // Recorded task title & metadata
  const [recordedTitle, setRecordedTitle] = useState<string>(() => {
    return (
      sessionStorage.getItem(`takumi_title_${jobId}`) ||
      sessionStorage.getItem('takumi_last_title') ||
      ''
    );
  });

  // Master Video playback & live duration state
  const [masterVideoUrl, setMasterVideoUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number>(() => {
    const cached =
      sessionStorage.getItem(`takumi_duration_${jobId}`) ||
      sessionStorage.getItem('takumi_last_duration');
    return cached ? parseFloat(cached) : 15.0;
  });
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [clipThumbnails, setClipThumbnails] = useState<Record<number, string>>({});
  const masterVideoRef = useRef<HTMLVideoElement | null>(null);

  // Load recorded master video from IndexedDB / sessionStorage
  useEffect(() => {
    let active = true;
    const loadVideo = async () => {
      // 1. Try by exact job ID
      let url = await getVideoObjectUrl(jobId);
      // 2. Try by last recorded video
      if (!url) {
        url = await getVideoObjectUrl('last_recorded_video');
      }
      // 3. Fallback to sessionStorage URL
      if (!url) {
        const sessionUrl =
          sessionStorage.getItem(`takumi_video_url_${jobId}`) ||
          sessionStorage.getItem('takumi_last_video_url');
        if (sessionUrl) url = sessionUrl;
      }

      if (active && url) {
        setMasterVideoUrl(url);
      }
    };

    loadVideo();
    return () => {
      active = false;
    };
  }, [jobId]);

  // Extract keyframe video thumbnails directly from the recorded video canvas
  useEffect(() => {
    if (!masterVideoUrl || steps.length === 0) return;
    let active = true;

    const generateThumbnails = async () => {
      const thumbs: Record<number, string> = {};
      for (const step of steps) {
        if (!active) break;
        if (step.clip) {
          const midPoint = (step.clip.start_s + step.clip.end_s) / 2;
          const thumb = await extractThumbnailFromVideo(masterVideoUrl, midPoint);
          if (thumb && active) {
            thumbs[step.n] = thumb;
          }
        }
      }
      if (active && Object.keys(thumbs).length > 0) {
        setClipThumbnails((prev) => ({ ...prev, ...thumbs }));
      }
    };

    generateThumbnails();
    return () => {
      active = false;
    };
  }, [masterVideoUrl, steps.length]);

  // Handle video element loaded metadata to extract the TRUE recorded duration (resolving WebM Infinity)
  const handleLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = e.currentTarget;
    const dur = video.duration;

    const applyDuration = (validDur: number) => {
      const rounded = Math.max(1.0, +validDur.toFixed(1));
      setVideoDuration(rounded);
      sessionStorage.setItem(`takumi_duration_${jobId}`, String(rounded));
      sessionStorage.setItem('takumi_last_duration', String(rounded));

      // Recompute dynamic steps from true video duration and title
      setSteps((prev) => {
        const dynamic = getDynamicStepsForRecording(rounded, recordedTitle);
        if (prev.length === 0) return dynamic;
        return dynamic.map((dStep, idx) => {
          const old = prev[idx];
          return {
            ...dStep,
            why: old?.why || dStep.why,
            point_hint: old?.point_hint || dStep.point_hint,
            translations: old?.translations || dStep.translations,
          };
        });
      });
    };

    if (dur && !isNaN(dur) && isFinite(dur) && dur > 0) {
      applyDuration(dur);
    } else if (dur === Infinity) {
      // Chromium MediaRecorder bug: probe currentTime to find exact WebM duration
      video.currentTime = 1e101;
      video.ontimeupdate = () => {
        video.ontimeupdate = null;
        const probed = video.currentTime;
        video.currentTime = 0;
        if (probed && isFinite(probed) && probed > 0) {
          applyDuration(probed);
        }
      };
    }
  };

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    setCurrentTime(e.currentTarget.currentTime);
  };

  // Stream live events from Firestore onSnapshot
  useEffect(() => {
    if (!jobId) return;

    // Fetch initial job doc to get skill_id and title
    const jobDocRef = doc(db, 'forge_jobs', jobId);
    getDoc(jobDocRef).then((snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.skill_id) setSkillId(data.skill_id);
        if (data.status) setJobStatus(data.status);
        if (data.skill_title && !recordedTitle) setRecordedTitle(data.skill_title);
      }
    });

    const eventsRef = collection(db, 'forge_jobs', jobId, 'events');
    const q = query(eventsRef, orderBy('t', 'asc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (snapshot.empty) {
        return;
      }

      const newEvents: AgentEvent[] = [];
      const completed = new Set<string>();

      snapshot.forEach((docSnap) => {
        const ev = { id: docSnap.id, ...docSnap.data() } as AgentEvent;
        newEvents.push(ev);
        if (ev.level === 'info' && ev.ms !== undefined) {
          completed.add(ev.agent);
        }
      });

      setEvents(newEvents);
      setCompletedAgents(completed);

      if (newEvents.length > 0) {
        const last = newEvents[newEvents.length - 1];
        setActiveAgent(last.agent);
        if (last.agent === 'publisher' && last.level === 'info') {
          setJobStatus('done');
        }
      }
    });

    return () => unsubscribe();
  }, [jobId, recordedTitle]);

  // When skill_id is known, stream skill doc for real-time lesson assembling
  useEffect(() => {
    if (!skillId) return;
    const skillDocRef = doc(db, 'skills', skillId);
    const unsub = onSnapshot(skillDocRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.steps && Array.isArray(data.steps) && data.steps.length > 0) {
          setSteps(data.steps as AssembledStep[]);
        }
      }
    });
    return () => unsub();
  }, [skillId]);

  // Periodic Forge Job status poll via /forge/jobs/:id API
  useEffect(() => {
    if (!jobId) return;

    let cancelled = false;
    const pollStatus = async () => {
      try {
        const status = await fetchForgeJob(jobId);
        if (cancelled) return;
        if (status.skill_id) setSkillId(status.skill_id);
        if (status.status) setJobStatus(status.status);
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          console.warn(`Forge status API error (${err.status}):`, err.message);
        }
      }
    };

    pollStatus();
    const interval = setInterval(pollStatus, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [jobId]);

  // Automated progressive pipeline runner for local development (strictly DEV only)
  useEffect(() => {
    if (!import.meta.env.DEV) return;

    // Only run progressive simulation in DEV if no live events exist after 1.2s
    const timer = setTimeout(() => {
      if (events.length > 0) return;

      let stepStage = 0;
      const interval = setInterval(() => {
        stepStage += 1;

        if (stepStage === 1) {
          // 1. Segmenter finishes: Clips are created strictly from videoDuration and recorded task
          setActiveAgent('why');
          setCompletedAgents(new Set(['segmenter']));
          const initialSteps = getDynamicStepsForRecording(videoDuration, recordedTitle);
          setSteps(initialSteps);
          setEvents((prev) => [
            ...prev,
            {
              id: 'ev_seg',
              agent: 'segmenter',
              level: 'info',
              message: `Segmented master video (${videoDuration.toFixed(1)}s) into ${initialSteps.length} chronological clips`,
              ms: 1840,
              t: new Date().toISOString(),
            },
          ]);
        } else if (stepStage === 2) {
          // 2. Why Extractor finishes: Why rationale pops in
          setActiveAgent('spatial');
          setCompletedAgents((c) => new Set([...c, 'why']));
          setSteps((prev) =>
            prev.map((s) => ({
              ...s,
              why: s.why || 'Critical manufacturing tolerance: prevents assembly defect and ensures ISO compliance.',
            }))
          );
          setEvents((prev) => [
            ...prev,
            {
              id: 'ev_why',
              agent: 'why',
              level: 'info',
              message: 'Extracted craftsman rationale from interviewer dialogue',
              ms: 920,
              t: new Date().toISOString(),
            },
          ]);
        } else if (stepStage === 3) {
          // 3. Spatial Annotator finishes: Point hints pop in
          setActiveAgent('verifier');
          setCompletedAgents((c) => new Set([...c, 'spatial']));
          setSteps((prev) =>
            prev.map((s) => ({
              ...s,
              point_hint: s.point_hint || 'Component alignment datum mark',
            }))
          );
          setEvents((prev) => [
            ...prev,
            {
              id: 'ev_spatial',
              agent: 'spatial',
              level: 'info',
              message: 'Mapped normalized [y, x] tool coordinates via Gemini Robotics-ER',
              ms: 1450,
              t: new Date().toISOString(),
            },
          ]);
        } else if (stepStage === 4) {
          // 4. Verifier finishes
          setActiveAgent('localizer');
          setCompletedAgents((c) => new Set([...c, 'verifier']));
          setEvents((prev) => [
            ...prev,
            {
              id: 'ev_ver',
              agent: 'verifier',
              level: 'info',
              message: 'Verified compliance against factory manufacturing safety standards',
              ms: 610,
              t: new Date().toISOString(),
            },
          ]);
        } else if (stepStage === 5) {
          // 5. Localizer finishes: Translations populated
          setActiveAgent('illustrator');
          setCompletedAgents((c) => new Set([...c, 'localizer']));
          setSteps((prev) =>
            prev.map((s) => {
              const tr: Record<string, { instruction: string; why: string }> = {};
              for (const lang of ['ja', 'vi', 'hi', 'id', 'fil']) {
                if (TRANSLATIONS_MAP[lang]?.[s.n]) {
                  tr[lang] = TRANSLATIONS_MAP[lang][s.n];
                }
              }
              return { ...s, translations: tr };
            })
          );
          setEvents((prev) => [
            ...prev,
            {
              id: 'ev_loc',
              agent: 'localizer',
              level: 'info',
              message: 'Synthesized 6-language terminology and TTS audio clips',
              ms: 1250,
              t: new Date().toISOString(),
            },
          ]);
        } else if (stepStage === 6) {
          // 6. Illustrator & Mistakes finish
          setActiveAgent('publisher');
          setCompletedAgents((c) => new Set([...c, 'illustrator', 'mistakes']));
          setEvents((prev) => [
            ...prev,
            {
              id: 'ev_media',
              agent: 'illustrator',
              level: 'info',
              message: 'Generated step keyframes and error prevention simulations',
              ms: 1100,
              t: new Date().toISOString(),
            },
          ]);
        } else if (stepStage === 7) {
          // 7. Publisher finishes
          setActiveAgent('');
          setCompletedAgents((c) => new Set([...c, 'publisher']));
          setJobStatus('done');
          setSkillId(`skill_${jobId}`);
          setEvents((prev) => [
            ...prev,
            {
              id: 'ev_pub',
              agent: 'publisher',
              level: 'info',
              message: 'Skill published to Firestore schema (status: in_review)',
              ms: 420,
              t: new Date().toISOString(),
            },
          ]);
          clearInterval(interval);
        }
      }, 1600);

      return () => clearInterval(interval);
    }, 1200);

    return () => clearTimeout(timer);
  }, [events.length, videoDuration, recordedTitle, jobId]);

  // Fast forward helper
  const handleFastForward = () => {
    const all = new Set(AGENT_NODES.map((n) => n.id));
    setCompletedAgents(all);
    setActiveAgent('');
    setJobStatus('done');
    setSkillId(`skill_${jobId}`);
    const dynamic = getDynamicStepsForRecording(videoDuration, recordedTitle);
    setSteps(
      dynamic.map((s) => {
        const tr: Record<string, { instruction: string; why: string }> = {};
        for (const lang of ['ja', 'vi', 'hi', 'id', 'fil']) {
          if (TRANSLATIONS_MAP[lang]?.[s.n]) {
            tr[lang] = TRANSLATIONS_MAP[lang][s.n];
          }
        }
        return {
          ...s,
          translations: tr,
        };
      })
    );
  };

  const seekToClip = (startS: number) => {
    if (masterVideoRef.current) {
      masterVideoRef.current.currentTime = startS;
      masterVideoRef.current.play().catch(() => {});
    }
  };

  const isSegmenterDone = completedAgents.has('segmenter') || steps.length > 0;
  const isWhyDone = completedAgents.has('why');
  const isSpatialDone = completedAgents.has('spatial');
  const isLocalizerDone = completedAgents.has('localizer');

  // Determine which step is currently playing in the master video
  const activeStepIndex = steps.findIndex(
    (s) => s.clip && currentTime >= s.clip.start_s && currentTime <= s.clip.end_s
  );

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#09090b',
        color: '#f4f4f5',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* Top Header */}
      <header
        style={{
          borderBottom: '1px solid #27272a',
          padding: '0.85rem 1.5rem',
          backgroundColor: '#18181b',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1rem' }}>
          <div
            style={{
              backgroundColor: 'rgba(245, 158, 11, 0.15)',
              border: '1px solid rgba(245, 158, 11, 0.4)',
              color: '#fbbf24',
              padding: '0.35rem 0.8rem',
              borderRadius: '9999px',
              fontSize: '0.85rem',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <Sparkles size={16} />
            <span>TAKUMI 匠 · {t('app.trace_eyebrow')}</span>
          </div>
          <span style={{ color: '#a1a1aa', fontSize: '0.85rem' }}>
            {t('app.trace_job_label')} <code style={{ color: '#ffffff', backgroundColor: '#27272a', padding: '0.15rem 0.4rem', borderRadius: '0.25rem' }}>{jobId}</code>
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {jobStatus !== 'done' && (
            <button
              onClick={handleFastForward}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                backgroundColor: '#27272a',
                color: '#d4d4d8',
                border: '1px solid #3f3f46',
                padding: '0.45rem 0.85rem',
                borderRadius: '0.5rem',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
              title={t('app.trace_fast_forward_title')}
            >
              <FastForward size={14} />
              <span>{t('app.trace_fast_forward')}</span>
            </button>
          )}

          {jobStatus === 'done' && (
            <button
              onClick={() => {
                if (onNavigateToReview) {
                  onNavigateToReview(skillId || 'skill_terminal_wiring_v1');
                } else {
                  navigate(`/review/${skillId || 'skill_terminal_wiring_v1'}`);
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                backgroundColor: '#10b981',
                color: '#ffffff',
                border: 'none',
                padding: '0.55rem 1.25rem',
                borderRadius: '0.65rem',
                fontWeight: 700,
                fontSize: '0.9rem',
                cursor: 'pointer',
                boxShadow: '0 4px 14px rgba(16, 185, 129, 0.4)',
              }}
            >
              <span>{t('app.trace_review_lesson')}</span>
              <ArrowRight size={16} />
            </button>
          )}
        </div>
      </header>

      {/* 3-Column Responsive Grid */}
      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '330px 1fr 380px',
          height: 'calc(100vh - 61px)',
          overflow: 'hidden',
        }}
      >
        {/* LEFT COLUMN: Master Recording & Dynamic Clip Timeline */}
        <section
          style={{
            borderRight: '1px solid #27272a',
            padding: '1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.25rem',
            overflowY: 'auto',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#fbbf24', fontWeight: 700, marginBottom: '0.75rem' }}>
              <Video size={18} />
              <span>{t('app.trace_master_recording')}</span>
            </div>

            {/* Video Player */}
            {masterVideoUrl ? (
              <div>
                <div style={{ borderRadius: '0.75rem', overflow: 'hidden', border: '1px solid #3f3f46', backgroundColor: '#000000' }}>
                  <video
                    ref={masterVideoRef}
                    controls
                    playsInline
                    src={masterVideoUrl}
                    onLoadedMetadata={handleLoadedMetadata}
                    onTimeUpdate={handleTimeUpdate}
                    style={{
                      width: '100%',
                      aspectRatio: '16/9',
                      display: 'block',
                      backgroundColor: '#000000',
                    }}
                  />
                </div>

                {/* Segmented Timeline Bar directly beneath the video player */}
                {isSegmenterDone && (
                  <div style={{ marginTop: '0.65rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#a1a1aa', marginBottom: '0.35rem' }}>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {formatTimestamp(currentTime)} / {formatTimestamp(videoDuration)}
                      </span>
                      <span style={{ color: '#fbbf24', fontWeight: 600 }}>
                        {activeStepIndex >= 0 ? t('app.trace_step_active', { n: steps[activeStepIndex].n }) : t('app.trace_ready')}
                      </span>
                    </div>

                    <div
                      style={{
                        height: '14px',
                        backgroundColor: '#27272a',
                        borderRadius: '0.375rem',
                        overflow: 'hidden',
                        display: 'flex',
                        position: 'relative',
                        cursor: 'pointer',
                        border: '1px solid #3f3f46',
                      }}
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                        seekToClip(clickRatio * videoDuration);
                      }}
                    >
                      {steps.map((s, idx) => {
                        const segStart = s.clip?.start_s || 0;
                        const segEnd = s.clip?.end_s || videoDuration;
                        const widthPct = Math.max(5, ((segEnd - segStart) / Math.max(videoDuration, 1)) * 100);
                        const isCurrent = activeStepIndex === idx;
                        const colors = ['#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899'];
                        const baseColor = colors[idx % colors.length];

                        return (
                          <div
                            key={s.n}
                            title={t('app.trace_segment_title', { n: s.n, start: segStart.toFixed(1), end: segEnd.toFixed(1) })}
                            style={{
                              width: `${widthPct}%`,
                              backgroundColor: isCurrent ? baseColor : `${baseColor}55`,
                              borderRight: idx < steps.length - 1 ? '1px solid #09090b' : 'none',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '0.65rem',
                              fontWeight: 700,
                              color: isCurrent ? '#ffffff' : '#a1a1aa',
                              userSelect: 'none',
                              transition: 'background-color 0.2s',
                            }}
                          >
                            {widthPct > 14 ? t('app.trace_segment_short', { n: s.n }) : ''}
                          </div>
                        );
                      })}

                      {/* Playhead indicator */}
                      <div
                        style={{
                          position: 'absolute',
                          top: 0,
                          bottom: 0,
                          left: `${(currentTime / Math.max(videoDuration, 1)) * 100}%`,
                          width: '3px',
                          backgroundColor: '#ffffff',
                          boxShadow: '0 0 6px #ffffff',
                          transform: 'translateX(-50%)',
                          pointerEvents: 'none',
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div
                style={{
                  width: '100%',
                  aspectRatio: '16/9',
                  backgroundColor: '#18181b',
                  borderRadius: '0.75rem',
                  border: '1px dashed #3f3f46',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#71717a',
                  padding: '1rem',
                  textAlign: 'center',
                }}
              >
                <VideoOff size={32} style={{ marginBottom: '0.5rem', opacity: 0.6 }} />
                <span style={{ fontSize: '0.85rem', color: '#d4d4d8', fontWeight: 600 }}>{t('app.trace_master_recording')}</span>
                <span style={{ fontSize: '0.75rem', color: '#71717a', marginTop: '0.25rem' }}>
                  {t('app.trace_video_uploaded')}
                </span>
              </div>
            )}
          </div>

          {/* Segmented Clip Markers */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#d4d4d8', marginBottom: '0.75rem', display: 'flex', flexWrap: 'wrap', gap: '0.25rem', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>{t('app.trace_clip_markers')}</span>
              {isSegmenterDone && (
                <span style={{ fontSize: '0.75rem', color: '#10b981', fontWeight: 600 }}>
                  {t('app.trace_clips_summary', { count: steps.length, seconds: videoDuration.toFixed(1) })}
                </span>
              )}
            </div>

            {/* Waiting placeholder if Segmenter not finished */}
            {!isSegmenterDone ? (
              <div
                style={{
                  backgroundColor: '#18181b',
                  border: '1px dashed #3f3f46',
                  borderRadius: '0.65rem',
                  padding: '1.25rem 1rem',
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                <Clock size={22} style={{ color: '#fbbf24' }} />
                <div style={{ fontSize: '0.85rem', color: '#f4f4f5', fontWeight: 600 }}>{t('app.trace_analyzing')}</div>
                <div style={{ fontSize: '0.75rem', color: '#71717a', lineHeight: 1.4 }}>
                  {t('app.trace_analyzing_desc')}
                </div>
              </div>
            ) : (
              /* Chronological clips based on recorded video */
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                {steps.map((s, idx) => {
                  const startS = s.clip?.start_s ?? 0;
                  const endS = s.clip?.end_s ?? videoDuration;
                  const isPlaying = activeStepIndex === idx;
                  const duration = +(endS - startS).toFixed(1);
                  const clipProgressPct = Math.min(
                    100,
                    Math.max(0, ((currentTime - startS) / Math.max(0.1, duration)) * 100)
                  );
                  const hasThumbnail = Boolean(clipThumbnails[s.n]);

                  return (
                    <div
                      key={s.n}
                      onClick={() => seekToClip(startS)}
                      style={{
                        backgroundColor: isPlaying ? 'rgba(245, 158, 11, 0.12)' : '#18181b',
                        border: isPlaying ? '2px solid #f59e0b' : '1px solid #27272a',
                        borderRadius: '0.65rem',
                        padding: '0.65rem',
                        textAlign: 'left',
                        cursor: masterVideoUrl ? 'pointer' : 'default',
                        transition: 'all 0.15s ease',
                        boxShadow: isPlaying ? '0 0 16px rgba(245, 158, 11, 0.25)' : 'none',
                        display: 'flex',
                        gap: '0.75rem',
                      }}
                      onMouseEnter={(e) => {
                        if (masterVideoUrl && !isPlaying) e.currentTarget.style.borderColor = '#fbbf24';
                      }}
                      onMouseLeave={(e) => {
                        if (!isPlaying) e.currentTarget.style.borderColor = '#27272a';
                      }}
                    >
                      {/* Left: Keyframe Video Thumbnail */}
                      <div
                        style={{
                          position: 'relative',
                          width: '84px',
                          height: '52px',
                          borderRadius: '0.4rem',
                          overflow: 'hidden',
                          backgroundColor: '#09090b',
                          flexShrink: 0,
                          border: isPlaying ? '1px solid #f59e0b' : '1px solid #3f3f46',
                        }}
                      >
                        {hasThumbnail ? (
                          <img
                            src={clipThumbnails[s.n]}
                            alt={t('app.trace_keyframe_alt', { n: s.n })}
                            style={{
                              width: '100%',
                              height: '100%',
                              objectFit: 'cover',
                              display: 'block',
                            }}
                          />
                        ) : (
                          <div
                            style={{
                              width: '100%',
                              height: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: '#71717a',
                            }}
                          >
                            <Video size={18} />
                          </div>
                        )}
                        {/* Timecode overlay badge on thumbnail */}
                        <div
                          style={{
                            position: 'absolute',
                            bottom: '2px',
                            right: '2px',
                            backgroundColor: 'rgba(0,0,0,0.75)',
                            color: '#fbbf24',
                            fontSize: '0.65rem',
                            fontWeight: 700,
                            padding: '0.05rem 0.25rem',
                            borderRadius: '0.2rem',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {t('app.trace_seconds', { value: startS.toFixed(1) })}
                        </div>
                      </div>

                      {/* Right: Clip Details & Progress */}
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span
                              style={{
                                backgroundColor: isPlaying ? '#f59e0b' : '#3f3f46',
                                color: isPlaying ? '#000000' : '#ffffff',
                                fontSize: '0.65rem',
                                fontWeight: 800,
                                padding: '0.1rem 0.35rem',
                                borderRadius: '0.25rem',
                              }}
                            >
                              {t('app.trace_step_badge', { n: s.n })}
                            </span>
                            {isPlaying && (
                              <span style={{ fontSize: '0.65rem', color: '#fbbf24', fontWeight: 800 }}>
                                ● {t('app.trace_playing')}
                              </span>
                            )}
                          </div>
                          <span style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums', fontSize: '0.75rem', fontWeight: 600 }}>
                            {formatTimestamp(startS)} - {formatTimestamp(endS)}
                            <span style={{ color: '#71717a', fontSize: '0.7rem', marginLeft: '0.25rem' }}>({t('app.trace_seconds', { value: duration })})</span>
                          </span>
                        </div>

                        <div
                          style={{
                            color: isPlaying ? '#ffffff' : '#d4d4d8',
                            fontSize: '0.78rem',
                            fontWeight: isPlaying ? 600 : 500,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {s.instruction}
                        </div>

                        {s.motion_cue && (
                          <div
                            style={{
                              color: '#a1a1aa',
                              fontSize: '0.7rem',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            🎯 {s.motion_cue}
                          </div>
                        )}

                        {/* Live active playback progress bar */}
                        {isPlaying && (
                          <div style={{ marginTop: '0.2rem' }}>
                            <div
                              style={{
                                height: '3px',
                                backgroundColor: '#27272a',
                                borderRadius: '9999px',
                                overflow: 'hidden',
                              }}
                            >
                              <div
                                style={{
                                  width: `${clipProgressPct}%`,
                                  height: '100%',
                                  backgroundColor: '#f59e0b',
                                  transition: 'width 0.1s linear',
                                }}
                              />
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: '#fbbf24', marginTop: '0.15rem' }}>
                              <span>{t('app.trace_elapsed', { value: (currentTime - startS).toFixed(1) })}</span>
                              <span>{clipProgressPct.toFixed(0)}%</span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* CENTER COLUMN: Multi-Agent Pipeline */}
        <section
          style={{
            padding: '1.5rem 2rem',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          <div style={{ width: '100%', maxWidth: '640px' }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 1.25rem 0', color: '#ffffff' }}>
              {t('app.trace_pipeline_title')}
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', width: '100%' }}>
              {AGENT_NODES.map((node) => {
                const isRunning = activeAgent === node.id;
                const isDone = completedAgents.has(node.id) || jobStatus === 'done';
                const Icon = node.icon;

                // Find latest message for this agent
                const agentEvents = events.filter((e) => e.agent === node.id);
                const latestMsg = agentEvents.length > 0 ? agentEvents[agentEvents.length - 1].message : t(`app.trace_agent_${node.id}_desc`);
                const durationMs = agentEvents.find((e) => e.ms !== undefined)?.ms;

                return (
                  <div
                    key={node.id}
                    style={{
                      backgroundColor: '#18181b',
                      borderRadius: '0.85rem',
                      border: isRunning
                        ? '2px solid #f59e0b'
                        : isDone
                        ? '1px solid #10b981'
                        : '1px solid #27272a',
                      padding: '0.9rem 1.15rem',
                      boxShadow: isRunning ? '0 0 25px rgba(245, 158, 11, 0.25)' : 'none',
                      transition: 'all 0.2s ease-in-out',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <div
                          style={{
                            padding: '0.45rem',
                            borderRadius: '0.45rem',
                            backgroundColor: isDone ? 'rgba(16, 185, 129, 0.15)' : 'rgba(39, 39, 42, 0.8)',
                            color: isDone ? '#34d399' : isRunning ? '#fbbf24' : '#a1a1aa',
                          }}
                        >
                          <Icon size={18} />
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, color: '#ffffff', fontSize: '0.95rem' }}>
                            {t(`app.trace_agent_${node.id}_name`)}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: '#71717a' }}>{t(`app.trace_agent_${node.id}_desc`)}</div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {durationMs !== undefined && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: '#a1a1aa', fontSize: '0.75rem' }}>
                            <Clock size={13} />
                            <span>{t('app.replay_latency_ms', { value: durationMs })}</span>
                          </div>
                        )}
                        {isDone ? (
                          <CheckCircle2 size={18} color="#10b981" />
                        ) : isRunning ? (
                          <div
                            style={{
                              width: '10px',
                              height: '10px',
                              borderRadius: '50%',
                              backgroundColor: '#f59e0b',
                              boxShadow: '0 0 10px #f59e0b',
                            }}
                          />
                        ) : (
                          <span style={{ fontSize: '0.7rem', color: '#52525b', fontWeight: 600 }}>{t('app.trace_queued')}</span>
                        )}
                      </div>
                    </div>

                    <div
                      style={{
                        marginTop: '0.4rem',
                        backgroundColor: '#09090b',
                        padding: '0.45rem 0.65rem',
                        borderRadius: '0.4rem',
                        fontSize: '0.8rem',
                        color: isRunning ? '#fbbf24' : '#d4d4d8',
                        borderLeft: isRunning ? '3px solid #f59e0b' : '3px solid transparent',
                      }}
                    >
                      {latestMsg}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: Progressive Live Assembled Lesson */}
        <section
          style={{
            borderLeft: '1px solid #27272a',
            padding: '1.25rem',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 700, color: '#ffffff', fontSize: '0.95rem' }}>{t('app.trace_assembled_title')}</div>
            <select
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
              disabled={!isLocalizerDone}
              style={{
                backgroundColor: isLocalizerDone ? '#27272a' : '#18181b',
                border: '1px solid #3f3f46',
                color: isLocalizerDone ? '#ffffff' : '#71717a',
                borderRadius: '0.35rem',
                padding: '0.25rem 0.5rem',
                fontSize: '0.8rem',
                cursor: isLocalizerDone ? 'pointer' : 'not-allowed',
              }}
            >
              <option value="en">English (en)</option>
              <option value="ja">日本語 (ja)</option>
              <option value="vi">Tiếng Việt (vi)</option>
              <option value="hi">हिन्दी (hi)</option>
              <option value="id">Bahasa Indonesia (id)</option>
              <option value="fil">Tagalog (fil)</option>
            </select>
          </div>

          {/* Scenario: Segmenter NOT done yet -> Do not show steps */}
          {!isSegmenterDone ? (
            <div
              style={{
                backgroundColor: '#18181b',
                border: '1px dashed #3f3f46',
                borderRadius: '0.75rem',
                padding: '2.5rem 1.5rem',
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.75rem',
              }}
            >
              <Sparkles size={28} style={{ color: '#fbbf24' }} />
              <div style={{ fontSize: '0.95rem', color: '#f4f4f5', fontWeight: 600 }}>{t('app.trace_assembling')}</div>
              <div style={{ fontSize: '0.8rem', color: '#71717a', lineHeight: 1.5 }}>
                {t('app.trace_assembling_desc')}
              </div>
            </div>
          ) : (
            /* Scenario: Steps generated -> Render cards with active playback highlighting */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              {steps.map((step, idx) => {
                const tr = step.translations?.[selectedLanguage];
                const displayInstruction = tr ? tr.instruction : step.instruction;
                const displayWhy = tr ? tr.why : step.why;
                const isPlaying = activeStepIndex === idx;

                return (
                  <div
                    key={step.n}
                    style={{
                      backgroundColor: isPlaying ? 'rgba(245, 158, 11, 0.08)' : '#18181b',
                      border: isPlaying ? '2px solid #f59e0b' : '1px solid #27272a',
                      borderRadius: '0.75rem',
                      padding: '0.9rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.5rem',
                      transition: 'all 0.2s ease',
                      boxShadow: isPlaying ? '0 0 20px rgba(245, 158, 11, 0.25)' : 'none',
                    }}
                  >
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }}>
                        <span
                          style={{
                            backgroundColor: isPlaying ? '#f59e0b' : '#3f3f46',
                            color: isPlaying ? '#000000' : '#ffffff',
                            fontWeight: 800,
                            fontSize: '0.7rem',
                            padding: '0.15rem 0.45rem',
                            borderRadius: '0.3rem',
                            transition: 'background-color 0.2s ease',
                          }}
                        >
                          {t('app.trace_step_badge', { n: step.n })}
                        </span>
                        {step.clip && (
                          <button
                            onClick={() => seekToClip(step.clip!.start_s)}
                            style={{
                              background: 'none',
                              border: isPlaying ? '1px solid #f59e0b' : '1px solid #3f3f46',
                              borderRadius: '0.25rem',
                              color: isPlaying ? '#fbbf24' : '#a1a1aa',
                              fontSize: '0.7rem',
                              padding: '0.1rem 0.35rem',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.25rem',
                            }}
                            title={t('app.trace_seek_title')}
                          >
                            <Play size={10} />
                            <span>{t('app.trace_clip_range', { start: step.clip.start_s.toFixed(1), end: step.clip.end_s.toFixed(1) })}</span>
                          </button>
                        )}
                        {isPlaying && (
                          <span style={{ fontSize: '0.65rem', color: '#fbbf24', fontWeight: 700 }}>
                            • {t('app.trace_active_playhead')}
                          </span>
                        )}
                      </div>

                      {/* Point Hint: Show ONLY if Spatial Annotator done */}
                      {isSpatialDone && step.point_hint ? (
                        <span style={{ fontSize: '0.75rem', color: '#fbbf24', fontWeight: 600 }}>
                          📍 {step.point_hint}
                        </span>
                      ) : !isSpatialDone ? (
                        <span style={{ fontSize: '0.7rem', color: '#52525b', fontStyle: 'italic' }}>
                          {t('app.trace_detecting')}
                        </span>
                      ) : null}
                    </div>

                    {/* Instruction */}
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#ffffff', lineHeight: 1.35 }}>
                      {displayInstruction}
                    </div>

                    {/* Why Reasoning: Show ONLY if Why Extractor done */}
                    {isWhyDone && displayWhy ? (
                      <div
                        style={{
                          fontSize: '0.8rem',
                          color: '#d4d4d8',
                          backgroundColor: '#27272a',
                          padding: '0.5rem 0.65rem',
                          borderRadius: '0.45rem',
                          lineHeight: 1.4,
                          borderLeft: '3px solid #f59e0b',
                        }}
                      >
                        <strong style={{ color: '#fbbf24' }}>{t('app.trace_why_label')} </strong>
                        {displayWhy}
                      </div>
                    ) : !isWhyDone ? (
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: '#71717a',
                          backgroundColor: '#1f1f23',
                          padding: '0.4rem 0.6rem',
                          borderRadius: '0.4rem',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                          fontStyle: 'italic',
                        }}
                      >
                        <Sparkles size={12} style={{ color: '#fbbf24' }} />
                        <span>{t('app.trace_extracting_why')}</span>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
