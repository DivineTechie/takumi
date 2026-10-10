# TAKUMI — rules for coding agents

## Product
TAKUMI captures a master's hands-on skill once (Master Capture + Forge agents) and teaches it live
to any worker in their language (Live Coach). Google Cloud AI Builder Cup 2026, Manufacturing theme.

## Stack (Google only)
- Web: React 19 + Vite + TypeScript in /apps/web, Firebase Hosting, Firebase Auth (Google sign-in),
  roles in custom claim `role`: master | trainee | supervisor.
- API: Python 3.12 FastAPI in /services/api on Cloud Run.
- Forge: Python 3.12 in /services/forge on Cloud Run: the Standard Work Studio pipeline as a Google ADK 2
  Workflow graph (graph/workflow.py; each step a FunctionNode calling Gemini) and ADK LLM agents
  (agents/: quality trace-back).
- Data: Firestore (Native), Cloud Storage (one bucket), BigQuery dataset `takumi`.
- AI: google-genai SDK. Model IDs live ONLY in services/*/config.py and apps/web/src/config.ts:
  gemini-3.8-flash, gemini-3.5-flash-lite, gemini-3.8-live, gemini-robotics-er-2-preview,
  gemini-3.1-flash-image, veo-3.1-fast-generate-preview, gemini-omni-1.1-flash,
  gemini-3.8-flash-tts, gemini-embedding-2-preview. Never use Gemini 1.x/2.x names or Imagen.
  Do not set temperature (deprecated on 3.6+).
- Security: keys in Secret Manager only; the browser never sees an API key (Live uses single-use
  tokens from POST /api/live-token); Model Armor screens user-supplied text; Firestore and Storage
  rules enforce roles.

## Ownership
- Single working branch: coach (deploys API, Forge, rules and Hosting). main receives the final merge only.
- /shared/schema changes: regenerate both TS and Pydantic and update both services in the same commit.

## Contracts
/shared/schema holds JSON Schema + generated TS types + Pydantic models for captures, skills,
forge_jobs, review_requests, sessions, session events. Read them before any data work.

## Engineering rules
- Every feature: implementation plan first, tests (pytest / vitest), browser check at 390x844 and 1440x900.
- Live API: wss .../v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=; setup with
  responseModalities [AUDIO], input/output transcription, contextWindowCompression slidingWindow;
  16 kHz PCM in, 24 kHz PCM out, max 1 JPEG frame per second; strip "<no speech>" and "{pause}".
- The Live model reacts to speech, not to video alone: anything triggered by what the camera sees
  goes through the step watcher (gemini-3.5-flash-lite) and is injected as a "[CAMERA EVENT] ..." text.
- Success criteria are visible facts only. Never let the Live model decide a step passed by itself.
- Never commit secrets, .env files, videos or generated media. Media goes to Cloud Storage.
- Accessibility: large touch targets, captions for all speech, works with gloves, WCAG AA contrast.

## Repo workflow
- Branches: coach (working branch, deploys everything), main (final merge only), forge (frozen).
- The repo stays private until submission. Never print, commit or log anything that would be unsafe once it is public.
  Never rebase or force-push shared branches; small focused commits on coach; conventional commits, e.g. feat(coach): ..., feat(forge): ...
- Regenerate /shared/schema/ts and /shared/schema/py with `npm run schema` from the repo root.
