# TAKUMI — Google Models and Cloud Services Feature Status

This inventory records the deployment status and ownership for all Google AI models and Google Cloud services across the TAKUMI codebase as of October 2026.

## Status Definitions
- **Live**: Implemented, tested, deployed, and serving traffic in production on `https://takumi-cup-2026.web.app` and Cloud Run.
- **In Progress (Member B)**: Implemented in code on branch `forge` or deployed in staging; pipeline integration active.
- **Planned**: Defined in architectural specifications and configuration files; planned for future milestones.

---

## 1. Google AI Models (`google-genai` SDK)

| Model ID | Responsibility / Job in TAKUMI | Source Code Call Site | Production Status | Owner |
| :--- | :--- | :--- | :--- | :--- |
| `gemini-3.8-live` | Real-time bidirectional voice coaching with low-latency interruption support. Streams 16 kHz PCM audio in, 24 kHz PCM audio out. | [`apps/web/src/lib/live/client.ts`](file:///c:/takumi/apps/web/src/lib/live/client.ts), [`services/api/gemini.py`](file:///c:/takumi/services/api/gemini.py) | **Live** | Member A |
| `gemini-3.5-flash-lite` | High-frequency (1 FPS) visual step watcher detecting task progression, common mistakes, and safety rule hazards; deep health pings. | [`services/api/gemini.py`](file:///c:/takumi/services/api/gemini.py) (`call_watch`, `check_deep_health`) | **Live** | Member A |
| `gemini-3.8-flash` | Strict objective step verification against visible success criteria and safety rules; supervisor insight aggregation. | [`services/api/gemini.py`](file:///c:/takumi/services/api/gemini.py) (`call_verify`), [`services/api/main.py`](file:///c:/takumi/services/api/main.py) | **Live** | Member A |
| `gemini-robotics-er-2-preview` | Spatial coordinate extraction and workbench reticle pointing (`[y, x]` normalized coordinates). | [`services/api/gemini.py`](file:///c:/takumi/services/api/gemini.py) (`call_point`) | **Live** | Member A |
| `gemini-omni-1.1-flash` | Multimodal analysis of raw master craftsman video recordings into structured assembly steps. | `services/forge/graph/nodes/segmenter.py` (branch `forge`) | **In progress** | Member B |
| `gemini-3.8-flash` (Forge) | Extraction of underlying rationale ("why" explanations) and multilingual localization across JAPAC target languages. | `services/forge/graph/nodes/why_extractor.py`, `localizer.py` (branch `forge`) | **In progress** | Member B |
| `gemini-robotics-er-2-preview` (Forge) | Spatial coordinate keyframe annotation and technical manual alignment in master captures. | `services/forge/graph/nodes/spatial_annotator.py` (branch `forge`) | **In progress** | Member B |
| `gemini-3.1-flash-image` | Step illustration and visual guidance card synthesis from technical manual text and step definitions. | `services/forge/graph/nodes/illustrator.py` (branch `forge`) | **In progress** | Member B |
| `veo-3.1-fast-generate-preview` | Counterfactual mistake simulation video generation (budget-guarded: max 3 per skill). | `services/forge/graph/nodes/mistake_simulator.py` (branch `forge`) | **In progress** | Member B |
| `gemini-3.8-flash-tts` | Multilingual speech audio synthesis for generated step guidance. | `services/forge/config.py` | **Planned** | Member B |
| `gemini-embedding-2-preview` | Semantic embedding of technical manuals and assembly documentation for grounding retrieval. | `services/api/config.py`, `services/forge/config.py` | **Planned** | Both |

---

## 2. Google Cloud Infrastructure & Platform Services

| Service | Responsibility in TAKUMI | Configuration / Deployment | Production Status | Owner |
| :--- | :--- | :--- | :--- | :--- |
| **Cloud Run (`takumi-api`)** | Stateless container running FastAPI Python 3.12 backend (auth verification, live tokens, watcher proxy, BigQuery ingestion, rate limiting). | Region: `asia-southeast1`<br>URL: `https://takumi-api-692366725458.asia-southeast1.run.app` | **Live** | Member A |
| **Cloud Run (`takumi-forge`)** | Google ADK 2.0 graph workflow container for processing master capture videos. | Region: `asia-southeast1`<br>URL: `https://takumi-forge-692366725458.asia-southeast1.run.app` | **In progress** | Member B |
| **Firebase Hosting** | Global CDN hosting for React 19 + TypeScript + Vite Progressive Web Application with security headers and API rewrites. | Project: `takumi-cup-2026`<br>URL: `https://takumi-cup-2026.web.app` | **Live** | Member A |
| **Firebase Authentication** | Identity management supporting Google Sign-In and email authentication with custom role claims (`role: trainee \| master \| supervisor`). | Project: `takumi-cup-2026` | **Live** | Member A |
| **Cloud Firestore (Native)** | Document database storing sessions, real-time session events, skills, review requests, and skill passports with role-based security rules. | Database: `(default)`, Region: `asia-southeast1` | **Live** | Both |
| **Cloud Storage** | Object storage bucket for workbench video frames, badge media, master capture assets, product reference units, and candidate inspection images with strict access rules. | Bucket: `takumi-cup-2026.firebasestorage.app` | **Live** | Both |
| **BigQuery** | Analytics data warehouse holding partitioned tables `takumi.session_events`, `takumi.api_calls`, and `takumi.inspection_events` for latency metrics, supervisor insights, and inspection telemetry. | Dataset: `takumi`, Region: `asia-southeast1` | **Live** | Member A |
| **Secret Manager** | Centralized credential vault holding `GEMINI_API_KEY` and Firebase configurations; keys never exposed to browsers. | Project: `takumi-cup-2026` | **Live** | Member A |
| **Model Armor** | Security screening engine filtering prompt injection, jailbreaks, and toxicity on user inputs before model ingestion. | Template in `asia-southeast1` | **Live** | Member A |
| **Cloud Monitoring & Logging** | Structured JSON logging with trace context, log-based metrics for availability, and automated alert policies. | Project: `takumi-cup-2026` | **Live** | Member A |
| **Cloud Build** | Automated CI/CD running linting, Python pytest, web Vitest, emulator security rules tests, container builds, and deployment. | Region: `asia-southeast1` | **Live** | Both |

---

## 3. Factory Governance & Access Control

- **End-of-Line Quality Inspection Decisions**: Inspection verification and override decisions ([`POST /api/inspections/{id}/decision`](file:///c:/takumi/services/api/main.py)) stay strictly **supervisor-only** (`role: supervisor`). The worker/trainee who captured or submitted the inspection photo cannot approve or override their own flagged unit.
- **Unit & Inspection Read Access**: Inspection reports and unit tracking records are restricted to the supervisor or the creating trainee/operator (`inspector_uid` / `created_by`); other trainees receive `403 Forbidden`.

