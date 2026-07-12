// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { optimizeImageFile } from '../imageOptimize';

function makeFile(bytes: number, type = 'image/png', name = 'photo.png'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function fakeBitmap(width = 3000, height = 2000) {
  return { width, height, close: vi.fn() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('optimizeImageFile', () => {
  it('returns non-image files unchanged without touching createImageBitmap', async () => {
    const stub = vi.fn();
    vi.stubGlobal('createImageBitmap', stub);
    const file = makeFile(100, 'application/pdf', 'doc.pdf');

    const result = await optimizeImageFile(file);

    expect(result).toBe(file);
    expect(stub).not.toHaveBeenCalled();
  });

  it('returns the original file unchanged when createImageBitmap is not available (e.g. unsupported environment)', async () => {
    // Default jsdom state: createImageBitmap is not defined at all. Calling
    // a missing global throws synchronously, which is exactly the case the
    // typeof-guard exists to short-circuit before any await.
    const file = makeFile(1000);
    const result = await optimizeImageFile(file);
    expect(result).toBe(file);
  });

  it('returns the original file unchanged when createImageBitmap rejects (undecodable image)', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')));
    const file = makeFile(1000);

    const result = await optimizeImageFile(file);

    expect(result).toBe(file);
  });

  it('returns the original file unchanged when canvas 2D context is unavailable', async () => {
    const bitmap = fakeBitmap();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const file = makeFile(1000);

    const result = await optimizeImageFile(file);

    expect(result).toBe(file);
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('returns the original file unchanged when the compressed blob would be larger', async () => {
    const bitmap = fakeBitmap();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const file = makeFile(100); // tiny original — any real JPEG re-encode would be bigger
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob([new Uint8Array(500)], { type: 'image/jpeg' }));
    });

    const result = await optimizeImageFile(file);

    expect(result).toBe(file);
  });

  it('returns the original file unchanged when toBlob yields null', async () => {
    const bitmap = fakeBitmap();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(null);
    });
    const file = makeFile(1000);

    const result = await optimizeImageFile(file);

    expect(result).toBe(file);
  });

  it('returns a downscaled, recompressed JPEG File when the optimized blob is smaller', async () => {
    const bitmap = fakeBitmap(3200, 4000); // longest side > MAX_DIMENSION (1600)
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob([new Uint8Array(100)], { type: 'image/jpeg' }));
    });
    const file = makeFile(5000, 'image/png', 'huge-photo.png');

    const result = await optimizeImageFile(file);

    expect(result).not.toBe(file);
    expect(result.type).toBe('image/jpeg');
    expect(result.name).toBe('huge-photo.jpg');
    expect(result.size).toBe(100);
    // 3200x4000 -> longest side (height) scaled to MAX_DIMENSION (1600),
    // width scaled by the same 0.4 factor: 3200 * 0.4 = 1280. These are the
    // same width/height values the source sets on canvas.width/height
    // before drawing, so asserting the drawImage call args covers both.
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1280, 1600);
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('leaves already-small images at their original dimensions (scale capped at 1)', async () => {
    const bitmap = fakeBitmap(400, 300); // well under MAX_DIMENSION
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob([new Uint8Array(50)], { type: 'image/jpeg' }));
    });
    const file = makeFile(1000);

    await optimizeImageFile(file);

    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 400, 300);
  });
});
