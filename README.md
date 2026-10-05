# TAKUMI (匠)

TAKUMI (匠) captures a master craftsman's skill once and teaches it live to any worker, in any JAPAC language, through a phone camera. Built on Gemini Live, Gemini Robotics ER, Google ADK agents, Cloud Run, Firebase and BigQuery for the Google Cloud AI Builder Cup 2026.

## Architecture

TAKUMI consists of two core pipelines:
1. **Master Capture & Forge (Member B)**: Video and audio captured from a master craftsman are ingested through an agentic pipeline (Google ADK 2.0 graph workflow) that segments steps, extracts visual cues, infers "why" explanations, resolves spatial coordinate pointers, validates against technical manuals, and generates localized assets.
2. **Live Coach & Telemetry (Member A)**: Real-time worker assistance using Gemini Live bidirectional audio and camera vision. The watcher agent verifies step success criteria and catches mistakes in real time, streaming event telemetry to BigQuery for insights.

```
[ Master Capture ] ──> [ Forge Agents (ADK 2.0) ] ──> [ Firestore / GCS ]
                                                             │
[ Phone Camera / Mic ] <──> [ Live Coach API ] <─────────────┘
                                     │
                             [ BigQuery Telemetry ]
```

## Features

- **Hands-Free Live Coaching**: Bidirectional voice and camera guidance with zero-latency interruption support.
- **Strict Visual Verification**: Objective visible success criteria prevent false step advances.
- **Multilingual Support**: Live coaching and localized audio/text in English, Japanese, Vietnamese, Hindi, Indonesian, and Filipino.
- **Verified Skill Passport**: Verifiable digital credentials issued upon successful completion of hands-on tasks.
- **Continuous Quality Insights**: Telemetry-driven review requests flagging problematic steps for master inspection.

## Google services used

- **Google GenAI SDK & Models**:
  - `gemini-3.8-live` (Live bidirectional voice coach)
  - `gemini-3.5-flash-lite` (High-frequency visual step watcher)
  - `gemini-3.8-flash` (Orchestration, verification, and insight generation)
  - `gemini-robotics-er-2-preview` (Spatial reasoning and coordinate extraction)
  - `gemini-3.1-flash-image` & `veo-3.1-fast-generate-preview` (Visual card and mistake illustrations)
  - `gemini-omni-1.1-flash` (Multimodal analysis)
  - `gemini-3.8-flash-tts` (Localized audio synthesis)
  - `gemini-embedding-2-preview` (Manual and documentation retrieval)
- **Cloud Run**: Serverless container hosting for FastAPI API and Forge agent workflows.
- **Firebase**: Firebase Auth (Google Sign-In with custom role claims) and Firebase Hosting.
- **Firestore (Native)**: Structured documents for captures, skills, jobs, sessions, and passports.
- **Cloud Storage**: Single unified bucket for raw captures, keyframes, mistake clips, and generated audio.
- **BigQuery**: Streaming dataset `takumi.session_events` for real-time telemetry and cohort analytics.
- **Secret Manager**: Secure API key and credential management.

## Evals

- `/evals/coach`: Live coach response latency, instruction adherence, and camera event injection tests.
- `/evals/forge`: ADK graph pipeline evals measuring segmentation accuracy, why extraction, and verifier precision against technical manuals.

## Run locally

### 1. Prerequisites
- Node.js 24+ and npm
- Python 3.12+
- Git

### 2. Python Environment Setup
Always use a local virtual environment at the repository root:
```bash
# Create virtual environment
python -m venv .venv

# Activate virtual environment
# Windows PowerShell:
.\.venv\Scripts\Activate.ps1
# Linux / macOS:
source .venv/bin/activate

# Install developer dependencies
pip install -r requirements-dev.txt
pip install -r services/api/requirements.txt
```

### 3. Schema Generation
Generate both TypeScript types (`shared/schema/ts`) and Pydantic v2 models (`shared/schema/py`):
```bash
npm run schema
# or using Makefile:
make schema
```

### 4. Web Application (React 19 + Vite)
```bash
cd apps/web
npm install
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

### 5. API Service (FastAPI)
From the repository root:
```bash
# Windows PowerShell:
.\.venv\Scripts\uvicorn services.api.main:app --reload --port 8080

# Linux / macOS:
./.venv/bin/uvicorn services.api.main:app --reload --port 8080
```
Verify the health check at [http://localhost:8080/healthz](http://localhost:8080/healthz).

### 6. Running Tests & Linting
```bash
# Run web unit tests (Vitest)
npm --prefix apps/web test

# Run web linter (ESLint)
npm --prefix apps/web run lint

# Run Python tests (Pytest)
.\.venv\Scripts\pytest
```

## Deploy

### API Service Container
Build the API container with the build context set to the repository root so the shared schemas and libraries can be imported:
```bash
docker build -f services/api/Dockerfile . -t takumi-api:latest
```

Run locally or deploy to Google Cloud Run:
```bash
# Test the Docker image locally
docker run -p 8080:8080 takumi-api:latest

# Deploy to Cloud Run (P1+)
# gcloud run deploy takumi-api --image ... --region ...
```

## Team

- **Member A**: Platform, Live Coach, insights, submission.
- **Member B**: Master capture, Forge agents, master review.
