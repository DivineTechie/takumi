# Master Capture Screen (`/capture`)

Owned by **Member B**. Mobile-first capture interface allowing a master craftsman to record hands-on tasks while an AI apprentice interviewer (`gemini-3.8-live`) asks short, non-disruptive &ldquo;why&rdquo; questions at natural pauses.

---

## Architecture & Data Flow

1. **Setup Screen**:
   - Master inputs skill title, selects language (`ja`, `en`, `vi`, `hi`, `id`, `fil`), and optionally attaches a technical manual PDF.
   - Initialized with Stitch-style large touch targets, high contrast, and glove-friendly spacing.
2. **On Start**:
   - Creates `captures/{captureId}` in Firestore with status `"recording"`.
   - Requests a single-use token via `POST /api/live-token` (`purpose: "interview"`).
   - Establishes a direct WebSocket to `wss://generativelanguage.googleapis.com/...` for `gemini-3.8-live`.
   - Uses `AudioWorklet` (`/pcm-processor.js`) to stream 16 kHz mono 16-bit PCM in ~40 ms chunks.
   - Samples 1 FPS 768px wide JPEG frames from the back camera (`facingMode: "environment"`).
3. **Apprentice Interviewer Behavior**:
   - Asks ≤12-word "why" questions only at natural pauses in the craftsman's language.
   - Ingests audio and plays 24 kHz PCM responses, immediately silencing on user speech interruption.
   - Gathers timestamped transcript entries in `captures/{id}.transcript`.
4. **Recording & Upload**:
   - `MediaRecorder` captures ~2.5 Mbps WebM stream.
   - Uploads directly to `gs://<bucket>/captures/{id}/master.webm` via Firebase Storage resumable upload.
   - Handles network disconnection and automatically pauses/resumes upload when connectivity returns.
5. **Completion**:
   - Sets status to `"uploaded"`.
   - Dispatches `POST /forge/jobs {"capture_id": captureId}`.
   - Navigates to `/forge/{jobId}` for the live Agent Trace.

---

## Manual Test Checklist

- [ ] **Glove Usability & Layout**:
  - Open `/capture` on mobile (390×844) and desktop (1440×900).
  - Verify all touch targets (buttons, inputs, language chips) are at least 48px to 64px tall with high contrast.
- [ ] **Camera Access**:
  - Confirm back camera (`environment`) is selected by default at approximately 1280×720 resolution.
  - Deny camera permission once to verify user-facing error banner appears cleanly.
- [ ] **Language Selection**:
  - Verify language selection defaults to `ja` and persists to the Firestore capture document.
- [ ] **Manual PDF Attachment**:
  - Attach a sample PDF and verify upload to `gs://<bucket>/manuals/<uuid>.pdf`.
- [ ] **Live Interviewer Connection**:
  - Start capture; verify WebSocket handshake to `gemini-3.8-live` succeeds.
  - Speak in the selected language; confirm apprentice interviewer asks relevant "why" questions without speaking over active tasks.
  - Verify question callout cards appear on the HUD.
- [ ] **Interruption Handling**:
  - Speak while the AI apprentice is speaking; verify playback stops immediately upon interruption.
- [ ] **Transcript Aggregation**:
  - Verify transcript entries are captured with accurate timestamps relative to recording start and cleaned of `<no speech>` and `{pause}` tags.
- [ ] **Upload Resilience**:
  - Turn off Wi-Fi mid-upload; verify upload pauses with status warning.
  - Turn on Wi-Fi; confirm upload resumes without re-uploading from 0%.
- [ ] **Job Dispatch**:
  - On finish, verify `captures/{id}` status changes to `"uploaded"`, `POST /forge/jobs` is called, and browser navigates to `/forge/:jobId`.
