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
