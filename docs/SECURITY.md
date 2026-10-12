# TAKUMI: security and privacy

The security controls in TAKUMI: headers and Content Security Policy, Model Armor, limits on AI use, keys, dependency and secret scans, and the kill switch.

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

### Directive & Origin Justifications

| Directive | Origin / Source | Justification |
| :--- | :--- | :--- |
| `default-src` | `'self'` | Enforces least-privilege fallback for unspecified asset types. |
| `script-src` | `'self'` | Application bundle scripts emitted by Vite build. |
| | `https://apis.google.com` | Required by Firebase Auth Google OAuth popup flow for cross-origin authentication scripts. |
| `style-src` | `'self'`, `'unsafe-inline'` | Tailwind CSS dynamic utility classes and theme token styles. |
| | `https://fonts.googleapis.com` | Google Fonts stylesheets (Inter, Material Symbols Outlined). |
| `font-src` | `'self'`, `https://fonts.gstatic.com` | Google Fonts web font binaries (`.woff2`). |
| `img-src` | `'self'`, `data:`, `blob:` | In-browser canvas snapshots and video frames. |
| | `https://storage.googleapis.com` | Short-lived signed URLs for evidence frames, inspection photos and reference images. |
| | `https://lh3.googleusercontent.com` | Google user profile avatars returned by Firebase Auth Google provider. |
| `media-src` | `'self'`, `blob:`, `https://storage.googleapis.com` | Web Audio API PCM streaming playback and captured video inspection media. |
| `connect-src` | `'self'` | TAKUMI backend API routes (`/api/*`). |
| | `https://firestore.googleapis.com` | Firestore SDK for published work instructions and live session state (read-only by rules). |
| | `https://firebasestorage.googleapis.com`, `https://storage.googleapis.com` | Cloud Storage upload and metadata verification. |
| | `https://identitytoolkit.googleapis.com`, `https://securetoken.googleapis.com` | Firebase Auth credential exchange and token refresh. |
| | `https://accounts.google.com`, `https://apis.google.com`, `https://www.googleapis.com` | Google identity endpoints and Google APIs token validation. |
| | `https://*.firebaseapp.com`, `https://takumi-cup-2026.web.app/__/auth/` | Firebase Auth helper handlers and redirect proxies. |
| | `wss://generativelanguage.googleapis.com` | Gemini Live WebSocket (single-use token) for Station Watch and Ask TAKUMI. |
| `frame-src` | `https://accounts.google.com`, `https://apis.google.com`, `https://*.firebaseapp.com` | Sandboxed iframes spawned by Google Sign-In and Firebase Auth. |
| `report-uri` | `/api/csp-report` | Telemetry endpoint in `takumi-api` logging structured warnings without PII. |

---

## 2. Google Cloud Model Armor Protection

Untrusted text from users (questions, pointing targets and work-order notes) is screened with Google Cloud Model Armor before it reaches a model or a record.

- **Resource Location**: `asia-southeast1` (Singapore)
  - **Regional Placement & Trade-Off**: To keep trainee text strictly in-region (colocated with Cloud Run, Firestore, and BigQuery) and minimize inter-region roundtrip latency, the template is provisioned in `asia-southeast1`. Because `asia-southeast1` currently supports Prompt Injection & Jailbreak (`pi_and_jailbreak`) and Responsible AI (`rai`) safety filters but does not support the Malicious URI filter, the Malicious URI filter is omitted. This trade-off is well-justified because manufacturing trainee inputs and pointing targets consist of technical physical object names and assembly questions rather than web links.
- **Template ID**: `projects/takumi-cup-2026/locations/asia-southeast1/templates/takumi-user-text`
- **Fail-Safe Behavior**:
  - `point_target`: **Fail-OPEN** with 1.5s timeout. If Model Armor is temporarily unreachable, spatial pointer continues so live hands-on assembly coaching is not disrupted.
  - `question`: **Fail-CLOSED** with 1.5s timeout. Free-form text queries are blocked if safety screening cannot be completed.
- **Privacy Assurance**: The screening function logs matched violation categories only (e.g. `pi_and_jailbreak`) and **never logs raw user text**.

---

## 3. Dependency Security Audits

### Python services (`services/api`, `services/forge`)
- Tool: `pip-audit -r services/api/requirements.txt` and `pip-audit -r services/forge/requirements.txt`
- Status (2026-10-12): **no known vulnerabilities** in either.

### Web Frontend (`apps/web`)
- Tool: `npm audit --omit=dev --audit-level=high`
- **Audit Findings**:
  - 4 high-severity advisories reported against `@grpc/grpc-js` (via `@firebase/firestore` -> `firebase`).
  - **Exemption Justification**: `@grpc/grpc-js` is a Node.js-only gRPC transport library. In the web browser environment, the Firebase Web SDK uses WebChannel and standard `fetch`/`XHR` transports; the `@grpc/grpc-js` code path is never bundled or executed in client browsers. CI audits are configured as non-blocking informative reports.

### Repository secrets scan
- Tool: `gitleaks git --log-opts="--all"` across every commit on every branch.
- Result (2026-10-12): **no leaks**. Two dummy Firebase test values in `apps/web/vite.config.ts` are allow-listed in `.gitleaksignore`.
- The Firebase web API key (public by design: it ships in every Firebase web app) only works from TAKUMI's own domains and localhost, and only for Firebase APIs. The Gemini key lives in Secret Manager and never reaches a browser.

---

## 4. Production Kill Switch & Privacy Telemetry

1. **Kill Switch (`SESSIONS_ENABLED`)**:
   - Cloud Run environment variable `SESSIONS_ENABLED=true|false`.
   - Immediately returns HTTP 503 on `POST /api/sessions` and `POST /api/live-token` (Station Watch) to pause live sessions; inspection, records and dashboards keep working.
2. **Public Health & Latency Telemetry (`/api/status` & `/status`)**:
   - Anonymous aggregate metrics calculated from BigQuery partitioned audit logs.
   - Strictly contains numeric latency percentiles (p50/p90) and session counts.
   - Zero personal names, email addresses, or account identifiers are exposed or stored in API metrics.

---

## 5. Limits on AI use

TAKUMI is public and any verified account can sign in as a trainee, so every model call is metered:

| Limit | Default | Where |
| :--- | :--- | :--- |
| AI calls per user per day (checks, inspections, pointing, reads) | 3,000 | `LIMIT_CHECKS_PER_DAY`, Firestore counter per user and day |
| Gemini Live sessions per user per day | 30 | `LIMIT_LIVE_TOKENS_PER_DAY` |
| AI calls per API instance per day, across all users (at most 3 instances) | 20,000 | `LIMIT_INSTANCE_CALLS_PER_DAY` |
| Machine Watch reads per machine per minute | 6 | `LIMIT_MACHINE_READS_PER_MIN` |
| Standard Work Studio runs per master per day | 10 | `services/forge/config.py` |
| Requests per IP per minute on public endpoints (status, deep health) | 60 | `services/api/public_rate_limit.py` |

Agents and Studio steps call Gemini with timeouts, so a slow model fails clearly instead of hanging; agent requests end before the 60 s Firebase Hosting limit.

