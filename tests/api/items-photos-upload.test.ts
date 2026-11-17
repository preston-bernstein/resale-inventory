import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import db from '@/lib/db';
import { PHOTOS_ROOT } from '@/lib/photos';
import { POST } from '@/app/api/items/[id]/photos/route';
import { createToken } from '@/lib/pairingToken';
import { TINY_PNG_BASE64, fileFromBytes, getCurrentTenant, insertBookItem, insertClothingItem, jpegBytes, notAnImageFile, photoRowCount, photosUrl, pngBytes, tinyPngFile, uploadRequest, usePhotoTenant, webpBytes } from './photoFixtures';

vi.mock('uuid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('uuid')>();
  return { ...actual, v4: vi.fn(actual.v4) };
});

const MAX_PHOTO_SIZE_BYTES = 10 * 1024 * 1024;

function mockNextUuids(...ids: string[]) {
  const uuidMock = vi.mocked(uuidv4) as unknown as {
    mockReturnValueOnce: (v: string) => unknown;
  };
  for (const id of ids) {
    uuidMock.mockReturnValueOnce(id);
  }
}

function spyOnPhotoFileWrites() {
  const written: string[] = [];
  const realWriteFileSync = fs.writeFileSync.bind(fs);
  const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((
    ...args: Parameters<typeof fs.writeFileSync>
  ) => {
    written.push(args[0] as string);
    return realWriteFileSync(...args);
  }) as typeof fs.writeFileSync);
  return { written, spy };
}

function failPhotoRowInsert() {
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

describe('/api/items/[id]/photos › uploads', () => {
  usePhotoTenant();

  describe('POST (upload)', () => {
    it('successful upload returns the new photo(s) in the response, 201', async () => {
      const id = insertClothingItem();
      const res = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.photos).toHaveLength(1);
      expect(body.photos[0]).toMatchObject({ sort_order: 1 });
      expect(body.photos[0].id).toBeTruthy();
      expect(body.photos[0].path).toContain(id);

      const row = db.prepare('SELECT * FROM item_photos WHERE item_id = ?').get(id) as
        | { id: string; path: string; sort_order: number }
        | undefined;
      expect(row).toBeTruthy();
      expect(row!.sort_order).toBe(1);
    });

    it('assigns increasing sort_order across multiple files in one upload', async () => {
      const id = insertClothingItem();
      const res = await POST(
        uploadRequest(id, [tinyPngFile('a.png'), tinyPngFile('b.png'), tinyPngFile('c.png')]),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.photos).toHaveLength(3);
      expect(body.photos.map((p: { sort_order: number }) => p.sort_order)).toEqual([1, 2, 3]);
    });

    it('assigns continuing sort_order on a second upload after an existing photo', async () => {
      const id = insertClothingItem();
      await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
      const res2 = await POST(uploadRequest(id, [tinyPngFile('second.png')]), { params: Promise.resolve({ id }) });
      expect(res2.status).toBe(201);
      const body2 = await res2.json();
      expect(body2.photos).toHaveLength(2);
      expect(body2.photos.map((p: { sort_order: number }) => p.sort_order)).toEqual([1, 2]);
    });
  });
});

describe('/api/items/[id]/photos › upload errors (1 of 2)', () => {
  usePhotoTenant();

  describe('POST (upload)', () => {
    it('upload to a non-existent item returns 404', async () => {
      const id = uuidv4();
      const res = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/Not found/);
    });

    it('upload to a non-UUIDv4 item id returns 400 before any DB lookup', async () => {
      const res = await POST(uploadRequest('not-a-uuid', [tinyPngFile()]), {
        params: Promise.resolve({ id: 'not-a-uuid' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid item id/);
    });
  });
});

describe('/api/items/[id]/photos › upload errors (2 of 2)', () => {
  usePhotoTenant();

  describe('POST (upload)', () => {
    it('upload to a BOOK item is rejected 422 — photos are clothing-only per route logic', async () => {
      const id = insertBookItem();
      const res = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/not supported for category 'book'/);

      // Confirm no row was written for the rejected book upload.
      expect(photoRowCount(id)).toBe(0);
    });

    it('no files provided returns 400', async () => {
      const id = insertClothingItem();
      const fd = new FormData();
      const req = new NextRequest(photosUrl(id), {
        method: 'POST',
        body: fd,
        headers: { Cookie: getCurrentTenant().cookieHeader },
      });
      const res = await POST(req, { params: Promise.resolve({ id }) });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/No files provided/);
    });
  });
});

describe('/api/items/[id]/photos › type checks', () => {
  usePhotoTenant();

  describe('POST (upload)', () => {
    it('a file whose declared Content-Type is not an allowed image type is rejected, 422', async () => {
      const id = insertClothingItem();
      const bytes = Buffer.from(TINY_PNG_BASE64, 'base64');
      const file = new File([bytes], 'file.gif', { type: 'image/gif' });
      const res = await POST(uploadRequest(id, [file]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/not a valid image/);
    });

    it('a file with image/png content-type but bytes that fail the magic-byte sniff is rejected, 422', async () => {
      const id = insertClothingItem();
      const res = await POST(uploadRequest(id, [notAnImageFile()]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/not a valid image/);
    });
  });
});

describe('/api/items/[id]/photos › image sniffing (1 of 3)', () => {
  usePhotoTenant();

  describe('POST (upload)', () => {
    // -----------------------------------------------------------------
    // sniffImageType boundary tests — one "near miss" per required magic
    // byte (all OTHER required bytes correct, exactly one wrong) isolates
    // that byte's comparison. A chained `&&` only differs in outcome from
    // a mutant that turns one term into `true` (or flips `===`/`||`) when
    // every OTHER term in the chain is genuinely true — that's exactly
    // what these near-miss fixtures construct.
    // -----------------------------------------------------------------

    it('JPEG magic bytes (FF D8 FF) are accepted and produce a .jpg-mapped photo', async () => {
      const id = insertClothingItem();
      const file = fileFromBytes(jpegBytes(), 'photo.jpg', 'image/jpeg');
      const res = await POST(uploadRequest(id, [file]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.photos[0].path).toMatch(/\.jpg$/);
    });

    it('JPEG sniff rejects bytes with only byte[0] wrong (near miss)', async () => {
      const id = insertClothingItem();
      const file = fileFromBytes(jpegBytes({ index: 0, value: 0x00 }), 'photo.jpg', 'image/jpeg');
      const res = await POST(uploadRequest(id, [file]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe('File is not a valid image.');
    });

    it('JPEG sniff rejects bytes with only byte[1] wrong (near miss)', async () => {
      const id = insertClothingItem();
      const file = fileFromBytes(jpegBytes({ index: 1, value: 0x00 }), 'photo.jpg', 'image/jpeg');
      const res = await POST(uploadRequest(id, [file]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
    });
  });
});

describe('/api/items/[id]/photos › image sniffing (2 of 3)', () => {
  usePhotoTenant();

  describe('POST (upload)', () => {
    it('JPEG sniff rejects bytes with only byte[2] wrong (near miss)', async () => {
      const id = insertClothingItem();
      const file = fileFromBytes(jpegBytes({ index: 2, value: 0x00 }), 'photo.jpg', 'image/jpeg');
      const res = await POST(uploadRequest(id, [file]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
    });

    it('PNG sniff rejects bytes with only byte[0] wrong (near miss)', async () => {
      const id = insertClothingItem();
      const file = fileFromBytes(pngBytes({ index: 0, value: 0x00 }), 'photo.png', 'image/png');
      const res = await POST(uploadRequest(id, [file]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
    });

    it('PNG sniff rejects bytes with only byte[1] wrong (near miss)', async () => {
      const id = insertClothingItem();
      const file = fileFromBytes(pngBytes({ index: 1, value: 0x00 }), 'photo.png', 'image/png');
      const res = await POST(uploadRequest(id, [file]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
    });

    it('WEBP magic bytes (RIFF....WEBP, exactly 12 bytes — the length boundary) are accepted', async () => {
      const id = insertClothingItem();
      const file = fileFromBytes(webpBytes(), 'photo.webp', 'image/webp');
      const res = await POST(uploadRequest(id, [file]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.photos[0].path).toMatch(/\.webp$/);
    });
  });
});

describe('/api/items/[id]/photos › image sniffing (3 of 3)', () => {
  usePhotoTenant();

  describe('POST (upload)', () => {
    it.each([
      [0, 0x00],
      [1, 0x00],
      [2, 0x00],
      [3, 0x00],
      [8, 0x00],
      [9, 0x00],
      [10, 0x00],
      [11, 0x00],
    ] as const)('WEBP sniff rejects bytes with only byte[%i] wrong (near miss)', async (index, value) => {
      const id = insertClothingItem();
      const file = fileFromBytes(webpBytes({ index, value }), 'photo.webp', 'image/webp');
      const res = await POST(uploadRequest(id, [file]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe('File is not a valid image.');
    });
  });
});

describe('/api/items/[id]/photos › form parsing and size caps (1 of 2)', () => {
  usePhotoTenant();

  describe('POST (upload)', () => {
    it('a request whose Content-Type cannot be parsed as multipart form data returns 400', async () => {
      const id = insertClothingItem();
      const req = new NextRequest(photosUrl(id), {
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data', // no boundary= param
          Cookie: getCurrentTenant().cookieHeader,
        },
        body: 'this is not valid multipart body data',
      });
      const res = await POST(req, { params: Promise.resolve({ id }) });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid multipart form data.');
    });

    it('non-File entries under the "files" form field are filtered out, not treated as files', async () => {
      const id = insertClothingItem();
      const fd = new FormData();
      fd.append('files', 'this is a plain string value, not a File');
      fd.append('files', tinyPngFile());
      const req = new NextRequest(photosUrl(id), {
        method: 'POST',
        body: fd,
        headers: { Cookie: getCurrentTenant().cookieHeader },
      });
      const res = await POST(req, { params: Promise.resolve({ id }) });
      // If the `.filter((f): f is File => f instanceof File)` were removed,
      // the string entry would reach `file.type`/`file.size` and fail the
      // content-type check (undefined not in ALLOWED_CONTENT_TYPES),
      // rejecting the whole request. With the filter intact, only the real
      // PNG file is processed and the upload succeeds with exactly 1 photo.
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.photos).toHaveLength(1);
    });
  });
});

describe('/api/items/[id]/photos › form parsing and size caps (2 of 2)', () => {
  usePhotoTenant();

  describe('POST (upload)', () => {
    it('a file that reports a small .size but whose actual bytes exceed the cap is rejected, 413 (second size check)', async () => {
      const id = insertClothingItem();
      const bigBytes = Buffer.alloc(MAX_PHOTO_SIZE_BYTES + 1, 0);
      Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(bigBytes, 0);
      const file = new File([bigBytes], 'lied-about-size.png', { type: 'image/png' });
      // file.size is derived from the real content by the File constructor;
      // override it downward so the FIRST size check (file.size > MAX,
      // before the bytes are ever read) passes, isolating the SECOND check
      // (buffer.length > MAX, after `await file.arrayBuffer()`).
      Object.defineProperty(file, 'size', { value: 100 });
      const res = await POST(uploadRequest(id, [file]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(413);
      const text = await res.text();
      expect(text).toBe('File too large');
    });
  });
});

describe('/api/items/[id]/photos › upload failures (1 of 2)', () => {
  usePhotoTenant();

  describe('POST (upload)', () => {
    it('a DB insert failure after a file was written to disk cleans up the orphaned file and returns 500', async () => {
      const id = insertClothingItem();
      const writes = spyOnPhotoFileWrites();
      const prepareSpy = failPhotoRowInsert();

      try {
        const res = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toBe('Internal server error.');
      } finally {
        prepareSpy.mockRestore();
        writes.spy.mockRestore();
      }

      // The file this failed attempt wrote must have been cleaned up
      // (best-effort unlink in the catch block), not left orphaned.
      expect(writes.written).toHaveLength(1);
      expect(fs.existsSync(writes.written[0])).toBe(false);

      // No row was left behind for this item either.
      expect(photoRowCount(id)).toBe(0);
    });
  });
});

describe('/api/items/[id]/photos › upload failures (2 of 2)', () => {
  usePhotoTenant();

  describe('POST (upload)', () => {
    it('a server-generated filename that would resolve outside the item directory throws and 500s', async () => {
      // Forces the resolved-path containment check right before the file
      // write (mirrors resolvePhotoPath's own check) to actually trip, by
      // making the server-generated filename itself malicious — something
      // that can't happen in production (the filename comes from
      // uuidv4()+a fixed extension, never user input) but is exactly the
      // scenario this defense-in-depth check guards against.
      const id = insertClothingItem();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // First uuidv4() call is the DB row's `photoId` — irrelevant to the
      // escape, must stay a real id. Second call is the filename component
      // and is what needs to be malicious for the containment check to
      // trip.
      mockNextUuids(uuidv4(), '../../escaped');

      try {
        const res = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toBe('Internal server error.');
        expect(errSpy).toHaveBeenCalledWith('POST /api/items/[id]/photos error:', expect.any(Error));
      } finally {
        errSpy.mockRestore();
      }

      // No row should have been written for the failed attempt.
      expect(photoRowCount(id)).toBe(0);
    });

    it('a file over the 10MB cap is rejected, 413', async () => {
      const id = insertClothingItem();
      const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
      // Prefix with a valid PNG signature so a size-first implementation and
      // a sniff-first implementation both agree this is "too large", not
      // "not an image" — the route in fact checks file.size before reading
      // bytes, so this covers that branch precisely.
      Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(big, 0);
      const file = new File([big], 'huge.png', { type: 'image/png' });
      const res = await POST(uploadRequest(id, [file]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(413);
    });
  });
});

describe('/api/items/[id]/photos › photo cap', () => {
  usePhotoTenant();

  describe('POST (upload)', () => {
    it('exceeding MAX_PHOTOS_PER_ITEM (20) is rejected, 422', async () => {
      const id = insertClothingItem();
      // Seed 20 existing photo rows directly (cheaper than 20 real uploads).
      const insert = db.prepare(
        'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
      );
      for (let i = 1; i <= 20; i++) {
        insert.run(uuidv4(), id, `${id}/existing-${i}.png`, i, getCurrentTenant().tenantId);
      }
      const res = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/Photo limit exceeded/);
    });

    it('upload exactly filling the 20-photo cap succeeds', async () => {
      const id = insertClothingItem();
      const insert = db.prepare(
        'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
      );
      for (let i = 1; i <= 19; i++) {
        insert.run(uuidv4(), id, `${id}/existing-${i}.png`, i, getCurrentTenant().tenantId);
      }
      const res = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.photos).toHaveLength(20);
    });

    it('written file actually lands on disk under data/photos/<item_id>/', async () => {
      const id = insertClothingItem();
      const res = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
      const body = await res.json();
      const relPath = body.photos[0].path as string;
      const full = path.join(PHOTOS_ROOT, relPath);
      expect(fs.existsSync(full)).toBe(true);
    });
  });
});

describe('/api/items/[id]/photos › pairing tokens (1 of 3)', () => {
  usePhotoTenant();

  describe('POST (upload)', () => {
    // -----------------------------------------------------------------
    // X-Pairing-Token header (phone handoff). The header is OPTIONAL —
    // every existing test above sends no header at all and must keep
    // passing byte-for-byte unmodified, proving the no-header path is
    // untouched. These cases cover the new header-present branches only.
    // -----------------------------------------------------------------

    it('upload with a valid pairing token matching the item id succeeds, 201', async () => {
      const id = insertClothingItem();
      const { token } = createToken(id);
      const res = await POST(uploadRequest(id, [tinyPngFile()], { 'X-Pairing-Token': token }), {
        params: Promise.resolve({ id }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.photos).toHaveLength(1);

      const row = db.prepare('SELECT * FROM item_photos WHERE item_id = ?').get(id);
      expect(row).toBeTruthy();
    });

    it('upload with a malformed/unknown pairing token is rejected, 401, and no row is written', async () => {
      const id = insertClothingItem();
      const res = await POST(
        uploadRequest(id, [tinyPngFile()], { 'X-Pairing-Token': 'not-a-real-token' }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Invalid or expired pairing token.');

      expect(photoRowCount(id)).toBe(0);
    });
  });
});

describe('/api/items/[id]/photos › pairing tokens (2 of 3)', () => {
  usePhotoTenant();

  describe('POST (upload)', () => {
    it('upload with an expired pairing token is rejected, 401', async () => {
      const id = insertClothingItem();
      const { token } = createToken(id);
      // Force the freshly-created token into the past without needing to
      // wait out the real 15-minute TTL. The table has a CHECK constraint
      // (expires_at > created_at), so both must move together, with
      // expires_at still safely in the past relative to "now".
      db.prepare(
        'UPDATE phone_pairing_tokens SET created_at = ?, expires_at = ? WHERE item_id = ?',
      ).run(Date.now() - 10_000, Date.now() - 1000, id);
      const res = await POST(uploadRequest(id, [tinyPngFile()], { 'X-Pairing-Token': token }), {
        params: Promise.resolve({ id }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Invalid or expired pairing token.');
    });

    it('upload with a token that resolves but belongs to a different item is rejected, 401 (cross-item defense)', async () => {
      const idA = insertClothingItem();
      const idB = insertClothingItem();
      const { token } = createToken(idA);

      // Token is valid for idA but the request targets idB's URL.
      const res = await POST(uploadRequest(idB, [tinyPngFile()], { 'X-Pairing-Token': token }), {
        params: Promise.resolve({ id: idB }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Invalid or expired pairing token.');

      expect(photoRowCount(idB)).toBe(0);
    });
  });
});

describe('/api/items/[id]/photos › pairing tokens (3 of 3)', () => {
  usePhotoTenant();

  describe('POST (upload)', () => {
    it('upload with no X-Pairing-Token header behaves exactly as before (no regression)', async () => {
      const id = insertClothingItem();
      const res = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.photos).toHaveLength(1);
    });
  });
});
