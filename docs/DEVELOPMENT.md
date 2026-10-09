# TAKUMI — Local Development Guide

## Local Web Development & Cloud Run Proxy

When running the web frontend locally via Vite (`npm --prefix apps/web run dev`), API calls to `/api` and `/forge` can be forwarded to a running Cloud Run backend service.

### Setting the Backend Target

Create an unversioned environment file `apps/web/.env.development.local` (ignored by git):

```env
VITE_DEV_API_TARGET=https://takumi-api-692366725458.asia-southeast1.run.app
```

When `VITE_DEV_API_TARGET` is set, Vite's development server automatically proxies:
- `/api/*` -> `${VITE_DEV_API_TARGET}/api/*`
- `/forge/*` -> `${VITE_DEV_API_TARGET}/forge/*`

If `VITE_DEV_API_TARGET` is not set, Vite prints a message and no proxying occurs.

**Note:** Never commit Cloud Run URLs or `.env.development.local` to git.


## Machine Watch soak test without the website

1. Run `npm --prefix apps/web run dev` and sign in on http://localhost:5173.
2. Open `/machines/virtual` on the laptop, choose machines, minutes, seed and pace, and press **Start soak run**. Press **Camera view** to hide the controls (double-click to bring them back).
3. Record the screen with a phone for the whole run (keep the run clock in view).
4. Open `/machines/watch?debug=1`, **Use video file**, pick the recording, tick "These are the test bench machines", press **Find machines with Gemini**, check the boxes, **Save machines**.
5. Pick the soak run, enter the video time at which the run clock showed 00:00:00, and press **Start watching**. Let the video play to the end.
6. Score it: `python -m evals.machine_watch.score_soak <run_id>` (writes `evals/machine_watch/RESULTS_<run_id>.md`).
