// Model IDs live only in the services (services/*/config.py); the browser never calls Gemini with a key.

// Machine Watch edge settings. The browser checks every frame for free; Gemini is called only
// on a stable change, at most maxReadsPerMinute per machine (the API enforces the same cap).
export const MACHINE_WATCH = {
  frameIntervalMs: 500,
  lightStableFrames: 3,
  regionStableFrames: 2,
  regionDiffThreshold: 12,
  /** Pixel-change threshold on the stack light region (fallback trigger when the colour check misses). */
  lightDiffThreshold: 18,
  /** Counters change every cycle; read them (counter crop only, about a third of a full read) every 2 minutes. */
  counterReadEveryMs: 2 * 60_000,
  heartbeatMs: 10 * 60_000,
  maxReadsPerMinute: 6,
  cropMaxPx: 512,
};
