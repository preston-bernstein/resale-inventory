import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { PHOTOS_ROOT } from '@/lib/photos';
import { createTestTenant, type TestTenant } from './tenant';
import { seedBookItem, seedClothingItem } from './items';
import { vi } from 'vitest';

// Every photo route needs a tenant session cookie on the normal browser path.
// A fresh tenant is created per test (resetPhotosState) and kept here so the
// request builders and item seeders below can pick it up.
let activeTenant: TestTenant | undefined;

export function currentTenant(): TestTenant {
  if (!activeTenant) throw new Error('resetPhotosState() must run before this helper');
  return activeTenant;
}

// Mirrors MAX_PHOTO_SIZE in app/api/items/[id]/photos/route.ts (not exported).
export const MAX_PHOTO_SIZE_BYTES = 10 * 1024 * 1024;

// Minimal valid 1x1 transparent PNG — same fixture used by tests/e2e/photo-upload.spec.ts.
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export function tinyPngFile(name = 'photo.png'): File {
  const bytes = Buffer.from(TINY_PNG_BASE64, 'base64');
  return new File([bytes], name, { type: 'image/png' });
}

export function notAnImageFile(name = 'not-image.png'): File {
  // Declares image/png but the bytes fail the magic-byte sniff.
  return new File([Buffer.from('this is not image data')], name, { type: 'image/png' });
}

// Magic-byte fixtures for sniffImageType's three branches (app/api/items/[id]/
// photos/route.ts). Each builder takes an optional `corrupt` index+value so
// individual required bytes can be flipped one at a time — the standard
// technique for killing chained-&&/EqualityOperator/ConditionalExpression
// mutants: a "near miss" input where exactly one required byte is wrong (all
// others correct) only differs in outcome from the mutated code if that
// specific byte's check is actually load-bearing.
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

// Exactly 12 bytes — the WEBP magic-byte boundary (bytes.length >= 12).
// RIFF....WEBP: bytes 0-3 "RIFF", bytes 4-7 arbitrary (chunk size), bytes
// 8-11 "WEBP".
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

export function getRequest(id: string, photoId: string, cookie = activeTenant?.cookieHeader) {
  return new NextRequest(photoUrl(id, photoId), {
    method: 'GET',
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}

// PHOTOS_ROOT now comes from lib/photos.ts, which resolves via
// BOOKSELLER_PHOTOS_PATH — vitest.config.ts points this at a scratch
// directory for every test run, mirroring the BOOKSELLER_DB_PATH pattern.
// (Earlier finding: the route used to hardcode <process.cwd()>/data/photos
// with no override, which wrote real test files into the app's production
// photo directory — fixed at the source in lib/photos.ts, not just here.)
const createdItemDirs = new Set<string>();

export function photosUrl(id: string) {
  return `http://localhost/api/items/${id}/photos`;
}

function photoUrl(id: string, photoId: string) {
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
    finalHeaders.Cookie = currentTenant().cookieHeader;
  }
  return new NextRequest(photosUrl(id), { method: 'POST', body: fd, headers: finalHeaders });
}

export function reorderRequest(id: string, order: string[], cookie = activeTenant?.cookieHeader) {
  return new NextRequest(photosUrl(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ order }),
  });
}

export function deleteRequest(id: string, photoId: string, cookie = activeTenant?.cookieHeader) {
  return new NextRequest(photoUrl(id, photoId), {
    method: 'DELETE',
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}

export function insertClothingItem(overrides: Record<string, unknown> = {}): string {
  const id = seedClothingItem(currentTenant().tenantId, { title: 'Test Clothing Item', brand: 'TestBrand', ...overrides });
  createdItemDirs.add(id);
  return id;
}

export function insertBookItem(overrides: Record<string, unknown> = {}): string {
  const id = seedBookItem(currentTenant().tenantId, { title: 'Test Book', author: 'Test Author', publisher: 'Test Publisher', ...overrides });
  createdItemDirs.add(id);
  return id;
}

// Records every path written through fs.writeFileSync while still writing it.
export function spyOnWrittenFiles() {
  const written: string[] = [];
  const realWriteFileSync = fs.writeFileSync.bind(fs);
  const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((
    ...args: Parameters<typeof fs.writeFileSync>
  ) => {
    written.push(args[0] as string);
    return realWriteFileSync(...args);
  }) as typeof fs.writeFileSync);
  return { written, writeSpy };
}

// Forces the row insert (which happens AFTER the file write, per the
// route's own write-then-insert-row comment) to fail, without needing
// to predict any server-generated uuid. db.prepare is spy-able (a
// real object method); the 'uuid' package's ESM export is not
// (Vitest: "Module namespace is not configurable in ESM").
export function failPhotoRowInserts() {
  const realPrepare = db.prepare.bind(db);
  return vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    if (sql.includes('INSERT INTO item_photos')) {
      return {
        run: () => {
          throw new Error('simulated insert failure');
        },
      } as unknown as ReturnType<typeof db.prepare>;
    }
    return realPrepare(sql);
  }) as typeof db.prepare);
}

/** Inserts one item_photos row for `itemId` and returns its id. */
export function insertPhotoRow(itemId: string, relativePath: string, sortOrder = 1): string {
  const photoId = uuidv4();
  db.prepare(
    'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
  ).run(photoId, itemId, relativePath, sortOrder, currentTenant().tenantId);
  return photoId;
}

export function seedThreePhotos(id: string): [string, string, string] {
  const insert = db.prepare(
    'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
  );
  const p1 = uuidv4();
  const p2 = uuidv4();
  const p3 = uuidv4();
  insert.run(p1, id, `${id}/p1.png`, 1, currentTenant().tenantId);
  insert.run(p2, id, `${id}/p2.png`, 2, currentTenant().tenantId);
  insert.run(p3, id, `${id}/p3.png`, 3, currentTenant().tenantId);
  return [p1, p2, p3];
}

export function resetPhotosState() {
  db.exec(
    'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
    'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
  );
  createdItemDirs.clear();
  activeTenant = createTestTenant();
}

// Best-effort cleanup of any per-item photo directories this test file
// created, since the route writes into the shared data/photos root
// rather than a test-scratch path.
export function removeCreatedPhotoDirs() {
  for (const id of createdItemDirs) {
    const dir = path.join(PHOTOS_ROOT, id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}
