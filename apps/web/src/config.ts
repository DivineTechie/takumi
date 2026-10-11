// Model IDs used across TAKUMI (Google only, no Gemini 1.x/2.x or Imagen).
// Do not set temperature (deprecated on 3.6+).

export const MODEL_FLASH = 'gemini-3.8-flash';
export const MODEL_FLASH_LITE = 'gemini-3.5-flash-lite';
export const MODEL_LIVE = 'gemini-3.8-live';
export const MODEL_ROBOTICS_ER = 'gemini-robotics-er-2-preview';
export const MODEL_FLASH_IMAGE = 'gemini-3.1-flash-image';
export const MODEL_VEO = 'veo-3.1-fast-generate-preview';
export const MODEL_OMNI = 'gemini-omni-1.1-flash';
export const MODEL_TTS = 'gemini-3.8-flash-tts';
export const MODEL_EMBEDDING = 'gemini-embedding-2-preview';

// Machine Watch edge settings (P17). The browser checks every frame for free; Gemini is called only
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
