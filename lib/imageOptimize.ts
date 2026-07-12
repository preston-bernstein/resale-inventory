// Client-side photo optimization: downscale + recompress before upload, so
// large phone-camera photos (often 4-12MB, 4000px+) don't get stored and
// re-served at full resolution. Runs entirely in the browser via Canvas —
// no new dependency, no server-side image-processing library needed for a
// single-user local app.

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;

/**
 * Downscale `file` to at most MAX_DIMENSION on its longest side and
 * recompress as JPEG. Falls back to returning the original file untouched
 * if it isn't an image, the browser can't decode it, or the "optimized"
 * result would actually be larger (already-small or already-compressed
 * images) — this must never make an upload worse.
 */
export async function optimizeImageFile(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  // Feature-check rather than a bare try/await: calling a missing global
  // (e.g. createImageBitmap in a test/SSR environment without it) throws
  // synchronously, before any `.catch()` on its return value can attach.
  if (typeof createImageBitmap !== 'function') return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  try {
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob || blob.size >= file.size) return file;

    const optimizedName = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], optimizedName, { type: 'image/jpeg' });
  } finally {
    bitmap.close();
  }
}
