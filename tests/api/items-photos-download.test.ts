import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import db from '@/lib/db';
import { PHOTOS_ROOT } from '@/lib/photos';
import { GET } from '@/app/api/items/[id]/photos/[photoId]/route';
import { POST } from '@/app/api/items/[id]/photos/route';
import { TINY_PNG_BASE64, fileFromBytes, getCurrentTenant, getRequest, insertClothingItem, jpegBytes, tinyPngFile, uploadRequest, usePhotoTenant } from './photoFixtures';

describe('/api/items/[id]/photos/[photoId] (GET) › download (1 of 2)', () => {
  usePhotoTenant();

  it('GET on an uploaded PNG returns 200, the exact bytes, and Content-Type image/png', async () => {
    const id = insertClothingItem();
    const uploadRes = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
    const uploadBody = await uploadRes.json();
    const photoId = uploadBody.photos[0].id as string;

    const res = await GET(getRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes).toEqual(Buffer.from(TINY_PNG_BASE64, 'base64'));
  });

  it('GET on an uploaded JPEG returns Content-Type image/jpeg (.jpg extension mapping)', async () => {
    const id = insertClothingItem();
    const file = fileFromBytes(jpegBytes(), 'photo.jpg', 'image/jpeg');
    const uploadRes = await POST(uploadRequest(id, [file]), { params: Promise.resolve({ id }) });
    const uploadBody = await uploadRes.json();
    const photoId = uploadBody.photos[0].id as string;

    const res = await GET(getRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });
});

describe('/api/items/[id]/photos/[photoId] (GET) › download (2 of 2)', () => {
  usePhotoTenant();

  it('GET on a photo with an unrecognized extension falls back to application/octet-stream', async () => {
    // Bypasses the upload route (which only ever writes .jpg/.png/.webp) to
    // reach the CONTENT_TYPE_FOR_EXT[ext] ?? 'application/octet-stream'
    // fallback branch directly — write a real file with a made-up
    // extension and point a DB row at it.
    const id = insertClothingItem();
    const itemDir = path.join(PHOTOS_ROOT, id);
    fs.mkdirSync(itemDir, { recursive: true });
    const weirdBytes = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    fs.writeFileSync(path.join(itemDir, 'weird.xyz'), weirdBytes);
    const photoId = uuidv4();
    db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ).run(photoId, id, `${id}/weird.xyz`, 1, getCurrentTenant().tenantId);

    const res = await GET(getRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes).toEqual(weirdBytes);
  });
});

describe('/api/items/[id]/photos/[photoId] (GET) › download errors (1 of 3)', () => {
  usePhotoTenant();

  it('GET with a malformed (non-UUIDv4) item id returns 400', async () => {
    const res = await GET(getRequest('not-a-uuid', uuidv4()), {
      params: Promise.resolve({ id: 'not-a-uuid', photoId: uuidv4() }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid item id.');
  });

  it('GET on a non-existent photoId returns 404', async () => {
    const id = insertClothingItem();
    const missingPhotoId = uuidv4();
    const res = await GET(getRequest(id, missingPhotoId), {
      params: Promise.resolve({ id, photoId: missingPhotoId }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Photo not found.');
  });

  it('GET on a photoId belonging to a different item returns 404 (IDOR defense)', async () => {
    const idA = insertClothingItem();
    const idB = insertClothingItem();
    const photoId = uuidv4();
    db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ).run(photoId, idA, `${idA}/p1.png`, 1, getCurrentTenant().tenantId);

    const res = await GET(getRequest(idB, photoId), { params: Promise.resolve({ id: idB, photoId }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Photo not found.');
  });
});

describe('/api/items/[id]/photos/[photoId] (GET) › download errors (2 of 3)', () => {
  usePhotoTenant();

  it('a photo row whose stored path resolves outside the item directory 404s (defense-in-depth)', async () => {
    // itemDir must actually EXIST on disk for this to distinguish real code
    // from a mutant that skips the null-return: resolvePhotoPath would then
    // return itemDir itself (a real, existing directory), and
    // fs.readFileSync(directory) throws EISDIR (caught, but a NON-ENOENT
    // code -> rethrown -> 500) — a clearly different outcome than the real
    // code's immediate 404. If itemDir didn't exist, readFileSync would
    // throw ENOENT either way and the two code paths would be
    // indistinguishable from the response alone.
    const id = insertClothingItem();
    fs.mkdirSync(path.join(PHOTOS_ROOT, id), { recursive: true });
    const photoId = uuidv4();
    db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ).run(photoId, id, '', 1, getCurrentTenant().tenantId);

    const res = await GET(getRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Photo not found.');
  });

  it('a DB row that points at a file missing from disk (drift) 404s instead of 500 (real ENOENT)', async () => {
    const id = insertClothingItem();
    const photoId = uuidv4();
    // Row exists, but no file was ever written for it — a genuine ENOENT
    // on fs.readFileSync, no mocking required.
    db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ).run(photoId, id, `${id}/does-not-exist-on-disk.png`, 1, getCurrentTenant().tenantId);

    const res = await GET(getRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Photo not found.');
  });
});

describe('/api/items/[id]/photos/[photoId] (GET) › download errors (3 of 3)', () => {
  usePhotoTenant();

  it('a non-ENOENT read error is not swallowed — it is logged and returns 500', async () => {
    const id = insertClothingItem();
    const uploadRes = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
    const uploadBody = await uploadRes.json();
    const photoId = uploadBody.photos[0].id as string;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });

    try {
      const res = await GET(getRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Internal server error.');
      expect(errSpy).toHaveBeenCalledWith(
        'GET /api/items/[id]/photos/[photoId] error:',
        expect.any(Error),
      );
    } finally {
      readSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
