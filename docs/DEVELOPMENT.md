# TAKUMI: development notes

Setup, tests and the three ways to run TAKUMI are in the [README](../README.md#running-locally). This page covers the details.

## Web app against a backend

`apps/web/.env.development.local` (copy it from [`apps/web/.env.example`](../apps/web/.env.example); never commit it) sets:

- `VITE_DEV_API_TARGET`: where Vite proxies `/api/*` (and `/forge/*` unless `VITE_DEV_FORGE_TARGET` is set). Use the Hosting URL of a deployment, which rewrites both paths to Cloud Run, or `http://localhost:8080` for a local API.
- `VITE_DEV_FORGE_TARGET`: optional, for a separately running Forge service (for example `http://localhost:8081`).
- The six `VITE_FIREBASE_*` values of the Firebase web app.

Without `VITE_DEV_API_TARGET`, Vite prints a notice and does not proxy.

## Translations

Every screen string is in `apps/web/src/i18n`: core strings in `<lang>.json`, page areas in `pages/<lang>/<area>.json`. Add or change English in `pages/en/<area>.json`, then fill the other five languages with Gemini (missing or changed keys only; placeholders are checked):

```bash
python -m infra.translate_i18n --area ops
```

`apps/web/src/i18n/areas.test.ts` fails if a language misses a key or a placeholder.

## Machine Watch soak test without the website

1. Run the web app and sign in.
2. Open `/machines/virtual` on a laptop, choose machines, minutes, seed and pace, and press **Start soak run**. Press **Camera view** to hide the controls (double-click brings them back).
3. Film the screen with a phone for the whole run (keep the run clock in view).
4. Open `/machines/watch?debug=1`, **Use video file**, pick the recording, tick "These are the test bench machines", press **Find machines with Gemini**, check the boxes and **Save machines**.
5. Pick the soak run, enter the video time at which the run clock showed 00:00:00, and press **Start watching**. Let the video play to the end.
6. Score it: `python -m evals.machine_watch.score_soak <run_id>` (writes `evals/machine_watch/RESULTS_<run_id>.md`).
