import { describe, it, expect } from 'vitest';
import { mapNormalizedPointToScreen, type VideoCropDimensions } from './reticle';

describe('mapNormalizedPointToScreen', () => {
  it('maps points accurately when video and screen have identical aspect ratios', () => {
    const dims: VideoCropDimensions = {
      videoWidth: 1280,
      videoHeight: 720,
      screenWidth: 1280,
      screenHeight: 720,
    };

    // Center point [500, 500] (normalized y=500, x=500)
    const center = mapNormalizedPointToScreen([500, 500], dims);
    expect(center.x).toBe(640);
    expect(center.y).toBe(360);
    expect(center.visible).toBe(true);

    // Top-left [0, 0]
    const topLeft = mapNormalizedPointToScreen([0, 0], dims);
    expect(topLeft.x).toBe(0);
    expect(topLeft.y).toBe(0);
    expect(topLeft.visible).toBe(true);

    // Bottom-right [1000, 1000]
    const bottomRight = mapNormalizedPointToScreen([1000, 1000], dims);
    expect(bottomRight.x).toBe(1280);
    expect(bottomRight.y).toBe(720);
    expect(bottomRight.visible).toBe(true);
  });

  it('correctly maps horizontal crop on tall phone portrait viewports (object-fit: cover)', () => {
    // 16:9 video displayed full-bleed on a 390x844 portrait screen
    const dims: VideoCropDimensions = {
      videoWidth: 1280,
      videoHeight: 720,
      screenWidth: 390,
      screenHeight: 844,
    };

    // Center of camera feed [500, 500] must map to center of phone screen
    const center = mapNormalizedPointToScreen([500, 500], dims);
    expect(Math.round(center.x)).toBe(195);
    expect(Math.round(center.y)).toBe(422);
    expect(center.visible).toBe(true);

    // Far left of camera frame [500, 50] (x=50 on 1280px is ~64px in video space)
    // On a 390-wide portrait display, left ~37% is cropped out
    const farLeft = mapNormalizedPointToScreen([500, 50], dims);
    expect(farLeft.x).toBeLessThan(0);
    expect(farLeft.visible).toBe(false);

    // Far right of camera frame [500, 950]
    const farRight = mapNormalizedPointToScreen([500, 950], dims);
    expect(farRight.x).toBeGreaterThan(390);
    expect(farRight.visible).toBe(false);
  });

  it('correctly maps vertical crop on wide landscape viewports (object-fit: cover)', () => {
    // 4:3 video (1280x960) displayed on a 16:10 laptop screen (1440x900)
    const dims: VideoCropDimensions = {
      videoWidth: 1280,
      videoHeight: 960,
      screenWidth: 1440,
      screenHeight: 900,
    };

    // Center [500, 500] must map to center of laptop screen (720, 450)
    const center = mapNormalizedPointToScreen([500, 500], dims);
    expect(Math.round(center.x)).toBe(720);
    expect(Math.round(center.y)).toBe(450);
    expect(center.visible).toBe(true);

    // Top edge [10, 500] is cropped out vertically
    const topEdge = mapNormalizedPointToScreen([10, 500], dims);
    expect(topEdge.y).toBeLessThan(0);
    expect(topEdge.visible).toBe(false);
  });

  it('gracefully handles missing or zero dimensions', () => {
    const invalidDims: VideoCropDimensions = {
      videoWidth: 0,
      videoHeight: 0,
      screenWidth: 390,
      screenHeight: 844,
    };

    const res = mapNormalizedPointToScreen([500, 500], invalidDims);
    expect(res.visible).toBe(false);
  });
});
