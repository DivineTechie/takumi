# TAKUMI: security and privacy

The security controls in TAKUMI: headers and Content Security Policy, Model Armor, limits on AI use, keys, dependency and secret scans, and the kill switch.

## Reporting a vulnerability

Please report security problems privately through GitHub (**Security** tab → **Report a vulnerability**), not in a public issue. Leave real secrets and personal data out of the report.

---

## 1. Security Headers & Content Security Policy (CSP)

Configured in `firebase.json` across all hosting routes:

```http
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(self), microphone=(self), geolocation=(), payment=(), usb=()
X-Frame-Options: DENY
Cross-Origin-Opener-Policy: same-origin-allow-popups
Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self' https://apis.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://storage.googleapis.com https://lh3.googleusercontent.com; media-src 'self' blob: https://storage.googleapis.com; connect-src 'self' https://firestore.googleapis.com https://firebasestorage.googleapis.com https://storage.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://accounts.google.com https://apis.google.com https://www.googleapis.com https://*.firebaseapp.com https://takumi-cup-2026.web.app/__/auth/ wss://generativelanguage.googleapis.com; frame-src 'self' https://accounts.google.com https://apis.google.com https://*.firebaseapp.com https://takumi-cup-2026.web.app/__/auth/; report-uri /api/csp-report;
```

The policy runs in report-only mode: browsers send violations to `/api/csp-report` and nothing is blocked yet.

### Directive & Origin Justifications

| Directive | Origin / Source | Justification |
| :--- | :--- | :--- |
| `default-src` | `'self'` | Enforces least-privilege fallback for unspecified asset types. |
| `script-src` | `'self'` | Application bundle scripts emitted by Vite build. |
| | `https://apis.google.com` | Required by Firebase Auth Google OAuth popup flow for cross-origin authentication scripts. |
| `style-src` | `'self'`, `'unsafe-inline'` | Tailwind CSS dynamic utility classes and theme token styles. |
| | `https://fonts.googleapis.com` | Google Fonts stylesheets (Noto Sans, Noto Sans JP, Noto Sans Devanagari, Material Symbols Outlined). |
| `font-src` | `'self'`, `https://fonts.gstatic.com` | Google Fonts web font binaries (`.woff2`). |
| `img-src` | `'self'`, `data:`, `blob:` | In-browser canvas snapshots and video frames. |
| | `https://storage.googleapis.com` | Short-lived signed URLs for evidence frames, inspection photos and reference images. |
| | `https://lh3.googleusercontent.com` | Google user profile avatars returned by Firebase Auth Google provider. |
| `media-src` | `'self'`, `blob:`, `https://storage.googleapis.com` | Web Audio API PCM streaming playback and captured video inspection media. |
| `connect-src` | `'self'` | TAKUMI backend API routes (`/api/*`). |
| | `https://firestore.googleapis.com` | Firestore SDK reads (published work instructions, live session state, machines). The rules let only the server write most collections. |
| | `https://firebasestorage.googleapis.com`, `https://storage.googleapis.com` | Cloud Storage upload and metadata verification. |
| | `https://identitytoolkit.googleapis.com`, `https://securetoken.googleapis.com` | Firebase Auth credential exchange and token refresh. |
| | `https://accounts.google.com`, `https://apis.google.com`, `https://www.googleapis.com` | Google identity endpoints and Google APIs token validation. |
| | `https://*.firebaseapp.com`, `https://takumi-cup-2026.web.app/__/auth/` | Firebase Auth helper handlers and redirect proxies. |
| | `wss://generativelanguage.googleapis.com` | Gemini Live WebSocket (single-use token) for Station Watch and Ask TAKUMI. |
| `frame-src` | `'self'`, `https://accounts.google.com`, `https://apis.google.com`, `https://*.firebaseapp.com`, `https://takumi-cup-2026.web.app/__/auth/` | Iframes opened by Google Sign-In and Firebase Auth. |
| `report-uri` | `/api/csp-report` | Endpoint in `takumi-api` that logs the directive and the blocked address, with no user data (120 reports per IP per minute). |

---

## 2. Google Cloud Model Armor Protection

Untrusted text from users (questions, pointing targets and work-order notes) is screened with Google Cloud Model Armor before it reaches a model or a record.

- **Location**: `asia-southeast1` (Singapore), the same region as Cloud Run, Firestore and BigQuery, so the text stays in one region and the check adds little latency.
- **Template ID**: `projects/takumi-cup-2026/locations/asia-southeast1/templates/takumi-user-text`
- **Filters**: prompt injection and jailbreak, plus the Responsible AI filters (hate speech, harassment, sexually explicit, dangerous), all at medium confidence and above. The malicious URL filter is off: trainee text is part names and assembly questions, not links.
- **When Model Armor cannot answer** (1.5 s timeout):
  - pointing targets (`point_target`) **fail open**, so live coaching keeps working. A target Model Armor flags is still blocked.
  - questions and work-order notes (`question`) **fail closed**: the text is refused if it cannot be screened.
- **Logs**: the event, the purpose and the matched categories only (for example `prompt_injection`, `rai_dangerous`). The user's text is **never logged**.

---

## 3. Dependency Security Audits

### Python services (`services/api`, `services/forge`)
Every Cloud Build run audits the dependencies; the audits report and do not block the deploy.

### Python services (`services/api`, `services/forge`)
- Tool: `pip-audit -r services/api/requirements.txt` and `pip-audit -r services/forge/requirements.txt`
- Status (Cloud Build, 2026-10-12): **no known vulnerabilities** in either.

### Web Frontend (`apps/web`)
- Tool: `npm audit --omit=dev --audit-level=high`
- **Findings (2026-10-13)**:
  - Two high-severity advisories in `@grpc/grpc-js` ([GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j), [GHSA-f596-whhp-79r4](https://github.com/advisories/GHSA-f596-whhp-79r4)). npm counts them as 4 findings because `firebase`, `@firebase/firestore` and `@firebase/firestore-compat` depend on it.
  - **Why this is accepted**: `@grpc/grpc-js` is the Node.js gRPC transport. In the browser the Firebase Web SDK uses WebChannel and `fetch`, and the production bundle contains no `@grpc/grpc-js` code (checked in `apps/web/dist`). Both advisories concern gRPC servers, and TAKUMI runs none in Node.js.

### Repository secrets scan
- Tool: `gitleaks git --log-opts="--all"` across every commit on every branch.
- Result (2026-10-13, 125 commits): **no leaks**. Two dummy Firebase test values in `apps/web/vite.config.ts` are allow-listed in `.gitleaksignore`.
- The Firebase web API key is public by design: it ships in every Firebase web app. It only works from `takumi-cup-2026.web.app`, `takumi-cup-2026.firebaseapp.com` and localhost, and only for the Firebase set of APIs. The Gemini key lives in Secret Manager and never reaches a browser.

---

## 4. Production Kill Switch & Privacy Telemetry

1. **Kill Switch (`SESSIONS_ENABLED`)**:
   - Cloud Run environment variable `SESSIONS_ENABLED=true|false`.
   - When false, `POST /api/sessions` and the Station Watch live token (`POST /api/live-token`, purpose `coach`) return HTTP 503, which pauses Station Watch. Inspection, records and dashboards keep working.
2. **Public status (`/api/status` and the `/status` page)**:
   - API health, a real (cached) Gemini check, whether sessions are on, and for the last 7 days the session count and p50/p90 latencies from BigQuery.
   - Numbers only: no names, email addresses or account identifiers.
   - Cached for 60 s and limited to 60 requests per IP per minute.

---

## 5. Limits on AI use

TAKUMI is public and any verified account can sign in as a trainee, so every model call is metered:

| Limit | In production | Where |
| :--- | :--- | :--- |
| AI calls per user per day (checks, inspections, pointing, reads) | 3,000 | `LIMIT_CHECKS_PER_DAY`, Firestore counter per user and day |
| Gemini Live sessions per user per day | 30 | `LIMIT_LIVE_TOKENS_PER_DAY` (set in `infra/cloudbuild.yaml`) |
| AI calls per API instance per day, across all users (at most 3 instances) | 20,000 | `LIMIT_INSTANCE_CALLS_PER_DAY` |
| Machine Watch reads per machine per minute | 6 | `LIMIT_MACHINE_READS_PER_MIN` |
| Standard Work Studio runs per master per day | 10 | `STUDIO_RUNS_PER_DAY`, `services/forge/config.py` |
| Requests per IP per minute on public endpoints (status, deep health) | 60 | `services/api/public_rate_limit.py` |

Agents and Studio steps call Gemini with timeouts, so a slow model fails clearly instead of hanging; agent requests end before the 60 s Firebase Hosting limit.

