# TAKUMI (匠) — Hands-On Skill Transfer via Multimodal AI

> **Google Cloud AI Builder Cup 2026 — Manufacturing Track**  
> **Live Web Application**: [https://takumi-cup-2026.web.app](https://takumi-cup-2026.web.app)  
> **System Health & Observability**: [https://takumi-cup-2026.web.app/status](https://takumi-cup-2026.web.app/status)  
> **Evaluation & Benchmark Reports**: [/evals/coach](evals/coach) (eval benchmark suite runs on Oct 14)  
> **Judges Walkthrough Guide**: [docs/JUDGES.md](docs/JUDGES.md)

---

## 1. Problem & Vision

### The Crisis on the Factory Floor
Across advanced manufacturing hubs in the Asia-Pacific region, an acute demographic transition is intersecting with rapid industrial reliance on migrant labor:

1. **Aging Master Craftsmen (*Takumi*)**: Experienced technicians retire with know-how that paper instructions don't capture.
2. **Growing Multilingual Migrant Workforce**:
   - **Japan**: Foreign workers reached **2,571,037** at the end of October 2025, with Vietnamese nationals forming the largest demographic at **605,906** workers ([MHLW national press release PDF](https://www.mhlw.go.jp/content/11655000/001646128.pdf)).
   - **South Korea**: Foreign workers under the Employment Permit System reached a record **287,424** as of July 2026, with **229,844** (80%) working in manufacturing ([The Korea Times](https://www.koreatimes.co.kr/southkorea/20260902/number-of-foreign-workers-under-employment-permit-system-hits-record-high)).
   - **Taiwan**: Taiwan's manufacturing sector similarly depends on a substantial migrant workforce navigating technical operations across language barriers.
3. **The Communication and Safety Penalty**: Language barriers between supervisors and newly arrived trainees lead to onboarding delays and severe safety risks. In Japan, **6,244** foreign workers were killed or injured (requiring 4+ days off work) in 2024, passing 6,000 for the first time, with the MHLW citing "insufficient education on safety management and poor communication", as reported by the [Business & Human Rights Resource Centre](https://www.business-humanrights.org/en/latest-news/japan-number-of-work-related-injuries-and-deaths-among-foreign-workers-exceeds-6000-for-the-first-time-in-2024/).

### The TAKUMI Solution
TAKUMI bridges this gap through a dual-agent architecture built entirely on Google AI and Google Cloud:
1. **Master Capture & Forge (Member B — In Progress)**: In progress to capture a master craftsman's physical demonstration once via a smartphone camera. An automated Google ADK 2.0 graph pipeline is designed to segment demonstrations into discrete steps, extract engineering rationale ("why"), annotate spatial coordinates, cross-reference technical SOP manuals, and localize guidance into 6 regional languages.
2. **Live Multimodal Coach (Member A)**: A trainee props their smartphone above their workbench. TAKUMI watches their hands in real time through the phone camera and converses with them over bidirectional streaming audio in their native language (e.g. Vietnamese, Hindi, Japanese, English). It offers continuous reassurance, flags visible hazards such as bare copper and stops the trainee with a full-screen STOP, points to correct terminal screws via spatial coordinate bounding boxes, and strictly verifies step completion against physical visual criteria.

---

## 2. Architecture

TAKUMI decouples rapid conversational speech from high-precision visual verification to guarantee low voice latency without hallucinated step approvals.

![TAKUMI System Architecture](docs/architecture.svg)

### Two Complementary Pipelines

```
[ Master Capture Video ] ──> [ Forge ADK Pipeline (Member B) ] ──> [ Structured Skill in Firestore ]
                                                                             │
[ Trainee Camera & Mic ] <──> [ Live Coach API / WebSocket (Member A) ] <────┘
                                        │
                         [ BigQuery Telemetry & Logging ]
```

1. **Forge Pipeline (Member B — In Progress)**: In development to ingest master demonstration video and technical SOP manuals. Implemented in code on branch `forge` using `gemini-omni-1.1-flash` for multimodal segmentation, `gemini-3.8-flash` for why-extraction and multilingual translation, `gemini-robotics-er-2-preview` for keyframe spatial annotation, and `gemini-3.1-flash-image` with `veo-3.1-fast-generate-preview` for visual instruction cards and mistake simulation clips.
2. **Live Coach Pipeline (Member A — Live in Production)**: Streams trainee audio and camera frames through a low-latency gateway. Uses `gemini-3.8-live` for natural bidirectional voice conversation, `gemini-3.5-flash-lite` for continuous visual progress tracking and hazard detection (1 FPS), `gemini-3.8-flash` for objective step verification against visible success criteria, and `gemini-robotics-er-2-preview` for reticle coordinates (`[y, x]`).

Detailed architectural rationale, sequence diagrams, and security topology are documented in [docs/architecture.md](docs/architecture.md).

---

## 3. Google Services & Model Matrix

All model identifiers are strictly isolated in configuration constants (`services/api/config.py`, `services/forge/config.py`, and `apps/web/src/config.ts`). Temperature parameters are omitted in accordance with Gemini 3.x deprecation guidelines.

| Service / Model ID | Role in TAKUMI | Call Site | Status | Owner |
| :--- | :--- | :--- | :--- | :--- |
| **`gemini-3.8-live`** | Bidirectional low-latency audio coaching; conversational explanation and reassurance | `apps/web/src/lib/live/client.ts`, `services/api/gemini.py` | **Live** | Member A |
| **`gemini-3.5-flash-lite`** | Visual step watcher (1 FPS candidate frames); hazard detection; deep health checks | `services/api/gemini.py` (`call_watch`, `check_deep_health`) | **Live** | Member A |
| **`gemini-3.8-flash`** | Strict objective step verification against success criteria; supervisor insight rollups | `services/api/gemini.py` (`call_verify`), `services/api/main.py` | **Live** | Member A |
| **`gemini-robotics-er-2-preview`** | Workbench spatial coordinate extraction (`[y, x]` reticle placement) | `services/api/gemini.py` (`call_point`) | **Live** | Member A |
| **`gemini-omni-1.1-flash`** | Master video multimodal step segmentation and tool extraction | `services/forge/graph/nodes/segmenter.py` | **In Progress** | Member B |
| **`gemini-3.8-flash` (Forge)** | Rationale ("why") extraction and localization across 6 JAPAC languages | `services/forge/graph/nodes/why_extractor.py`, `localizer.py` | **In Progress** | Member B |
| **`gemini-robotics-er-2-preview` (Forge)** | Keyframe spatial coordinate grounding against assembly drawings | `services/forge/graph/nodes/spatial_annotator.py` | **In Progress** | Member B |
| **`gemini-3.1-flash-image`** | Assembly instruction diagram synthesis from SOP manual excerpts | `services/forge/graph/nodes/illustrator.py` | **In Progress** | Member B |
| **`veo-3.1-fast-generate-preview`** | Counterfactual mistake simulation video clips (budget-capped at 3 per skill) | `services/forge/graph/nodes/mistake_simulator.py` | **In Progress** | Member B |
| **`gemini-3.8-flash-tts`** | High-fidelity synthetic speech for static instructional step playbacks | `services/forge/config.py` | **Planned** | Member B |
| **`gemini-embedding-2-preview`** | Vector grounding of industrial equipment manuals and plant standards | `services/api/config.py`, `services/forge/config.py` | **Planned** | Both |
| **Cloud Run (`takumi-api`)** | Stateless FastAPI Python 3.12 backend (auth, live tokens, watcher proxy, BigQuery) | `services/api/` (`asia-southeast1`) | **Live** | Member A |
| **Cloud Run (`takumi-forge`)** | Google ADK 2.0 graph execution container | `services/forge/` (`asia-southeast1`) | **In Progress** | Member B |
| **Firebase Hosting** | Global edge distribution for React 19 + TypeScript + Vite PWA | `takumi-cup-2026.web.app` | **Live** | Member A |
| **Firebase Authentication** | Identity management with custom role claims (`trainee`, `supervisor`, `master`) | Custom claims via Firebase Admin SDK | **Live** | Member A |
| **Cloud Firestore (Native)** | Operational database for sessions, skills, review requests, and passports | `(default)` in `asia-southeast1` | **Live** | Both |
| **Cloud Storage** | Single bucket for camera stills, keyframes, mistake media, and assets | `takumi-cup-2026.firebasestorage.app` | **Live** | Both |
| **BigQuery** | Analytics warehouse (`takumi.session_events`, `takumi.api_calls`) | Dataset `takumi` in `asia-southeast1` | **Live** | Member A |
| **Secret Manager** | Secure vault for API keys and service configurations; zero browser exposure | Secret `GEMINI_API_KEY` | **Live** | Member A |
| **Model Armor** | Pre-execution screening for prompt injection, jailbreaks, and toxicity | Template in `asia-southeast1` | **Live** | Member A |
| **Cloud Monitoring & Logging** | Structured JSON logging, availability metrics, and automated alert policies | GCP Project `takumi-cup-2026` | **Live** | Member A |
| **Cloud Build** | CI/CD pipeline with automated tests, security audits, container builds, and deployment | `infra/cloudbuild-coach.yaml` | **Live** | Both |

A granular breakdown of every component's operational status is available in [docs/FEATURE_STATUS.md](docs/FEATURE_STATUS.md).

---

## 4. User Personas & Workflows

### 1. Trainee (Live in Production)
- **Props a standard smartphone** on their assembly workbench; opens [https://takumi-cup-2026.web.app](https://takumi-cup-2026.web.app).
- **Selects native language** (English, Vietnamese, Hindi, Japanese, Indonesian, or Filipino).
- **Speaks naturally hands-free** with the coach via `gemini-3.8-live` over WebSockets.
- **Asks contextual questions** at any point (e.g. *"Why do I need a ferrule on stranded wire?"* or *"Can you show me where terminal 1 is?"*).
- **Receives spatial reticles** rendered directly over their live camera preview pinpointing components.
- **Completes training**: The system logs every step event, computes time-to-competence, and issues a tamper-evident digital credential (**Skill Passport**).

### 2. Supervisor (Live in Production)
- **Monitors line-wide proficiency** across all factory shifts via the Supervisor Dashboard (`/dashboard`).
- **Inspects competency heatmaps and skill matrices** aggregating trainee performance by step, language, and cohort.
- **Replays past training sessions**: Inspects step-by-step event timelines with transcribed speech exchanges, reticle coordinates, and verification outcomes (no raw trainee audio is stored).
- **Triage and Quality Control**: Dispatches review requests to veteran masters when trainees encounter recurring mistakes or step friction.

### 3. Master Craftsman (In Progress — Member B)
- **Records hands-on physical demonstrations** via smartphone camera (`/capture`).
- **Reviews automated Forge extractions** (`/review`): Inspects generated step boundaries, verifies inferred "why" explanations, and confirms technical manual cross-references.
- **Approves standardized skill curriculum** for factory deployment.

---

## 5. Live Multimodal Coach Deep-Dive

TAKUMI's live coaching experience solves the fundamental challenge of multimodal AI in industrial settings: **speed vs. accuracy**.

```
                           ┌────────────────────────────────────────┐
                           │            TRAINEE BROWSER             │
                           │  - Microphone (16 kHz PCM)             │
                           │  - Camera Stream (1 FPS JPEG)          │
                           │  - Speaker Audio (24 kHz PCM)          │
                           └───────┬────────────────────────▲───────┘
                                   │                        │
               Audio Stream (WS)   │                        │ Audio / Reticle
                                   ▼                        │
                         ┌──────────────────┐               │
                         │ gemini-3.8-live  │───────────────┘
                         └─────────▲────────┘
                                   │
              Text Events: "[CAMERA EVENT] Step 1 passed"
                                   │
                         ┌──────────────────┐
                         │   Step Watcher   │ <── 1 FPS Stills
                         │ (3.5-flash-lite) │
                         └─────────┬────────┘
                                   │
               Triggered on "Done" or High-Confidence Candidate
                                   ▼
                         ┌──────────────────┐
                         │  Step Verifier   │ <── High-Res Image (1280px)
                         │  (gemini-3.8)    │
                         └──────────────────┘
```

### Multimodal Separation of Concerns
1. **The Live Audio Loop**: Streams 16 kHz PCM audio directly to `gemini-3.8-live` via WebSocket using single-use bearer tokens minted by Cloud Run. Latency to first audio response averages **700–1,100 ms**, providing natural conversation with seamless trainee interruption.
2. **The Visual Watcher (`gemini-3.5-flash-lite`)**: Inspects 1 FPS camera frames through the backend API. It checks for:
   - Trainee task progress (e.g. wire inserted).
   - Common assembly mistakes (e.g. wrong terminal slot).
   - Critical safety hazards (e.g. bare copper exposed outside clamp, live panel contact).
   - Average execution latency: **~1,900 ms** (measured in production via BigQuery `api_calls`).
3. **Objective Step Verification (`gemini-3.8-flash`)**: The Live audio model is explicitly forbidden from advancing steps based on its own conversational assessment. A step is only advanced when:
   - The trainee verbally says *"done"*, or
   - The watcher detects hands-free task completion.
   - The verifier validates the workbench against strict physical success criteria (e.g., ferrule fully seated, zero bare copper strands visible).
   - Production latency: **~4.8 s** (tuned with `VERIFY_THINKING=low` and 1280 px max dimension).
4. **Spatial Pinpointing (`gemini-robotics-er-2-preview`)**: When the trainee asks *"Where is terminal 1?"*, the model returns normalized `[y, x]` coordinates rendered as an animated reticle on the phone screen.
   - Production latency: **~2.1 s** (tuned with `POINT_THINKING=0`).

---

## 6. Evaluations & Benchmarking

The TAKUMI test and evaluation suite provides reproducible accuracy and latency benchmarks:

- **Coach Evaluation Suite ([/evals/coach](evals/coach))**: Benchmarks watcher state classification accuracy, verifier strictness against planted mistakes, reticle coordinate error distance, and camera event injection speed. *(The automated evaluation benchmark suite runs on Oct 14 during final physical test-rig validation).*
- **Forge Evaluation Suite ([/evals/forge](evals/forge))**: Measures ADK graph step boundary segmentation precision, rationale extraction fidelity, and multi-lingual translation semantic consistency against reference electrical engineering manuals.

---

## 7. Production Hardening & Safety

TAKUMI is designed for enterprise manufacturing deployments with strict compliance and security controls:

1. **Model Armor Prompt Security**: Trainee text queries are passed through Google Cloud Model Armor deployed in `asia-southeast1`, screening for prompt injection, jailbreaks, and toxic inputs before model ingestion.
2. **Zero Client Secret Exposure**: Client browsers never receive long-lived GCP service account keys or Gemini API keys. All frontend sessions use short-lived, single-use authentication tokens minted by `POST /api/live-token` after Firebase ID token validation.
3. **Tiered Rate Limiting & Quota Guards**:
   - In-memory sliding-window token buckets on Cloud Run guard all public endpoints:
     - `/api/live-token`: 10 requests / min / IP.
     - `/api/watch`: 30 requests / min / IP.
     - `/api/verify`: 12 requests / min / IP.
     - `/api/point`: 12 requests / min / IP.
   - Global circuit breaker kill switch (`SESSIONS_ENABLED=false`) capable of pausing active coaching sessions instantly.
4. **Comprehensive Telemetry & Observability**:
   - Every API invocation captures execution duration (`model_ms` vs `total_ms`), token counts, and outcome status into BigQuery table `takumi.api_calls`.
   - Cloud Monitoring log-based metrics track `gemini_unavailable` errors and 5xx responses with automated alerting policies alerting project maintainers.
   - Public status page at [https://takumi-cup-2026.web.app/status](https://takumi-cup-2026.web.app/status) with real-time deep health probes.

---

## 8. Limitations & Engineering Disclosures

To provide complete transparency for judges and evaluators:

- **Production Scope**: Member A components (Live Coach, Watcher, Verifier, Spatial Reticles, Dashboard, Replay, Skill Passport, Observability) are live in production. Member B components (Forge ADK graph workflow, master capture ingestion, mistake video generation) are implemented on branch `forge` and in progress.
- **Physical Test Kit**: Full hardware verification has been benchmarked using high-resolution industrial terminal-block workbench photographs. Live end-to-end multi-language hardware validation with physical DIN rail test kits concludes on October 14.
- **Mobile Hardware**: The web application is optimized for mobile portrait viewports (tested at 390x844 on Safari iOS and Chrome Android). For optimal hands-free use, the device should be mounted on a standard gooseneck clamp 30–45 cm above the workbench.
- **Latency Variance**: Gemini Live audio latency is typically under 1 second. High-resolution visual verification (`gemini-3.8-flash`) requires 4–5 seconds to thoroughly reason through physical wiring attributes; a responsive "Checking..." pulse chip provides immediate user feedback during verification.

---

## 9. Running Locally

### Prerequisites
- Node.js 24+ and npm
- Python 3.12+
- Google Cloud SDK (`gcloud`)
- Firebase CLI (`firebase-tools`)

### 1. Repository Setup & Virtual Environment
```bash
git clone https://github.com/DivineTechie/takumi.git
cd takumi

# Create and activate Python virtual environment
python -m venv .venv
# Windows PowerShell:
.\.venv\Scripts\Activate.ps1
# Linux / macOS:
source .venv/bin/activate

# Install dependencies
pip install -r requirements-dev.txt
pip install -r services/api/requirements.txt
```

### 2. Schema Generation
Generate TypeScript interfaces and Pydantic models from canonical JSON schemas:
```bash
npm run schema
```

### 3. Environment Variables
Create a local `.env` file in `services/api/` (never committed):
```env
PROJECT_ID=takumi-cup-2026
GEMINI_API_KEY=your_gemini_api_key_here
LOCATION=asia-southeast1
BIGQUERY_DATASET=takumi
SESSIONS_ENABLED=true
VERIFY_THINKING=low
VERIFY_MAX_PX=1280
POINT_THINKING=0
```

### 4. Running the Backend API
```bash
uvicorn services.api.main:app --reload --port 8080
```
Verify the API health check at [http://localhost:8080/healthz](http://localhost:8080/healthz).

### 5. Running the Web Frontend
In a separate terminal:
```bash
cd apps/web
npm install
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

### 6. Executing Tests
```bash
# Web Vitest suite
npm --prefix apps/web test

# Python backend pytest suite
pytest services/api/tests/
```

---

## 10. Deployment

TAKUMI deploys continuously through Google Cloud Build:

- **Branch `coach`**: Deploys `takumi-api` to Cloud Run and `apps/web` to Firebase Hosting via `infra/cloudbuild-coach.yaml`.
- **Branch `main`**: Production deployment pipeline for merged changes.

Manual container build:
```bash
docker build -f services/api/Dockerfile . -t asia-southeast1-docker.pkg.dev/takumi-cup-2026/takumi-repo/takumi-api:latest
```

---

## 11. Team

- **Member A (Lead / Platform & Live Coach)**: Systems architecture, FastAPI Cloud Run API, Gemini Live WebSocket gateway, visual watcher & verifier, supervisor analytics dashboard, skill passport, observability, and submission package.
- **Member B (Master Capture & Forge Pipeline)**: Master video capture UI, Google ADK 2.0 graph workflow, multimodal step segmenter, why-extractor, technical manual cross-validator, and generative illustration assets.

---

## 12. License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.

---

## 13. Sources

1. **Japan Foreign Workers (Oct 2025)**: Ministry of Health, Labour and Welfare (MHLW), *Summary of Foreign Worker Employment Situation*, [https://www.mhlw.go.jp/content/11655000/001646128.pdf](https://www.mhlw.go.jp/content/11655000/001646128.pdf).
2. **Japan Foreign Worker Casualties (2024)**: Business & Human Rights Resource Centre, *Japan: Number of work-related injuries and deaths among foreign workers exceeds 6,000 for the first time in 2024*, reporting MHLW announcement, [https://www.business-humanrights.org/en/latest-news/japan-number-of-work-related-injuries-and-deaths-among-foreign-workers-exceeds-6000-for-the-first-time-in-2024/](https://www.business-humanrights.org/en/latest-news/japan-number-of-work-related-injuries-and-deaths-among-foreign-workers-exceeds-6000-for-the-first-time-in-2024/).
3. **South Korea EPS Workforce (July 2026)**: The Korea Times (Sept 2, 2026), *Number of foreign workers under employment permit system hits record high*, [https://www.koreatimes.co.kr/southkorea/20260902/number-of-foreign-workers-under-employment-permit-system-hits-record-high](https://www.koreatimes.co.kr/southkorea/20260902/number-of-foreign-workers-under-employment-permit-system-hits-record-high).
