# TAKUMI — GCP, Firebase & CI/CD Setup Guide

This document records the infrastructure architecture, configuration procedures, security rules, and CI/CD pipelines provisioned for TAKUMI.

## 1. Project & Services Overview

- **Project ID**: `takumi-cup-2026`
- **Default Region**: `asia-southeast1` (Singapore)
- **Enabled APIs**:
  - `run.googleapis.com` (Cloud Run services `takumi-api` and `takumi-forge`)
  - `cloudbuild.googleapis.com` (Branch-based CI/CD triggers)
  - `artifactregistry.googleapis.com` (Docker container registry repository `takumi`)
  - `secretmanager.googleapis.com` (`GEMINI_API_KEY` and `FIREBASE_WEB_CONFIG`)
  - `firestore.googleapis.com` (Firestore Native database `(default)`)
  - `storage.googleapis.com` & `firebasestorage.googleapis.com` (Bucket `takumi-cup-2026.firebasestorage.app`)
  - `bigquery.googleapis.com` (Dataset `takumi` and table `session_events`)
  - `generativelanguage.googleapis.com`, `aiplatform.googleapis.com`, `modelarmor.googleapis.com`
  - `cloudtrace.googleapis.com`, `logging.googleapis.com`
  - `firebase.googleapis.com`, `firebasehosting.googleapis.com`, `identitytoolkit.googleapis.com`
  - `billingbudgets.googleapis.com`, `cloudscheduler.googleapis.com`

---

## 2. Secrets & Configuration

### Managing `GEMINI_API_KEY`
The secret container `GEMINI_API_KEY` is hosted in Secret Manager with automatic replication.
To add or rotate the API key value from your local workstation:
```powershell
"YOUR_API_KEY" | gcloud secrets versions add GEMINI_API_KEY --data-file=- --project=takumi-cup-2026
```
Cloud Run mounts `GEMINI_API_KEY` directly as an environment variable via Secret Manager integration. The key is never exposed to the client browser.

### Client Configuration (`FIREBASE_WEB_CONFIG`)
The Firebase Web SDK credentials are stored in Secret Manager as `FIREBASE_WEB_CONFIG`.
During CI builds, Cloud Build retrieves this secret and populates `apps/web/.env.production` before running `vite build`. Locally, development uses `apps/web/.env.local` (which is git-ignored).

---

## 3. Service Accounts & Least Privilege

Three specialized service accounts are configured:

1. **`takumi-api@takumi-cup-2026.iam.gserviceaccount.com`** (Runtime for `takumi-api`):
   - `roles/datastore.user` (Firestore data read/write)
   - `roles/storage.objectAdmin` on `gs://takumi-cup-2026.firebasestorage.app` only
   - `roles/bigquery.dataEditor` on dataset `takumi` only
   - `roles/bigquery.jobUser` (Project level)
   - `roles/secretmanager.secretAccessor` on secret `GEMINI_API_KEY` only
   - `roles/firebaseauth.admin` (Token verification and custom claim setting)
   - `roles/cloudtrace.agent`, `roles/logging.logWriter`, `roles/modelarmor.user`
   - `roles/iam.serviceAccountTokenCreator` on itself (for signing Cloud Storage playback URLs)

2. **`takumi-forge@takumi-cup-2026.iam.gserviceaccount.com`** (Runtime for `takumi-forge`):
   - Identical least-privilege permissions as `takumi-api` minus `firebaseauth.admin`.

3. **`takumi-build@takumi-cup-2026.iam.gserviceaccount.com`** (Cloud Build executor):
   - `roles/run.admin`
   - `roles/artifactregistry.writer`
   - `roles/firebasehosting.admin`
   - `roles/firebaserules.admin`
   - `roles/logging.logWriter`
   - `roles/iam.serviceAccountUser` on `takumi-api` and `takumi-forge` only
   - `roles/secretmanager.secretAccessor` on `FIREBASE_WEB_CONFIG` only

---

## 4. Security Rules & Rule Testing

### Firestore Rules (`firestore.rules`)
- **Trainees**: Read only published skills (`status == "published"`); read only their own sessions and telemetry events (`resource.data.trainee_uid == request.auth.uid`). All client writes to sessions and passports are blocked (written strictly by `takumi-api` via Admin SDK).
- **Masters**: Create and update their own capture records (`request.auth.uid == master_uid`); update skills associated with captures they own; update review request status (`applied` | `dismissed`).
- **Supervisors**: Read all collections; write review requests.
- **Passports**: Public individual retrieval (`allow get: if true;`); listing is blocked (`allow list: if false;`).

### Storage Rules (`storage.rules`)
- `captures/{id}/**`: Write access restricted to the master who owns `captures/{id}` (verified via `firestore.get`).
- `skills/**`: Read access for authenticated users; writes restricted to server.
- `manuals/**`: Writable by masters; readable by signed-in users.
- `evals/**`: Readable by signed-in users; writable by supervisors.

### Running Rule Unit Tests
Unit tests reside in `/infra/rules-tests` and execute against the local Firebase emulator suite:
```bash
firebase emulators:exec --only firestore,storage --project takumi-rules-test "npm --prefix infra/rules-tests test"
```

---

## 5. CI/CD Triggers (Cloud Build)

Cloud Build uses 2nd-generation GitHub repository integration (`DivineTechie/takumi`):

1. **`takumi-coach`** (Trigger on push to `coach`):
   - Configuration: `/infra/cloudbuild-coach.yaml`
   - Runs Python unit tests and Web Vitest / ESLint checks.
   - Builds and pushes `takumi-api` Docker container to Artifact Registry.
   - Deploys `takumi-api` to Cloud Run (`asia-southeast1`).
   - Deploys updated `firestore.rules` and `storage.rules`.
   - Injects `FIREBASE_WEB_CONFIG`, builds `apps/web`, and releases to Firebase Hosting live channel (`takumi-cup-2026.web.app`).

2. **`takumi-forge`** (Trigger on push to `forge`):
   - Configuration: `/infra/cloudbuild-forge.yaml`
   - If `/services/forge/Dockerfile` is present: builds, pushes, and deploys `takumi-forge` to Cloud Run (`--no-cpu-throttling`, timeout 900s).
   - Injects `FIREBASE_WEB_CONFIG`, builds `apps/web`, and deploys to Firebase Hosting preview channel `"forge"` with a 30-day expiration.

---

## 6. BigQuery Telemetry Dataset

- **Dataset**: `takumi` (`asia-southeast1`)
- **Table**: `session_events`
- **Partitioning**: Daily partitioning on `ts` (`DATE(ts)`)
- **Clustering**: `skill_id`, `type`
- Schema matches `/shared/schema/bigquery/session_events.json`.

---

## 7. Budget & Cost Governance

- Budget created under billing account with currency threshold rules:
  - 50% spend alert
  - 100% spend alert
- Filtered to project `takumi-cup-2026`.
