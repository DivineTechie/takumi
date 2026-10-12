# TAKUMI shared schemas and contracts

This directory contains the canonical JSON Schemas (draft 2020-12), generated TypeScript interfaces, Pydantic v2 models, and BigQuery table definitions for all data exchanged across TAKUMI.

## Contracts overview

| Schema | Firestore path | What it holds |
| :--- | :--- | :--- |
| `captures.json` | `captures/{captureId}` | a master's recording for the Standard Work Studio: video, narration transcript, metadata |
| `skills.json` | `skills/{skillId}` | a work instruction: steps with visible success criteria, reasons, pointing hints, translations, status |
| `forge_jobs.json` | `forge_jobs/{jobId}` | one Studio run that turns a capture into an instruction for review |
| `forge_job_events.json` | `forge_jobs/{jobId}/events/{eventId}` | progress events written by each Studio step |
| `review_requests.json` | `review_requests/{id}` | a suggested instruction change sent by a supervisor (from trace-back) to the master |
| `sessions.json` | `sessions/{sessionId}` | a Station Watch session at a station, optionally on a unit serial |
| `session_events.json` | `sessions/{sessionId}/events/{eventId}` | step, mistake and safety events of a session |
| `products.json` | `products/{productId}` | an inspected product with its known-good reference photos |
| `inspections.json` | `inspections/{id}` | one end-of-line inspection: verdict, stages, the person's decision |
| `units.json` | `units/{serial}` | a unit record: station records, inspections, hold status |
| `machines.json` | `machines/{machineId}` | a watched machine and its light, counter and screen regions |
| `machine_events.json` | `machine_events/{eventId}` | state changes, alarms and counts read by Machine Watch |
| `soak_runs.json` | `soak_runs/{runId}` | a test bench run and its ground truth, used to score Machine Watch |
| `bigquery/*.json` | BigQuery dataset `takumi` | analytics tables: `events`, `session_events`, `inspection_events`, `machine_events` |

Regenerate the TypeScript (`ts/`) and Pydantic (`py/`) models after any change with `npm run schema` from the repository root, and update both services in the same commit.

## Timestamp Representation

All timestamps are stored as ISO-8601 UTC strings (e.g. `2026-10-05T09:30:00Z`), in Firestore and in JSON.

## Shared HTTP APIs

These endpoints define the inter-service HTTP contract between the API service and the Forge service.

### 1. `POST /api/live-token`
- **Owner**: API service
- **Description**: Issues a single-use Gemini Live token locked to `gemini-3.8-live` with audio output.
- **Auth**: Firebase ID token (`Authorization: Bearer <idToken>`)
- **Request Body**:
  ```json
  {
    "purpose": "interview" | "coach" | "copilot"
  }
  ```
- **Response** (200 OK):
  ```json
  {
    "token": "string",
    "model": "gemini-3.8-live",
    "max_minutes": 15
  }
  ```

### 2. `POST /forge/jobs`
- **Owner**: Forge service
- **Description**: Triggers asynchronous Forge pipeline execution for a capture.
- **Auth**: Firebase ID token (`Authorization: Bearer <idToken>`)
- **Request Body**:
  ```json
  {
    "capture_id": "cap_20261006_ab12"
  }
  ```
- **Response** (202 Accepted):
  ```json
  {
    "job_id": "job_...",
    "skill_id": "skill_..."
  }
  ```

### 3. `GET /forge/jobs/{job_id}`
- **Owner**: Forge service
- **Description**: Fetches current status of a Forge pipeline job. (UIs stream Firestore events instead).
- **Auth**: Firebase ID token (`Authorization: Bearer <idToken>`)
- **Response** (200 OK):
  ```json
  {
    "capture_id": "cap_20261006_ab12",
    "skill_id": "skill_...",
    "status": "queued" | "running" | "done" | "failed",
    "started_at": "2026-10-06T10:00:00Z",
    "finished_at": null
  }
  ```

### 4. Authentication & Custom Claims
Every API request carries a Firebase ID token in the `Authorization: Bearer` header. Roles live in the Firebase custom claim `role`:
- `master`
- `trainee`
- `supervisor`

## Code Generation

Regenerate both TypeScript types (`shared/schema/ts`) and Pydantic v2 models (`shared/schema/py`) using:
```bash
npm run schema
```
Or via Makefile:
```bash
make schema
```
