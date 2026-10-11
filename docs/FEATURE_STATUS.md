# TAKUMI — Google Models and Cloud Services Feature Status

This inventory records the deployment status and ownership for all Google AI models and Google Cloud services across the TAKUMI codebase as of October 2026.

## Status Definitions
- **Live**: Implemented, tested, deployed, and serving traffic in production on `https://takumi-cup-2026.web.app` and Cloud Run.
- **In Progress (Member B)**: Implemented in code on branch `forge` or deployed in staging; pipeline integration active.
- **In progress**: Built and tested (unit tests, local browser checks) but not yet proven end to end on the deployed site or scored by an evaluation.
- **Planned**: Defined in architectural specifications and configuration files; planned for future milestones.

---

## 1. Google AI Models (`google-genai` SDK)

| Model ID | Responsibility / Job in TAKUMI | Source Code Call Site | Production Status | Owner |
| :--- | :--- | :--- | :--- | :--- |
| `gemini-3.8-live` | Real-time bidirectional voice coaching with low-latency interruption support. Streams 16 kHz PCM audio in, 24 kHz PCM audio out. | [`apps/web/src/lib/live/client.ts`](file:///c:/takumi/apps/web/src/lib/live/client.ts), [`services/api/gemini.py`](file:///c:/takumi/services/api/gemini.py) | **Live** | Member A |
| `gemini-3.5-flash-lite` | High-frequency (1 FPS) visual step watcher detecting task progression, common mistakes, and safety rule hazards; deep health pings; initial screening stage in dual-stage End-of-Line Quality Inspection (comparing candidate unit against 3 golden references). | [`services/api/gemini.py`](file:///c:/takumi/services/api/gemini.py) (`call_watch`, `check_deep_health`), [`services/api/inspection.py`](file:///c:/takumi/services/api/inspection.py) (`run_screen`) | **Live** | Member A |
| `gemini-3.8-flash` | Strict objective step verification against visible success criteria and safety rules; supervisor insight aggregation; second confirmation stage in End-of-Line Quality Inspection validating flaws with full defect taxonomy context. | [`services/api/gemini.py`](file:///c:/takumi/services/api/gemini.py) (`call_verify`), [`services/api/inspection.py`](file:///c:/takumi/services/api/inspection.py) (`run_confirm`), [`services/api/main.py`](file:///c:/takumi/services/api/main.py) | **Live** | Member A |
| `gemini-robotics-er-2-preview` | Spatial coordinate extraction and workbench reticle pointing (`[y, x]` normalized coordinates). | [`services/api/gemini.py`](file:///c:/takumi/services/api/gemini.py) (`call_point`) | **Live** | Member A |
| `gemini-robotics-er-2-preview` (Machine Watch setup) | Finds each machine's stack light, parts counter and HMI screen in one camera frame (boxes the supervisor can adjust). Called once per setup, never while watching. | [`services/api/machines.py`](services/api/machines.py) (`call_robotics_er_setup`) | **In progress** | Member A |
| `gemini-3.5-flash-lite` (Machine Watch reads) | Reads the light colour, counter value and alarm text from small region crops, only when the browser's edge check sees a stable change (plus a 5-minute heartbeat; max 6 reads per machine per minute). | [`services/api/machines.py`](services/api/machines.py) (`call_flash_lite_read`) | **In progress** | Member A |
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
| **Cloud Run (`takumi-api`)** | Stateless container running FastAPI Python 3.12 backend (auth verification, live tokens, watcher proxy, BigQuery ingestion, rate limiting, dual-stage inspection engine). | Region: `asia-southeast1`<br>URL: `https://takumi-api-692366725458.asia-southeast1.run.app` | **Live** | Member A |
| **Cloud Run (`takumi-forge`)** | Standard Work Studio pipeline as a Google ADK 2 Workflow graph (each step a FunctionNode calling Gemini; illustration and mistake clips in parallel), and the Google ADK quality trace-back agent. | Region: `asia-southeast1`<br>URL: `https://takumi-forge-692366725458.asia-southeast1.run.app` | **In progress** | Member B |
| **Firebase Hosting** | Global CDN hosting for React 19 + TypeScript + Vite Progressive Web Application with security headers and API rewrites. | Project: `takumi-cup-2026`<br>URL: `https://takumi-cup-2026.web.app` | **Live** | Member A |
| **Firebase Authentication** | Identity management supporting Google Sign-In and email authentication with custom role claims (`role: trainee \| master \| supervisor`). | Project: `takumi-cup-2026` | **Live** | Member A |
| **Cloud Firestore (Native)** | Document database storing sessions, real-time session events, skills, review requests, skill passports, product inspection profiles (`products`), inspection results (`inspections`), unit tracking (`units`), gallery items (`gallery`), Machine Watch machines, events and soak runs (`machines`, `machine_events`, `soak_runs`) with role-based security rules. | Database: `(default)`, Region: `asia-southeast1` | **Live** | Both |
| **Cloud Storage** | Object storage bucket for workbench video frames, badge media, master capture assets, product reference units (`products/{id}/ref_{1,2,3}.jpg`), uploaded candidate inspection images (`units/{product_id}/{unit_id}.jpg`), and VisA benchmark test images (`gallery/{category}/{file}`) with strict access rules. | Bucket: `takumi-cup-2026.firebasestorage.app` | **Live** | Both |
| **BigQuery** | Analytics data warehouse holding partitioned tables `takumi.session_events`, `takumi.api_calls`, `takumi.inspection_events` and `takumi.machine_events` for latency metrics, supervisor insights, inspection and machine telemetry. | Dataset: `takumi`, Region: `asia-southeast1` | **Live** | Member A |
| **Secret Manager** | Centralized credential vault holding `GEMINI_API_KEY` and Firebase configurations; keys never exposed to browsers. | Project: `takumi-cup-2026` | **Live** | Member A |
| **Model Armor** | Security screening engine filtering prompt injection, jailbreaks, and toxicity on user inputs before model ingestion. | Template in `asia-southeast1` | **Live** | Member A |
| **Cloud Monitoring & Logging** | Structured JSON logging with trace context, log-based metrics for availability, and automated alert policies. | Project: `takumi-cup-2026` | **Live** | Member A |
| **Cloud Build** | Automated CI/CD running linting, Python pytest, web Vitest, emulator security rules tests, container builds, and deployment. | Region: `asia-southeast1` | **Live** | Both |

---

## 3. Machine Watch (pillar 3): **In progress**

- Test bench `/machines/virtual` (HOME RIG): 1-3 simulated machines (stack light, counter, HMI) with a seeded fault schedule (realistic: a stop every 10-40 min lasting 1-8 min; fast: x10) and a run clock. Ground truth is logged with server timestamps.
- Watch page `/machines/watch`: one Gemini Robotics-ER call per setup, then the browser checks the regions every 500 ms and calls Gemini Flash-Lite only on a stable change. Only region crops (max 512 px) leave the device; the setup frame is never stored. A recorded video can replace the camera with `?debug=1` (labelled "Simulated input").
- Dashboard "Machines" tab: today's state timeline, availability, stops, downtime, top alarms, parts and availability x performance, labelled LIVE or HOME RIG.
- Scoring: `python -m evals.machine_watch.score_soak <run_id>` writes detection rate, delays, false alarms and cost per machine. No soak run has been scored yet, so no Machine Watch numbers are published.

## 4. Unit records and quality trace-back: **In progress**

- A serial entered on the coach start screen (Station Watch) links the session to the unit. When the session ends, the unit gets a station record: steps verified, steps not verified, and each mistake, block or safety stop with its evidence frame. Inspections with a serial are added to the same record.
- `/units/{serial}` shows the full history. Supervisors can put units on hold and release them (`POST /api/units/hold`, `POST /api/units/{id}/release`); holds keep the previous status.
- Trace-back agent (Google ADK, `services/forge/agents/traceback.py`, `POST /forge/agents/traceback`, supervisors only): an investigator agent with three read-only tools (unit history, similar units at the same station and step, the step's work instruction) and a reporter agent with a response schema. It proposes the likely station and step, units to hold and a work-instruction change. Hold candidates are checked against what the tools returned, and nothing changes until a supervisor approves. Operator identities are never given to the agent.
- In progress until it has run on real Station Watch sessions with serials.

## 5. Events pipeline and control tower: **In progress**

- Cloud Run (`takumi-api`) publishes every operational event (station steps, mistakes, safety stops and finished stations; inspections and supervisor decisions; machine state changes, alarms and counts; unit holds and releases) to Pub/Sub topic `takumi-events`. Publishing is fire-and-forget and never slows or fails a request.
- A Pub/Sub BigQuery subscription (`takumi-events-to-bigquery`) writes each message to `takumi.events` (partitioned by day, clustered by kind and source). Setup: `infra/events_pipeline.sh`.
- `/control` (supervisors): KPIs per source label (LIVE, HOME RIG, PUBLIC DATA never mixed): inspected, first-pass rate, confirmed defects, units on hold, stations finished, mistakes, safety stops, machine stops and alarms, plus a live feed. Reads `GET /api/control/summary` every 10 s.
- Windowed aggregation in Dataflow is planned; the control tower aggregates in BigQuery for now.

## 6. Demand agent: **In progress**

- Supervisors enter today's orders on the control tower (`POST /api/orders`: name, quantity, due time, machines). `GET /api/orders` projects each order from real Machine Watch counts and inspections (gallery inspections never count): parts made, recent rate, yield, projected good parts at the due time, shortfall and the rate needed. The projection is plain code (`shared/ops/demand.py`), shared by the API and the agent.
- "Will we make it?" runs a Google ADK agent (`services/forge/agents/demand.py`, `POST /forge/agents/demand`, supervisors only): a planner with two read-only tools (open orders with projections, a machine's stops and alarms) and a reporter with a response schema. It explains which orders are at risk, the constraint, and actions for a supervisor to decide. Numbers shown come from the tools, not the model. Each order carries the source label of its machines (LIVE or HOME RIG).

## 5. Factory Governance & Access Control

- **End-of-Line Quality Inspection Decisions**: Inspection verification and override decisions ([`POST /api/inspections/{id}/decision`](file:///c:/takumi/services/api/main.py)) stay strictly **supervisor-only** (`role: supervisor`). The worker/trainee who captured or submitted the inspection photo cannot approve or override their own flagged unit.
- **Unit & Inspection Read Access**: Inspection reports and unit tracking records are restricted to the supervisor or the creating trainee/operator (`inspector_uid` / `created_by`); other trainees receive `403 Forbidden`.
- **Benchmark Gallery Data Isolation**: VisA benchmark test items and raw images stored in Firestore (`gallery/{id}`) and Cloud Storage (`gallery/{category}/{file}`) are locked from direct browser access in `firestore.rules` and `storage.rules`. Access is strictly server-mediated via authenticated API endpoints (`GET /api/inspect/gallery`, `POST /api/inspect/gallery`) with signed URLs, preventing client-side ground truth inspection tampering.


