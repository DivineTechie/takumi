/**
 * Machine Watch edge vision (P17): cheap per-frame checks that run in the browser so Gemini is only
 * called when something on the machine changes. "Gemini configures, the edge watches, Gemini reasons."
 */

export interface Roi {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PixelBlock {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Converts a normalised ROI to integer pixel coordinates inside a frame, clamped to the frame. */
export function roiToPixels(roi: Roi, frameW: number, frameH: number) {
  const x = Math.max(0, Math.min(frameW - 1, Math.round(roi.x * frameW)));
  const y = Math.max(0, Math.min(frameH - 1, Math.round(roi.y * frameH)));
  const w = Math.max(1, Math.min(frameW - x, Math.round(roi.w * frameW)));
  const h = Math.max(1, Math.min(frameH - y, Math.round(roi.h * frameH)));
  return { x, y, w, h };
}

/** Perceived brightness (HSV value, 0-255) of one pixel. */
function value(data: Uint8ClampedArray, i: number): number {
  return Math.max(data[i], data[i + 1], data[i + 2]);
}

export interface LitResult {
  /** Colour of the lit segment, "off" when none is clearly lit, "multiple" when several are. */
  light: string;
  /** Mean brightness of each segment, top to bottom. */
  levels: number[];
}

/**
 * Decides which segment of a stack light is lit by comparing the brightness of horizontal bands
 * (one band per colour in lightOrder, top to bottom). A segment counts as lit when its mean
 * brightness is well above the dimmest band.
 */
export function stackLightLit(block: PixelBlock, lightOrder: string[], minContrast = 40): LitResult {
  const bands = Math.max(1, lightOrder.length);
  const sums = new Array(bands).fill(0);
  const counts = new Array(bands).fill(0);
  const { width, height, data } = block;
  for (let y = 0; y < height; y++) {
    const band = Math.min(bands - 1, Math.floor((y / height) * bands));
    for (let x = 0; x < width; x++) {
      sums[band] += value(data, (y * width + x) * 4);
      counts[band] += 1;
    }
  }
  const levels = sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
  const floor = Math.min(...levels);
  const lit = levels.map((l, i) => (l - floor >= minContrast ? i : -1)).filter((i) => i >= 0);
  let light = 'off';
  if (lit.length === 1) light = lightOrder[lit[0]];
  else if (lit.length > 1) light = 'multiple';
  return { light, levels };
}

/** Mean absolute difference (0-255) between two equally sized blocks, on brightness only. */
export function meanAbsDiff(a: PixelBlock, b: PixelBlock): number {
  if (a.width !== b.width || a.height !== b.height) return 255;
  const n = a.width * a.height;
  if (n === 0) return 0;
  let total = 0;
  for (let i = 0; i < n * 4; i += 4) {
    total += Math.abs(value(a.data, i) - value(b.data, i));
  }
  return total / n;
}

/**
 * Reports a change only once it has been stable for `stableFrames` consecutive frames, so flicker,
 * a hand passing by or a single noisy frame never triggers a Gemini call.
 */
export class StableValue<T> {
  private committed: T | undefined;
  private candidate: T | undefined;
  private streak = 0;

  constructor(private readonly stableFrames: number) {}

  /** Feeds one frame's value; returns the new value when a change becomes stable, else undefined. */
  push(v: T): T | undefined {
    if (this.committed === undefined) {
      this.committed = v;
      return undefined;
    }
    if (v === this.committed) {
      this.candidate = undefined;
      this.streak = 0;
      return undefined;
    }
    if (v === this.candidate) this.streak += 1;
    else {
      this.candidate = v;
      this.streak = 1;
    }
    if (this.streak >= this.stableFrames) {
      this.committed = v;
      this.candidate = undefined;
      this.streak = 0;
      return v;
    }
    return undefined;
  }

  get value(): T | undefined {
    return this.committed;
  }
}

/**
 * Tracks a display region (counter or HMI). A change is reported when the region differs from the
 * last stable snapshot by more than `threshold` for `stableFrames` consecutive frames; the new
 * picture then becomes the reference.
 */
export class RegionChange {
  private reference: PixelBlock | null = null;
  private streak = 0;

  constructor(
    private readonly threshold: number,
    private readonly stableFrames: number
  ) {}

  push(block: PixelBlock): boolean {
    if (!this.reference) {
      this.reference = block;
      return false;
    }
    if (meanAbsDiff(block, this.reference) > this.threshold) {
      this.streak += 1;
      if (this.streak >= this.stableFrames) {
        this.reference = block;
        this.streak = 0;
        return true;
      }
      return false;
    }
    this.streak = 0;
    return false;
  }

  reset(block: PixelBlock): void {
    this.reference = block;
    this.streak = 0;
  }
}

/** Sliding-window limiter: allows at most `max` events per `windowMs`. */
export class RateCap {
  private times: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  tryTake(now: number): boolean {
    this.times = this.times.filter((t) => now - t < this.windowMs);
    if (this.times.length >= this.max) return false;
    this.times.push(now);
    return true;
  }
}
