import { describe, it, expect, vi } from 'vitest';
import { isCameraMirrored, captureVideoFrame } from './video';

describe('isCameraMirrored', () => {
  it('returns false when facingMode is "environment" (rear camera on phone)', () => {
    const mockTrack = {
      getSettings: () => ({ facingMode: 'environment' }),
    } as unknown as MediaStreamTrack;

    expect(isCameraMirrored(mockTrack)).toBe(false);
  });

  it('returns true when facingMode is "user" (front camera on phone/tablet)', () => {
    const mockTrack = {
      getSettings: () => ({ facingMode: 'user' }),
    } as unknown as MediaStreamTrack;

    expect(isCameraMirrored(mockTrack)).toBe(true);
  });

  it('returns true when facingMode is undefined or missing (standard laptop webcams)', () => {
    const mockTrack = {
      getSettings: () => ({}),
    } as unknown as MediaStreamTrack;

    expect(isCameraMirrored(mockTrack)).toBe(true);
  });

  it('returns true when track is missing', () => {
    expect(isCameraMirrored(undefined)).toBe(true);
  });
});

describe('captureVideoFrame', () => {
  it('returns null if video element has 0 width or height', () => {
    const mockVideo = {
      videoWidth: 0,
      videoHeight: 0,
    } as unknown as HTMLVideoElement;

    expect(captureVideoFrame(mockVideo)).toBeNull();
  });

  it('scales frame to target width and handles canvas mirroring when mirrored is true', () => {
    const mockCtx = {
      translate: vi.fn(),
      scale: vi.fn(),
      drawImage: vi.fn(),
    };

    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => mockCtx),
      toDataURL: vi.fn(() => 'data:image/jpeg;base64,mockJpegData'),
    };

    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') return mockCanvas as unknown as HTMLCanvasElement;
      return origCreateElement(tagName);
    });

    const mockVideo = {
      videoWidth: 1280,
      videoHeight: 720,
    } as unknown as HTMLVideoElement;

    const result = captureVideoFrame(mockVideo, {
      targetWidth: 768,
      mirrored: true,
    });

    expect(mockCanvas.width).toBe(768);
    expect(mockCanvas.height).toBe(Math.round(768 * (720 / 1280)));
    expect(mockCtx.translate).toHaveBeenCalledWith(768, 0);
    expect(mockCtx.scale).toHaveBeenCalledWith(-1, 1);
    expect(mockCtx.drawImage).toHaveBeenCalledWith(mockVideo, 0, 0, 768, mockCanvas.height);
    expect(result).toBe('mockJpegData');
  });
});
