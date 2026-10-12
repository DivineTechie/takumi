# TAKUMI Studio and agents (`services/forge`)

Python 3.12, FastAPI on Cloud Run. Two parts:

- **Standard Work Studio**: a Google ADK 2 `Workflow` graph (`graph/workflow.py`) that turns one master
  recording into a lesson for review. Each step is a `FunctionNode` that calls Gemini with the google-genai SDK.
- **ADK agents** in `agents/`: quality trace-back, maintenance work orders and demand planning.

## Studio pipeline

```
START -> load_capture -> segmenter -> [spatial_annotator, verifier, localizer] -> annotated (join) -> publisher
```

| Node | Model | Input | Output |
| :--- | :--- | :--- | :--- |
| `load_capture` | none | `captures/{id}` (title, language, video, live transcript) | state; MP4 copy (`captures/{id}/master.mp4`, H.264 + faststart) when ffmpeg can make one |
| `segmenter` | `gemini-3.8-flash` | the capture video (Gemini Files API upload, deleted after the call) and the transcript | ordered steps: title, instruction, visible-fact success criteria, why (with the master's timestamps when spoken, otherwise marked inferred), safety note, tools, likely mistake and its visual cue, point target, clip and key frame time; task safety rules |
| `spatial_annotator` | `gemini-robotics-er-2-preview` | one key frame per step, cut with ffmpeg into memory | `point_yx` ([y, x], 0-1000) for steps where the part was found; none otherwise |
| `verifier` | `gemini-3.5-flash-lite` | each step's instruction and success criteria | per step: visible fact or not, the reason and a suggested rewrite; changes no text |
| `localizer` | `gemini-3.8-flash` | the English steps | one call per language (ja, vi, hi, id, fil): title, instruction, criteria, why, hazards; a language that fails is left out |
| `publisher` | none | state | `skills/{id}` validated against `shared/schema/skills.json`, status `in_review`; job `done` |

Every node writes progress to `forge_jobs/{jobId}/events` (`events.py`) with real counts and timings; the
web trace (`apps/web/src/features/review/AgentTrace.tsx`) shows only those events and the saved lesson.
A failing node writes an error event under its own name and stops the graph; the job and capture become
`failed` and the empty lesson is removed.

Limits (`config.py`): video up to 300 MB and 16 minutes, up to 12 steps, a timeout on every model call
(one retry on errors, none on timeouts), 15 minutes per run, 10 runs per master per day.

## What is stored

- `skills/{id}`: the lesson text, clips, key frame times, pointer coordinates, verifier results, translations.
- `forge_jobs/{id}` and its `events`: status and progress messages.
- `rate_limits/forge_{uid}_{YYYYMMDD}`: the daily run count.
- Cloud Storage: only `captures/{id}/master.mp4` (the transcoded recording). Key frames are never stored;
  the uploaded Files API copy is deleted after segmentation (and expires after 48 h regardless).

## Endpoints

- `POST /forge/jobs` (master, own capture, daily cap) starts a run; `GET /forge/jobs/{id}` reads its status.
- `POST /forge/steps/regenerate` (master) rewrites one step's instruction, criteria or why with
  `gemini-3.8-flash` from the stored lesson and the narration around the step, with translations;
  nothing is saved until the master publishes in review.
- `POST /forge/agents/traceback | maintenance | demand` (supervisor) run the ADK agents.

The Gemini key comes from Secret Manager (mounted as `GEMINI_API_KEY` on Cloud Run) and is never logged.
Without a key the service runs offline: the Studio and agents answer 503.

## Tests

`.venv\Scripts\python.exe -m pytest services/forge -q` runs offline with Gemini, Cloud Storage and ffmpeg faked.
