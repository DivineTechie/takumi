# TAKUMI (匠) — Judges Walkthrough & Evaluation Guide

Welcome to the TAKUMI evaluation guide for the **Google Cloud AI Builder Cup 2026 (Manufacturing Track)**.

- **Deployed Web Application**: [https://takumi-cup-2026.web.app](https://takumi-cup-2026.web.app)
- **Live System Observability**: [https://takumi-cup-2026.web.app/status](https://takumi-cup-2026.web.app/status)
- **Architecture Overview**: [docs/architecture.md](architecture.md) & [docs/architecture.svg](architecture.svg)
- **Detailed Feature Matrix**: [docs/FEATURE_STATUS.md](FEATURE_STATUS.md)

---

## Evaluation Accounts

TAKUMI supports three specialized personas. Pre-configured evaluation accounts have been provisioned in Firebase Authentication:

| Role | Account Email | Scope & Permissions |
| :--- | :--- | :--- |
| **Trainee** | `judge-trainee@takumi-cup-2026.web.app` | Live multimodal workbench coaching, speech interaction, spatial reticles, and Skill Passport generation. |
| **Supervisor** | `judge-supervisor@takumi-cup-2026.web.app` | Factory line competency analytics, skill matrix, error heatmaps, triage queue, and session timeline replay. |
| **Master** | `judge-master@takumi-cup-2026.web.app` | Live skill capture (/capture), lesson preview (/coach), demonstration review, and curriculum authoring. |

> [!NOTE]
> **Account Passwords**:
> To ensure production security while keeping documentation public, account passwords are submitted securely through the official competition submission portal and confidential submission form.
> Alternatively, you can sign in directly using any personal or corporate **Google Account** via Google Sign-In; standard sign-ins default to the Trainee role.

### How to Sign In with a Test Account
1. Open [https://takumi-cup-2026.web.app](https://takumi-cup-2026.web.app).
2. On the sign-in screen, click **"Use a test account"** below the Google Sign-In button.
3. Enter the judge account email and password, then click **Sign In**.

---

## 1. Quick Evaluation (Try It Without a Physical Kit)

You do **not** need physical industrial wiring hardware to evaluate TAKUMI's conversational intelligence, multilingual capabilities, spatial guidance, and supervisor analytics.

### Walkthrough A: Conversational & Multilingual Live Coach
1. Sign in as `judge-trainee@takumi-cup-2026.web.app`.
2. Allow microphone and camera permissions when prompted by your browser (pointing your camera at any desk surface or object).
3. **Conversational Greeting**: Listen as `gemini-3.8-live` greets you over streaming WebSocket audio and introduces Step 1 of the terminal block wiring procedure.
4. **Hands-On Rationale ("Why?")**:
   - Ask out loud: *"Why do I need to use a ferrule on stranded copper wire?"*
   - Notice the low latency (typically 700–1,100 ms to first audio byte).
   - The coach explains the electrical engineering rationale: preventing loose strands from shorting or breaking under screw compression.
5. **Multilingual Fluency Test**:
   - Tap the language selector in the coaching interface and switch to **Hindi** (हिन्दी) or **Vietnamese** (Tiếng Việt).
   - Say a simple greeting or question in your chosen language (e.g., *"Step 1 kya hai?"* or *"Bước tiếp theo là gì?"*).
   - The coach responds in natural localized voice synthesis with appropriate factory vocabulary.

### Walkthrough B: Supervisor Analytics & Session Replay
1. Sign in as `judge-supervisor@takumi-cup-2026.web.app` (or switch to the Supervisor view).
2. Navigate to the **Supervisor Dashboard** (`/dashboard`):
   - **Competency Matrix**: View factory-floor proficiency across shifts, showing real-time certification rates.
   - **Step Friction Heatmap**: Identify which physical assembly steps cause the most mistakes and hesitations across cohorts.
   - **Review Triage Queue**: View flagged steps where trainees struggled or where anomalous verifications occurred.
   - **Session Replay**: Select a recorded session to inspect the **event timeline with transcript lines**, reticle coordinates, and step verification states. (To respect worker privacy, no raw trainee audio is stored).

### Walkthrough C: Master Skill Capture & Lesson Preview
1. Sign in as `judge-master@takumi-cup-2026.web.app`.
2. **Master Skill Capture** (`/capture`):
   - Access the live **Capture Studio** via the "Teach a skill" card or direct navigation to `/capture`.
   - Experience live camera recording, device switching, or video upload for master demonstrations with client-side frame extraction and structured step authoring.
3. **Lesson Preview**:
   - Masters can preview trainee coaching modules directly at `/coach` and `/coach/:skillId` without polluting factory line analytics (master sessions are excluded from supervisor metrics by default).

### Walkthrough D: Reference Photos (Coming Oct 14)
> [!NOTE]
> During final physical test-rig validation on **October 14**, high-resolution interactive workbench photos will be provided directly in this section so evaluators can point their phone camera at an on-screen monitor to trigger live visual step transitions.

---

## 2. Hands-On Evaluation (If You Have a Terminal-Block Kit)

If you have a standard DIN-rail terminal block assembly kit (DIN rail, screw-clamp terminal blocks, 1.5 mm² stranded wire, and bootlace ferrules):

### Step-by-Step Hands-On Guide

1. **Mount your phone**: Place your phone in a desk stand or gooseneck clamp 30–40 cm above your workbench, pointing downward at the terminal block.
2. **Start Session**: Open the app and begin the **DIN-Rail Terminal Block Wiring** module.
3. **Spatial Pinpointing (`gemini-robotics-er-2-preview`)**:
   - Ask out loud: *"Can you point to terminal 1?"* or *"Where does the blue wire go?"*
   - Observe the animated reticle render directly over terminal 1 on your video preview within ~2 seconds.
4. **Visual Verification (Hands-Free)**:
   - Insert the ferruled blue wire into terminal 1 and tighten the clamp screw.
   - **Note: There is NO manual "Verify" button.**
   - TAKUMI automatically verifies your work in one of two ways:
     - **Verbal confirmation**: Simply say *"Done"* or *"I finished step 1"*.
     - **Hands-Free Watcher**: The visual watcher (`gemini-3.5-flash-lite`) automatically observes that your hands have completed the action and triggers verification.
   - While `gemini-3.8-flash` validates the connection against physical success criteria, a pulsing **"Checking…"** status chip appears in the bottom sheet.
5. **Planted Mistake Test (Verifier Strictness)**:
   - Try inserting an unferruled wire with frayed copper strands, or insert into terminal 2 instead of terminal 1.
   - Say *"Done"*.
   - Notice that TAKUMI **rejects the step**, explaining the exact visual discrepancy (e.g. *"Terminal 1 is empty; wire was placed in terminal 2"* or *"Bare copper strands visible; ferrule missing"*).
6. **Safety Rule Hazard Test**:
   - Leave bare copper strands visible outside the clamp or trigger an unsafe workbench condition.
   - The visual watcher flags visible hazards such as bare copper, speaks a warning, and stops the trainee with a full-screen STOP overlay until marked safe.
7. **Skill Passport Credential**:
   - Complete all assembly steps.
   - The session finalizes and issues a cryptographic, verifiable digital **Skill Passport** certifying your competence.

---

## 3. Observability & System Health

TAKUMI provides production transparency through dedicated endpoints:

- **Observability Dashboard**: Visit [https://takumi-cup-2026.web.app/status](https://takumi-cup-2026.web.app/status) to view:
  - Cloud Run API health and deployment version.
  - Deep Gemini connectivity ping (`gemini-3.5-flash-lite`).
  - BigQuery telemetry stream status.
  - Current circuit-breaker and rate-limiting status.

---

## 4. Master Pipeline Status (Member B)

The master demonstration capture studio (`/capture`) is now deployed and live on the production site:
- **Master Capture Screen (`/capture`)**: **Live**. Enables hands-on video recording, multi-camera selection, client-side frame extraction, and demonstration ingestion in the browser.
- **Automated Forge Graph Pipeline (`takumi-forge`)**: **In progress**. Google ADK 2.0 graph workflow on Cloud Run processing master videos through multimodal segmentation (`gemini-omni-1.1-flash`), "why" rationale extraction (`gemini-3.8-flash`), spatial annotation (`gemini-robotics-er-2-preview`), and mistake simulation (`veo-3.1-fast-generate-preview`) until end-to-end automated publishing is finalized.
- **Skill Review & Library (`/review/:skillId`, `/library`)**: **Live in web application**, staging integration active.

---

## 5. Troubleshooting & Tips

- **Camera / Microphone Access**: If the browser blocks media devices, check site permissions in your browser address bar and grant both audio and video access.
- **Audio Echo**: For the best experience, use headphones or ensure phone speaker audio does not loop directly into the microphone.
- **Lighting & Focus**: Ensure adequate workbench lighting. Glare or heavy shadows on dark terminal blocks may slow down the visual verifier.
