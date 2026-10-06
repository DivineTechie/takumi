# TAKUMI — Security Architecture & Governance

This document describes the security controls, Content Security Policy (CSP), Model Armor configurations, and vulnerability review standards implemented for TAKUMI.

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
| `img-src` | `'self'`, `data:`, `blob:` | In-browser canvas snapshots, QR code generation, and video frames. |
| | `https://storage.googleapis.com` | Google Cloud Storage signed URLs for Skill Passport badge graphics. |
| | `https://lh3.googleusercontent.com` | Google user profile avatars returned by Firebase Auth Google provider. |
| `media-src` | `'self'`, `blob:`, `https://storage.googleapis.com` | Web Audio API PCM streaming playback and captured video inspection media. |
| `connect-src` | `'self'` | TAKUMI backend API routes (`/api/*`). |
| | `https://firestore.googleapis.com` | Client-side Firestore SDK for published skills synchronization. |
| | `https://firebasestorage.googleapis.com`, `https://storage.googleapis.com` | Cloud Storage upload and metadata verification. |
| | `https://identitytoolkit.googleapis.com`, `https://securetoken.googleapis.com` | Firebase Auth credential exchange and token refresh. |
| | `https://accounts.google.com`, `https://apis.google.com`, `https://www.googleapis.com` | Google identity endpoints and Google APIs token validation. |
| | `https://*.firebaseapp.com`, `https://takumi-cup-2026.web.app/__/auth/` | Firebase Auth helper handlers and redirect proxies. |
| | `wss://generativelanguage.googleapis.com` | Gemini Live Multimodal WebSocket connection for real-time coaching. |
| `frame-src` | `https://accounts.google.com`, `https://apis.google.com`, `https://*.firebaseapp.com` | Sandboxed iframes spawned by Google Sign-In and Firebase Auth. |
| `report-uri` | `/api/csp-report` | Telemetry endpoint in `takumi-api` logging structured warnings without PII. |

---

## 2. Google Cloud Model Armor Protection

Untrusted text input from users (such as spatial pointing targets and trainee questions) is screened using Google Cloud Model Armor before hitting generative AI models.

- **Resource Location**: `us-central1`
  - Selected because `us-central1` fully supports all 3 security capabilities simultaneously: Prompt Injection & Jailbreak detection (`pi_and_jailbreak`), Responsible AI safety rules (`rai`), and Malicious URI detection (`malicious_uris`). Regional host: `https://modelarmor.us-central1.rep.googleapis.com/v1/...`.
- **Template ID**: `projects/takumi-cup-2026/locations/us-central1/templates/takumi-user-text`
- **Fail-Safe Behavior**:
  - `point_target`: **Fail-OPEN** with 1.5s timeout. If Model Armor is temporarily unreachable, spatial pointer continues so live hands-on assembly coaching is not disrupted.
  - `question`: **Fail-CLOSED** with 1.5s timeout. Free-form text queries are blocked if safety screening cannot be completed.
- **Privacy Assurance**: The screening function logs matched violation categories only (e.g. `pi_and_jailbreak`) and **never logs raw user text**.

---

## 3. Dependency Security Audits

### Python Backend (`services/api`)
- Tool: `pip-audit -r services/api/requirements.txt`
- Status: **0 known vulnerabilities found**.

### Web Frontend (`apps/web`)
- Tool: `npm audit --omit=dev --audit-level=high`
- **Audit Findings**:
  - 4 high-severity advisories reported against `@grpc/grpc-js` (via `@firebase/firestore` -> `firebase`).
  - **Exemption Justification**: `@grpc/grpc-js` is a Node.js-only gRPC transport library. In the web browser environment, the Firebase Web SDK uses WebChannel and standard `fetch`/`XHR` transports; the `@grpc/grpc-js` code path is never bundled or executed in client browsers. CI audits are configured as non-blocking informative reports.

### Repository Secrets Scan
- Tool: `gitleaks detect` across all commits.
- Result: **0 secret leaks detected**.

---

## 4. Production Kill Switch & Privacy Telemetry

1. **Kill Switch (`SESSIONS_ENABLED`)**:
   - Cloud Run environment variable `SESSIONS_ENABLED=true|false`.
   - Immediately returns HTTP 503 on `POST /api/sessions` and `POST /api/live-token` (coach) to pause live sessions without degrading read access to passports, skill libraries, or dashboards.
2. **Public Health & Latency Telemetry (`/api/status` & `/status`)**:
   - Anonymous aggregate metrics calculated from BigQuery partitioned audit logs.
   - Strictly contains numeric latency percentiles (p50/p90) and session counts.
   - Zero personal names, email addresses, or account identifiers are exposed or stored in API metrics.
