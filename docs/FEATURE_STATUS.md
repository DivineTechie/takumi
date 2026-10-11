# TAKUMI — feature status

What is deployed on [takumi-cup-2026.web.app](https://takumi-cup-2026.web.app) today, which Google model or service does the work, and how it has been checked. Every number shown in the app is labelled **LIVE** (our deployment), **HOME RIG** (our test bench filmed by a real camera) or **PUBLIC DATA** (dataset + licence).

**Status:** **Live** = deployed and working in production. **Evaluated** = also measured, with results on [/evals](https://takumi-cup-2026.web.app/evals). **Live, awaiting real data** = deployed and tested, not yet exercised on a full real scenario.

## Features

| Feature | What it does | Google AI / Cloud | Code | Status |
| :--- | :--- | :--- | :--- | :--- |
| End-of-line inspection | Photo of each finished unit, screened against 3 known-good references; suspected defects confirmed by a stronger model; a supervisor confirms or overrides every flag. Supervisors add products from 3 photos. | `gemini-3.5-flash-lite` (screen), `gemini-3.8-flash` (confirm) | [services/api/main.py](../services/api/main.py), [InspectScreen.tsx](../apps/web/src/pages/InspectScreen.tsx) | **Evaluated** (PUBLIC DATA: VisA, 2,162 images) |
| VisA gallery | Judges inspect real VisA test parts; the ground truth is revealed after the verdict. | same as above | [GalleryScreen.tsx](../apps/web/src/pages/GalleryScreen.tsx) | **Live** |
| Machine Watch | A phone reads stack lights, counters and alarm screens: one setup call finds the regions, the browser checks them every 500 ms for free, Gemini reads only on change (plus a counter read every 2 min and a check-in every 10 min). Stop banner, beep and vibration on the phone. | `gemini-robotics-er-2-preview` (setup), `gemini-3.5-flash-lite` (reads) | [services/api/machines.py](../services/api/machines.py), [MachineWatchScreen.tsx](../apps/web/src/pages/MachineWatchScreen.tsx) | **Evaluated** (HOME RIG soak runs) |
| Test bench | 1–3 simulated machines with a seeded fault schedule and ground truth for scoring; a detection stopwatch shows how long TAKUMI took to see each change. | — | [VirtualMachineScreen.tsx](../apps/web/src/pages/VirtualMachineScreen.tsx), [evals/machine_watch](../evals/machine_watch) | **Live** |
| Maintenance agent | When a machine stops, drafts a work order: likely causes with evidence, steps, safety, parts, time. Supervisor approves or dismisses. The floor alert is spoken in 6 languages. | Google ADK agents on `gemini-3.8-flash` + `gemini-3.5-flash-lite`, `gemini-3.8-flash-tts` | [services/forge/agents/maintenance.py](../services/forge/agents/maintenance.py), [services/api/work_orders.py](../services/api/work_orders.py) | **Evaluated** (TEST FIXTURES: 12/12 scripted stops) |
| Ask TAKUMI (voice copilot) | Supervisors ask by voice in any language; Gemini Live answers by voice using tools over TAKUMI's own data (machines, orders, quality, work orders, the planner and maintenance agents). It cannot approve anything. | `gemini-3.8-live` (single-use tokens), function calling | [apps/web/src/lib/live/copilot.ts](../apps/web/src/lib/live/copilot.ts) | **Live** |
| Station Watch | Follows each step of a work instruction at a manual station, speaks in the operator's language, points at the fix, verifies steps on visible facts only, full-screen STOP on a hazard. | `gemini-3.8-live`, `gemini-3.5-flash-lite` (step watcher), `gemini-3.8-flash` (verifier), `gemini-robotics-er-2-preview` (pointing), Model Armor | [CoachLiveView.tsx](../apps/web/src/pages/CoachLiveView.tsx), [services/api/main.py](../services/api/main.py) | **Live** (latencies in BigQuery `takumi.api_calls`) |
| Unit records | A serial links a unit's station records (with evidence frames) and inspections; supervisors hold and release units. | Firestore, Cloud Storage | [services/api/units.py](../services/api/units.py), [UnitScreen.tsx](../apps/web/src/pages/UnitScreen.tsx) | **Live** |
| Quality trace-back | From a failed unit, finds the station and step where the defect started, other units through the same step, and an instruction fix; drawn as an animated graph. Holds and fixes need approval. | Google ADK agents on `gemini-3.8-flash` | [services/forge/agents/traceback.py](../services/forge/agents/traceback.py) | **Evaluated** on TEST FIXTURES (4/4); awaiting real factory data |
| Demand planner | Orders projected in plain code from real machine counts and inspection yield; an agent explains the risk and proposes actions. | Google ADK agents on `gemini-3.8-flash` | [shared/ops/demand.py](../shared/ops/demand.py), [services/forge/agents/demand.py](../services/forge/agents/demand.py) | **Live** |
| Standard Work Studio | A master demonstrates a task once; a workflow turns the video into steps with success criteria, reasons, pointing hints and translations; review requests from trace-back are applied per step. | Google ADK 2 Workflow graph, `gemini-omni-1.1-flash`, `gemini-3.8-flash`, `gemini-robotics-er-2-preview` | [services/forge/graph/workflow.py](../services/forge/graph/workflow.py) | **Live** |
| Events pipeline and control tower | Every station step, inspection, machine event, hold and work-order decision goes to Pub/Sub; a BigQuery subscription stores it; the control tower shows totals per source label and a live feed. | Pub/Sub, BigQuery | [services/api/events_bus.py](../services/api/events_bus.py), [ControlTowerScreen.tsx](../apps/web/src/pages/ControlTowerScreen.tsx) | **Live** |
| Supervisor dashboard | End-of-line quality, machines (timeline, availability, stops), step quality per instruction step, station replay. No per-worker scoring. | Firestore, BigQuery | [DashboardScreen.tsx](../apps/web/src/pages/DashboardScreen.tsx) | **Live** |
| Six languages | Every screen in English, Japanese, Vietnamese, Hindi, Bahasa Indonesia and Filipino. Translations are machine-made with Gemini and marked for native review. | `gemini-3.8-flash` (offline, [infra/translate_i18n.py](../infra/translate_i18n.py)) | [apps/web/src/i18n](../apps/web/src/i18n) | **Live** |
| Evaluations page | Public results with method, caveats and cost per part or machine. | — | [EvalsScreen.tsx](../apps/web/src/pages/EvalsScreen.tsx) | **Live** |

## Platform

| Service | Use | Status |
| :--- | :--- | :--- |
| Cloud Run `takumi-api` | FastAPI: auth, Live tokens, inspection, Machine Watch reads, units, orders, work orders, events | **Live** |
| Cloud Run `takumi-forge` | Google ADK agents (maintenance, trace-back, demand) and the Studio workflow | **Live** |
| Firebase Hosting + Auth | Web app; Google sign-in, email link, judge test accounts; roles in a custom claim | **Live** |
| Firestore, Cloud Storage | Records, evidence frames, reference photos, cached spoken alerts; access enforced by rules (tested in CI) | **Live** |
| Pub/Sub → BigQuery | `takumi-events` topic, BigQuery subscription to `takumi.events`; plus `api_calls`, `session_events`, `inspection_events`, `machine_events` | **Live** |
| Secret Manager | The Gemini API key; the browser never sees a key | **Live** |
| Model Armor | Screens user-supplied text (questions, pointing targets, work-order notes) | **Live** |
| Cloud Monitoring, Cloud Build | Alerts on Gemini unavailability and server errors; CI runs every test suite and deploys on each push | **Live** |

## Not built (yet)

- Windowed aggregation in Dataflow (the control tower aggregates in BigQuery).
- Gemma on-device for the edge loop (today the edge check is plain colour and pixel change).
- Real factory footage evaluation for Machine Watch (the soak runs use the test bench filmed by a real phone).
