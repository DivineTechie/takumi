# Deploying TAKUMI on your own Google Cloud project

TAKUMI runs entirely on Google Cloud and Firebase in one region (we use `asia-southeast1`). This guide sets up a copy from scratch. For running locally against the live deployment, see [Running locally](../README.md#running-locally).

## 1. Project and APIs

Create a Google Cloud project, link it to Firebase, and enable:

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com firestore.googleapis.com storage.googleapis.com bigquery.googleapis.com \
  pubsub.googleapis.com modelarmor.googleapis.com logging.googleapis.com monitoring.googleapis.com \
  cloudtrace.googleapis.com identitytoolkit.googleapis.com firebasehosting.googleapis.com \
  --project=YOUR_PROJECT
```

Then, in the Firebase console: Firestore in Native mode, one Cloud Storage bucket, Authentication with Google and email/password (or email link) sign-in, and a web app (its config is used by the build).

## 2. Secrets

| Secret | Contents | Used by |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | a Gemini API key | both Cloud Run services (mounted as an environment variable) |
| `FIREBASE_WEB_CONFIG` | the six `VITE_FIREBASE_*` lines for the web app (see `apps/web/.env.example`) | Cloud Build, written to `apps/web/.env.production` before `vite build` |

```bash
printf '%s' "$GEMINI_API_KEY" | gcloud secrets create GEMINI_API_KEY --data-file=- --project=YOUR_PROJECT
gcloud secrets create FIREBASE_WEB_CONFIG --data-file=firebase-web-config.env --project=YOUR_PROJECT
```

The browser never receives the Gemini key: Gemini Live sessions use single-use tokens issued by `POST /api/live-token`.

## 3. Service accounts (least privilege)

| Account | Roles |
| :--- | :--- |
| `takumi-api` (runtime) | Firestore user; Storage object admin on the app bucket; BigQuery data editor on dataset `takumi` and job user; Pub/Sub publisher on `takumi-events`; secret accessor on `GEMINI_API_KEY`; Firebase Auth admin (role claims); Model Armor user; log writer, trace agent; token creator on itself (signed URLs) |
| `takumi-forge` (runtime) | the same as `takumi-api` without Firebase Auth admin |
| `takumi-build` (Cloud Build) | Cloud Run admin, Artifact Registry writer, Firebase Hosting admin, Firebase Rules admin, log writer, service account user on the two runtime accounts, secret accessor on `FIREBASE_WEB_CONFIG` |

## 4. Data

- **Events pipeline:** [`infra/events_pipeline.sh`](../infra/events_pipeline.sh) creates the Pub/Sub topic `takumi-events`, the BigQuery table `takumi.events` (partitioned by day) and a BigQuery subscription, which never expires, that writes every event into it.
- **Analytics tables:** create `session_events`, `inspection_events` and `machine_events` in dataset `takumi` from the schemas in [`shared/schema/bigquery`](../shared/schema/bigquery) (`bq mk --table --time_partitioning_field=ts ...`), and `api_calls` with the columns written by [`services/api/bigquery_client.py`](../services/api/bigquery_client.py).
- **Seed data:** [`infra/load_seed.py`](../infra/load_seed.py) loads the sample work instructions; [`infra/load_visa_gallery.py`](../infra/load_visa_gallery.py) and [`infra/load_visa_products.py`](../infra/load_visa_products.py) load the judges' gallery and reference products from a local copy of the VisA dataset (`VISA_DATA_DIR`).
- **Roles:** [`infra/set_role.py`](../infra/set_role.py) `<uid-or-email> <trainee|supervisor|master>` sets a user's role claim. New verified accounts get `trainee` automatically.

## 5. Security rules

[`firestore.rules`](../firestore.rules) and [`storage.rules`](../storage.rules) enforce the roles: trainees read published instructions and their own sessions; masters write their own captures and update their own instructions and the review requests sent to them; supervisors read everything and manage products. Records written by the services (sessions, units, inspections, machines and their events, orders, work orders, Studio jobs) have no client write access; anything not listed is denied. Tests run in the Firebase emulator from [`infra/rules-tests`](../infra/rules-tests).

## 6. CI/CD

Create a Cloud Build trigger on the GitHub repository for pushes to `main` with [`infra/cloudbuild.yaml`](../infra/cloudbuild.yaml). Each build runs the API, Forge, web and rules tests in parallel, builds both containers, deploys `takumi-api` and `takumi-forge` to Cloud Run, deploys the rules and indexes, and releases the web app to Firebase Hosting (which rewrites `/api/**` and `/forge/**` to the services; see [`firebase.json`](../firebase.json)).

Runtime settings are environment variables set by the build (a manual `gcloud run services update` lasts only until the next deploy):

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `SESSIONS_ENABLED` | `true` | kill switch: `false` pauses new Station Watch sessions; everything else keeps working |
| `LIMIT_CHECKS_PER_DAY` | `3000` | AI calls per user per day |
| `LIMIT_LIVE_TOKENS_PER_DAY` | `30` | Gemini Live sessions per user per day |
| `LIMIT_INSTANCE_CALLS_PER_DAY` | `20000` | AI calls per API instance per day, across all users |
| `MODEL_FLASH`, `MODEL_FLASH_LITE`, `MODEL_LIVE`, `MODEL_ROBOTICS_ER`, `MODEL_TTS` | see `services/*/config.py` | swap a model without a code change |

## 7. Monitoring

- Uptime checks every 5 minutes on `/api/healthz` and `/forge/healthz`, and every 15 minutes on `/api/healthz/deep` (a real, cached Gemini call), each with an alert policy to an email channel.
- A log-based alert on Gemini unavailability and API 5xx responses.
- The public [/status](https://takumi-cup-2026.web.app/status) page shows API health, the Gemini check and 7-day latency percentiles.
- A billing budget with 50% and 100% alerts. If Gemini is billed through prepaid AI Studio credits, keep a balance (or turn on automatic reload) for the whole period the app must stay up.
