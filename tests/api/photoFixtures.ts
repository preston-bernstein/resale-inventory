import { beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import db from '@/lib/db';
import { PHOTOS_ROOT } from '@/lib/photos';
import { createTestTenant } from '../tenantFixtures';
import { createItemSeeder } from './itemSeed';

export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export function tinyPngFile(name = 'photo.png'): File {
  const bytes = Buffer.from(TINY_PNG_BASE64, 'base64');
  return new File([bytes], name, { type: 'image/png' });
}

export function getRequest(id: string, photoId: string, cookie = currentTenant?.cookieHeader) {
  return new NextRequest(photoUrl(id, photoId), {
    method: 'GET',
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}

export const createdItemDirs = new Set<string>();


let currentTenant: ReturnType<typeof createTestTenant>;

const seeder = createItemSeeder(() => currentTenant.tenantId);

/** Wrap a seeder so every item it creates is recorded for photo-directory cleanup. */
function withDirCleanup(insert: (overrides?: Record<string, unknown>) => string) {
  return (overrides: Record<string, unknown> = {}): string => {
    const id = insert(overrides);
    createdItemDirs.add(id);
    return id;
  };
}

export const insertClothingItem = withDirCleanup(seeder.insertClothingItem);
export const insertBookItem = withDirCleanup(seeder.insertBookItem);

export function getCurrentTenant() {
  return currentTenant;
}

export function photosUrl(id: string) {
  return `http://localhost/api/items/${id}/photos`;
}

export function photoUrl(id: string, photoId: string) {
  return `http://localhost/api/items/${id}/photos/${photoId}`;
}

export function uploadRequest(id: string, files: File[], headers?: Record<string, string>) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const finalHeaders: Record<string, string> = { ...headers };
  // The X-Pairing-Token branch never reads the session cookie (Task 16's
  // carve-out) -- omitting it for those requests keeps this file proving
  // that path truly needs no cookie, not just tolerating one.
  if (!('X-Pairing-Token' in finalHeaders) && !('Cookie' in finalHeaders)) {
    finalHeaders.Cookie = currentTenant.cookieHeader;
  }
  return new NextRequest(photosUrl(id), { method: 'POST', body: fd, headers: finalHeaders });
}

export function reorderRequest(id: string, order: string[], cookie = currentTenant?.cookieHeader) {
  return new NextRequest(photosUrl(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ order }),
  });
}

export function deleteRequest(id: string, photoId: string, cookie = currentTenant?.cookieHeader) {
  return new NextRequest(photoUrl(id, photoId), {
    method: 'DELETE',
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}

export function photoRowCount(itemId: string): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM item_photos WHERE item_id = ?').get(itemId) as {
    cnt: number;
  };
  return row.cnt;
}

export function usePhotoTenant() {
  beforeEach(() => {
    db.exec(
      'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
      'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
    );
    createdItemDirs.clear();
    currentTenant = createTestTenant();
  });
  afterEach(() => {
    // Best-effort cleanup of any per-item photo directories this test file
    // created, since the route writes into the shared data/photos root
    // rather than a test-scratch path.
    for (const id of createdItemDirs) {
      const dir = path.join(PHOTOS_ROOT, id);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });
}

export function seedThreePhotos(id: string): [string, string, string] {
  const insert = db.prepare(
    'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
  );
  const p1 = uuidv4();
  const p2 = uuidv4();
  const p3 = uuidv4();
  insert.run(p1, id, `${id}/p1.png`, 1, currentTenant.tenantId);
  insert.run(p2, id, `${id}/p2.png`, 2, currentTenant.tenantId);
  insert.run(p3, id, `${id}/p3.png`, 3, currentTenant.tenantId);
  return [p1, p2, p3];
}

export function notAnImageFile(name = 'not-image.png'): File {
  // Declares image/png but the bytes fail the magic-byte sniff.
  return new File([Buffer.from('this is not image data')], name, { type: 'image/png' });
}

// Magic-byte fixtures for the image sniff in app/api/items/[id]/photos/_upload/
// imageType.ts. Each builder takes an optional `corrupt` index+value so
// individual required bytes can be flipped one at a time: a "near miss" input
// where exactly one required byte is wrong only differs in outcome if that
// specific byte's check is load-bearing.
export function jpegBytes(corrupt?: { index: 0 | 1 | 2; value: number }): Buffer {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
  if (corrupt) bytes[corrupt.index] = corrupt.value;
  return bytes;
}

export function pngBytes(corrupt?: { index: 0 | 1 | 2 | 3; value: number }): Buffer {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  if (corrupt) bytes[corrupt.index] = corrupt.value;
  return bytes;
}

export function webpBytes(corrupt?: { index: 0 | 1 | 2 | 3 | 8 | 9 | 10 | 11; value: number }): Buffer {
  const bytes = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
  if (corrupt) bytes[corrupt.index] = corrupt.value;
  return bytes;
}

export function fileFromBytes(bytes: Buffer, name: string, contentType: string): File {
  return new File([new Uint8Array(bytes)], name, { type: contentType });
}
