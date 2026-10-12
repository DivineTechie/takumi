import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resizeImageForUpload } from './imageResize';

describe('imageResize utility', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resizes image to max 1600px long side maintaining aspect ratio', async () => {
    // Mock Image and Canvas
    const mockDrawImage = vi.fn();
    const mockToDataURL = vi.fn(() => 'data:image/jpeg;base64,dGVzdA==');
    const mockToBlob = vi.fn((cb) => {
      cb(new Blob(['fake-jpeg'], { type: 'image/jpeg' }));
    });

    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        drawImage: mockDrawImage,
      })),
      toDataURL: mockToDataURL,
      toBlob: mockToBlob,
    };

    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return mockCanvas as unknown as HTMLCanvasElement;
      return document.createElement(tag);
    });

    // Mock FileReader
    class MockFileReader {
      public onload: (() => void) | null = null;
      public result: string | null = 'data:image/png;base64,fakeinput';
      readAsDataURL() {
        setTimeout(() => {
          if (this.onload) this.onload();
        }, 10);
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).FileReader = MockFileReader;

    // Mock Image loading with 3200x1600 dimensions
    class MockImage {
      public onload: (() => void) | null = null;
      public width = 3200;
      public height = 1600;
      set src(_val: string) {
        setTimeout(() => {
          if (this.onload) this.onload();
        }, 10);
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Image = MockImage;

    const file = new File(['dummy'], 'test.jpg', { type: 'image/jpeg' });
    const result = await resizeImageForUpload(file, 1600, 0.85);

    expect(result.width).toBe(1600);
    expect(result.height).toBe(800);
    expect(result.base64).toBe('dGVzdA==');
    expect(result.blob).toBeDefined();
    expect(mockDrawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1600, 800);
  });
});
