import { describe, expect, it } from 'vitest';
import {
  RateCap,
  RegionChange,
  StableValue,
  meanAbsDiff,
  roiToPixels,
  stackLightLit,
  type PixelBlock,
} from './machineVision';

/** Builds a block whose rows are filled band by band with the given brightness values (top to bottom). */
function banded(levels: number[], width = 10, rowsPerBand = 10): PixelBlock {
  const height = levels.length * rowsPerBand;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const v = levels[Math.floor(y / rowsPerBand)];
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v / 2;
      data[i + 2] = v / 3;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('machineVision', () => {
  it('converts a normalised ROI to clamped pixels', () => {
    expect(roiToPixels({ x: 0.5, y: 0.25, w: 0.25, h: 0.5 }, 640, 480)).toEqual({ x: 320, y: 120, w: 160, h: 240 });
    expect(roiToPixels({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 100, 100)).toEqual({ x: 90, y: 90, w: 10, h: 10 });
  });

  it('finds the lit segment of a stack light', () => {
    const order = ['red', 'yellow', 'green'];
    expect(stackLightLit(banded([30, 30, 220]), order).light).toBe('green');
    expect(stackLightLit(banded([230, 30, 30]), order).light).toBe('red');
    expect(stackLightLit(banded([40, 45, 50]), order).light).toBe('off');
    expect(stackLightLit(banded([220, 30, 220]), order).light).toBe('multiple');
  });

  it('measures region difference', () => {
    const a = banded([100, 100]);
    expect(meanAbsDiff(a, banded([100, 100]))).toBe(0);
    expect(meanAbsDiff(a, banded([150, 150]))).toBe(50);
  });

  it('reports a light change only after it is stable', () => {
    const s = new StableValue<string>(3);
    expect(s.push('green')).toBeUndefined();
    expect(s.push('red')).toBeUndefined();
    expect(s.push('green')).toBeUndefined(); // flicker resets
    expect(s.push('red')).toBeUndefined();
    expect(s.push('red')).toBeUndefined();
    expect(s.push('red')).toBe('red');
    expect(s.value).toBe('red');
  });

  it('reports a display change after it is stable, then uses it as the new reference', () => {
    const r = new RegionChange(20, 2);
    expect(r.push(banded([100]))).toBe(false);
    expect(r.push(banded([160]))).toBe(false);
    expect(r.push(banded([160]))).toBe(true);
    expect(r.push(banded([160]))).toBe(false);
  });

  it('caps calls per window', () => {
    const cap = new RateCap(2, 60_000);
    expect(cap.tryTake(0)).toBe(true);
    expect(cap.tryTake(1000)).toBe(true);
    expect(cap.tryTake(2000)).toBe(false);
    expect(cap.tryTake(61_000)).toBe(true);
  });
});
