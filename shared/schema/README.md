# TAKUMI Shared Schemas & Contracts

This directory contains the canonical JSON Schemas (draft 2020-12), generated TypeScript interfaces, Pydantic v2 models, and BigQuery table definitions for all data exchanged across TAKUMI.

## Contracts Overview

- **`captures.json`** (`captures/{captureId}`): Master craftsman raw recordings, transcripts, and metadata.
- **`skills.json`** (`skills/{skillId}`): Structured, verified, multi-step skills taught live to workers.
- **`forge_jobs.json`** (`forge_jobs/{jobId}`): Pipeline execution jobs transforming captures into skills.
- **`forge_job_events.json`** (`forge_jobs/{jobId}/events/{eventId}`): Real-time observability events from Forge agents.
- **`review_requests.json`** (`review_requests/{id}`): Quality review items proposed by the insight agent for master approval.
- **`sessions.json`** (`sessions/{sessionId}`): Live coaching sessions tracking trainee progress step by step.
- **`session_events.json`** (`sessions/{sessionId}/events/{eventId}`): Real-time telemetry events emitted during live coaching.
- **`bigquery/session_events.json`**: BigQuery schema for streaming session event analytics into `takumi.session_events`.

## Timestamp Representation

All timestamps are stored as ISO-8601 UTC strings (e.g. `2026-10-05T09:30:00Z`), in Firestore and in JSON.

## Shared HTTP APIs

These endpoints define the inter-service HTTP contract between Member A (API & Coach) and Member B (Forge pipeline).

### 1. `POST /api/live-token`
- **Owner**: Member A
- **Description**: Issues a single-use Gemini Live token locked to `gemini-3.8-live` with audio output.
- **Auth**: Firebase ID token (`Authorization: Bearer <idToken>`)
- **Request Body**:
  ```json
  {
    "purpose": "interview" | "coach"
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
- **Owner**: Member B
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
- **Owner**: Member B
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
