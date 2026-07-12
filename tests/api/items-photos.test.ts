import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import db from '@/lib/db';
import { PHOTOS_ROOT } from '@/lib/photos';
import { POST, PATCH } from '@/app/api/items/[id]/photos/route';
import { GET, DELETE } from '@/app/api/items/[id]/photos/[photoId]/route';

// The 'uuid' package's ESM export can't be `vi.spyOn`'d directly ("Module
// namespace is not configurable in ESM"), but its module resolution CAN be
// intercepted via vi.mock — wrapping the real v4 in a vi.fn by default so
// every other call in this file (id generation for test fixtures, the
// route's own internal uuidv4() calls) behaves exactly as before. Only the
// one test that needs to force a specific uuidv4() return value opts in via
// vi.mocked(uuidv4).mockReturnValueOnce(...).
vi.mock('uuid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('uuid')>();
  return { ...actual, v4: vi.fn(actual.v4) };
});

// Mirrors MAX_PHOTO_SIZE in app/api/items/[id]/photos/route.ts (not exported).
const MAX_PHOTO_SIZE_BYTES = 10 * 1024 * 1024;

// Minimal valid 1x1 transparent PNG — same fixture used by tests/e2e/photo-upload.spec.ts.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function tinyPngFile(name = 'photo.png'): File {
  const bytes = Buffer.from(TINY_PNG_BASE64, 'base64');
  return new File([bytes], name, { type: 'image/png' });
}

function notAnImageFile(name = 'not-image.png'): File {
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
function jpegBytes(corrupt?: { index: 0 | 1 | 2; value: number }): Buffer {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
  if (corrupt) bytes[corrupt.index] = corrupt.value;
  return bytes;
}

function pngBytes(corrupt?: { index: 0 | 1 | 2 | 3; value: number }): Buffer {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  if (corrupt) bytes[corrupt.index] = corrupt.value;
  return bytes;
}

// Exactly 12 bytes — the WEBP magic-byte boundary (bytes.length >= 12).
// RIFF....WEBP: bytes 0-3 "RIFF", bytes 4-7 arbitrary (chunk size), bytes
// 8-11 "WEBP".
function webpBytes(corrupt?: { index: 0 | 1 | 2 | 3 | 8 | 9 | 10 | 11; value: number }): Buffer {
  const bytes = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
  if (corrupt) bytes[corrupt.index] = corrupt.value;
  return bytes;
}

function fileFromBytes(bytes: Buffer, name: string, contentType: string): File {
  return new File([new Uint8Array(bytes)], name, { type: contentType });
}

function getRequest(id: string, photoId: string) {
  return new NextRequest(photoUrl(id, photoId), { method: 'GET' });
}

// PHOTOS_ROOT now comes from lib/photos.ts, which resolves via
// BOOKSELLER_PHOTOS_PATH — vitest.config.ts points this at a scratch
// directory for every test run, mirroring the BOOKSELLER_DB_PATH pattern.
// (Earlier finding: the route used to hardcode <process.cwd()>/data/photos
// with no override, which wrote real test files into the app's production
// photo directory — fixed at the source in lib/photos.ts, not just here.)
const createdItemDirs = new Set<string>();

function photosUrl(id: string) {
  return `http://localhost/api/items/${id}/photos`;
}
function photoUrl(id: string, photoId: string) {
  return `http://localhost/api/items/${id}/photos/${photoId}`;
}

function uploadRequest(id: string, files: File[]) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  return new NextRequest(photosUrl(id), { method: 'POST', body: fd });
}

function reorderRequest(id: string, order: string[]) {
  return new NextRequest(photosUrl(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order }),
  });
}

function deleteRequest(id: string, photoId: string) {
  return new NextRequest(photoUrl(id, photoId), { method: 'DELETE' });
}

function insertClothingItem(overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Test Clothing Item',
    acquisition_cost: 2000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    brand: 'TestBrand',
    size_label: 'M',
    condition: 'EUC',
  };
  const item = { ...defaults, ...overrides, id, category: 'clothing' };
  db.prepare(`
    INSERT INTO items
      (id, category, title, acquisition_cost, acquisition_date, status,
       listing_price, sale_price, sale_platform, sale_date)
    VALUES
      (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
       @listing_price, @sale_price, @sale_platform, @sale_date)
  `).run(item);
  db.prepare(`
    INSERT INTO clothing_details (item_id, brand, size_label, condition)
    VALUES (@id, @brand, @size_label, @condition)
  `).run(item);
  createdItemDirs.add(id);
  return id;
}

function insertBookItem(overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Test Book',
    acquisition_cost: 1000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    isbn: null,
    author: 'Test Author',
    publisher: 'Test Publisher',
    condition: 'Good',
  };
  const item = { ...defaults, ...overrides, id, category: 'book' };
  db.prepare(`
    INSERT INTO items
      (id, category, title, acquisition_cost, acquisition_date, status,
       listing_price, sale_price, sale_platform, sale_date)
    VALUES
      (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
       @listing_price, @sale_price, @sale_platform, @sale_date)
  `).run(item);
  db.prepare(`
    INSERT INTO book_details (item_id, isbn, author, publisher, condition)
    VALUES (@id, @isbn, @author, @publisher, @condition)
  `).run(item);
  createdItemDirs.add(id);
  return id;
}

describe('/api/items/[id]/photos', () => {
  beforeEach(() => {
    db.exec(
      'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
      'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
    );
    createdItemDirs.clear();
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

  // -------------------------------------------------------------------
  // POST (upload)
  // -------------------------------------------------------------------

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

    it('upload to a BOOK item is rejected 422 — photos are clothing-only per route logic', async () => {
      const id = insertBookItem();
      const res = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/not supported for category 'book'/);

      // Confirm no row was written for the rejected book upload.
      const count = db.prepare('SELECT COUNT(*) as cnt FROM item_photos WHERE item_id = ?').get(id) as {
        cnt: number;
      };
      expect(count.cnt).toBe(0);
    });

    it('no files provided returns 400', async () => {
      const id = insertClothingItem();
      const fd = new FormData();
      const req = new NextRequest(photosUrl(id), { method: 'POST', body: fd });
      const res = await POST(req, { params: Promise.resolve({ id }) });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/No files provided/);
    });

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

    it('a request whose Content-Type cannot be parsed as multipart form data returns 400', async () => {
      const id = insertClothingItem();
      const req = new NextRequest(photosUrl(id), {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data' }, // no boundary= param
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
      const req = new NextRequest(photosUrl(id), { method: 'POST', body: fd });
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

    it('a DB insert failure after a file was written to disk cleans up the orphaned file and returns 500', async () => {
      const id = insertClothingItem();

      const written: string[] = [];
      const realWriteFileSync = fs.writeFileSync.bind(fs);
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((
        ...args: Parameters<typeof fs.writeFileSync>
      ) => {
        written.push(args[0] as string);
        return realWriteFileSync(...args);
      }) as typeof fs.writeFileSync);

      // Force the row insert (which happens AFTER the file write, per the
      // route's own write-then-insert-row comment) to fail, without needing
      // to predict any server-generated uuid. db.prepare is spy-able (a
      // real object method); the 'uuid' package's ESM export is not
      // (Vitest: "Module namespace is not configurable in ESM").
      const realPrepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
        if (sql.includes('INSERT INTO item_photos')) {
          return {
            run: () => {
              throw new Error('simulated insert failure');
            },
          } as unknown as ReturnType<typeof db.prepare>;
        }
        return realPrepare(sql);
      }) as typeof db.prepare);

      try {
        const res = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toBe('Internal server error.');
      } finally {
        prepareSpy.mockRestore();
        writeSpy.mockRestore();
      }

      // The file this failed attempt wrote must have been cleaned up
      // (best-effort unlink in the catch block), not left orphaned.
      expect(written).toHaveLength(1);
      expect(fs.existsSync(written[0])).toBe(false);

      // No row was left behind for this item either.
      const count = db.prepare('SELECT COUNT(*) as cnt FROM item_photos WHERE item_id = ?').get(id) as {
        cnt: number;
      };
      expect(count.cnt).toBe(0);
    });

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
      const safeId = uuidv4();
      const uuidMock = vi.mocked(uuidv4) as unknown as {
        mockReturnValueOnce: (v: string) => unknown;
      };
      uuidMock.mockReturnValueOnce(safeId);
      uuidMock.mockReturnValueOnce('../../escaped');

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
      const count = db.prepare('SELECT COUNT(*) as cnt FROM item_photos WHERE item_id = ?').get(id) as {
        cnt: number;
      };
      expect(count.cnt).toBe(0);
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

    it('exceeding MAX_PHOTOS_PER_ITEM (20) is rejected, 422', async () => {
      const id = insertClothingItem();
      // Seed 20 existing photo rows directly (cheaper than 20 real uploads).
      const insert = db.prepare(
        'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
      );
      for (let i = 1; i <= 20; i++) {
        insert.run(uuidv4(), id, `${id}/existing-${i}.png`, i);
      }
      const res = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/Photo limit exceeded/);
    });

    it('upload exactly filling the 20-photo cap succeeds', async () => {
      const id = insertClothingItem();
      const insert = db.prepare(
        'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
      );
      for (let i = 1; i <= 19; i++) {
        insert.run(uuidv4(), id, `${id}/existing-${i}.png`, i);
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

  // -------------------------------------------------------------------
  // PATCH (reorder — full-array reassignment of sort_order)
  // -------------------------------------------------------------------

  describe('PATCH (reorder)', () => {
    function seedThreePhotos(id: string): [string, string, string] {
      const insert = db.prepare(
        'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
      );
      const p1 = uuidv4();
      const p2 = uuidv4();
      const p3 = uuidv4();
      insert.run(p1, id, `${id}/p1.png`, 1);
      insert.run(p2, id, `${id}/p2.png`, 2);
      insert.run(p3, id, `${id}/p3.png`, 3);
      return [p1, p2, p3];
    }

    it('reordering with a full valid permutation updates sort_order accordingly', async () => {
      const id = insertClothingItem();
      const [p1, p2, p3] = seedThreePhotos(id);

      // Move the last photo to the front (boundary: last -> first).
      const res = await PATCH(reorderRequest(id, [p3, p1, p2]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.photos.map((p: { id: string }) => p.id)).toEqual([p3, p1, p2]);
      expect(body.photos.map((p: { sort_order: number }) => p.sort_order)).toEqual([1, 2, 3]);
    });

    it('moving the first photo up (swap positions 1 and 2) reorders correctly', async () => {
      const id = insertClothingItem();
      const [p1, p2, p3] = seedThreePhotos(id);
      const res = await PATCH(reorderRequest(id, [p2, p1, p3]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.photos.map((p: { id: string }) => p.id)).toEqual([p2, p1, p3]);
      const row1 = db.prepare('SELECT sort_order FROM item_photos WHERE id = ?').get(p1) as {
        sort_order: number;
      };
      const row2 = db.prepare('SELECT sort_order FROM item_photos WHERE id = ?').get(p2) as {
        sort_order: number;
      };
      expect(row2.sort_order).toBe(1);
      expect(row1.sort_order).toBe(2);
    });

    it('moving the last photo down (to the end, no-op on last element) keeps it last', async () => {
      const id = insertClothingItem();
      const [p1, p2, p3] = seedThreePhotos(id);
      const res = await PATCH(reorderRequest(id, [p1, p2, p3]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.photos.map((p: { id: string }) => p.id)).toEqual([p1, p2, p3]);
      const row3 = db.prepare('SELECT sort_order FROM item_photos WHERE id = ?').get(p3) as {
        sort_order: number;
      };
      expect(row3.sort_order).toBe(3);
    });

    it('order missing an existing photo id is rejected, 422, and no rows change', async () => {
      const id = insertClothingItem();
      const [p1, p2] = seedThreePhotos(id);
      const res = await PATCH(reorderRequest(id, [p1, p2]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/order must include every existing photo id exactly once/);
    });

    it('order containing an unknown photo id is rejected, 422', async () => {
      const id = insertClothingItem();
      const [p1, p2, p3] = seedThreePhotos(id);
      const res = await PATCH(reorderRequest(id, [p1, p2, p3, uuidv4()]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
    });

    it('order with a duplicate id is rejected, 422', async () => {
      const id = insertClothingItem();
      const [p1, p2, p3] = seedThreePhotos(id);
      const res = await PATCH(reorderRequest(id, [p1, p1, p2]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
      void p3;
    });

    it('a duplicate id that keeps the dedup-set size equal to currentIds.size is still rejected, 422', async () => {
      // Isolates `orderSet.size === orderIds.length` from the OTHER size
      // check (`orderSet.size === currentIds.size`): with only 2 current
      // photos and order = [p1, p1, p2], orderIds.length is 3 but the
      // dedup'd orderSet is {p1, p2} — size 2, which DOES equal
      // currentIds.size (2). Only the length check catches this; if it
      // were forced to `true`, the (bogus) duplicate order would be wrongly
      // accepted and p1 would end up re-assigned sort_order 2 (from the
      // second occurrence), leaving nothing at sort_order 1.
      const id = insertClothingItem();
      const insert = db.prepare(
        'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
      );
      const p1 = uuidv4();
      const p2 = uuidv4();
      insert.run(p1, id, `${id}/p1.png`, 1);
      insert.run(p2, id, `${id}/p2.png`, 2);

      const res = await PATCH(reorderRequest(id, [p1, p1, p2]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe('order must include every existing photo id exactly once.');

      const row1 = db.prepare('SELECT sort_order FROM item_photos WHERE id = ?').get(p1) as {
        sort_order: number;
      };
      expect(row1.sort_order).toBe(1);
    });

    it('order that is not an array of strings is rejected, 400', async () => {
      const id = insertClothingItem();
      seedThreePhotos(id);
      const req = new NextRequest(photosUrl(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: 'not-an-array' }),
      });
      const res = await PATCH(req, { params: Promise.resolve({ id }) });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('order must be an array of photo ids.');
    });

    it('order that is the correct size but swaps in an id not belonging to this item is rejected, 422', async () => {
      // Same length, same dedup-set size as currentIds — isolates the
      // `[...orderSet].every((pid) => currentIds.has(pid))` check from the
      // size-mismatch checks that already reject the "missing"/"unknown +
      // extra element" test cases above.
      const id = insertClothingItem();
      const [p1, p2] = seedThreePhotos(id);
      const foreignId = uuidv4();
      const res = await PATCH(reorderRequest(id, [p1, p2, foreignId]), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe('order must include every existing photo id exactly once.');

      // No sort_order should have been touched by the rejected reorder.
      const row1 = db.prepare('SELECT sort_order FROM item_photos WHERE id = ?').get(p1) as {
        sort_order: number;
      };
      expect(row1.sort_order).toBe(1);
    });

    it('reordering photos for a non-existent item returns 404', async () => {
      const id = uuidv4();
      const res = await PATCH(reorderRequest(id, []), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Not found.');
    });

    it('reordering with a malformed (non-UUIDv4) item id returns 400 before any DB lookup', async () => {
      const res = await PATCH(reorderRequest('not-a-uuid', []), {
        params: Promise.resolve({ id: 'not-a-uuid' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid item id.');
    });

    it('malformed JSON body on PATCH returns 400', async () => {
      const id = insertClothingItem();
      const req = new NextRequest(photosUrl(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
      });
      const res = await PATCH(req, { params: Promise.resolve({ id }) });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid JSON body.');
    });

    it('an unexpected error during the reorder transaction is caught and returns 500', async () => {
      const id = insertClothingItem();
      seedThreePhotos(id);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const txnSpy = vi.spyOn(db, 'transaction').mockReturnValueOnce((() => {
        throw new Error('simulated transaction failure');
      }) as unknown as ReturnType<typeof db.transaction>);
      try {
        const res = await PATCH(reorderRequest(id, []), { params: Promise.resolve({ id }) });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toBe('Internal server error.');
        expect(errSpy).toHaveBeenCalledWith(
          'PATCH /api/items/[id]/photos error:',
          expect.any(Error),
        );
      } finally {
        txnSpy.mockRestore();
        errSpy.mockRestore();
      }
    });
  });
});

describe('/api/items/[id]/photos/[photoId] (DELETE)', () => {
  beforeEach(() => {
    db.exec(
      'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
      'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
    );
    createdItemDirs.clear();
  });

  afterEach(() => {
    for (const id of createdItemDirs) {
      const dir = path.join(PHOTOS_ROOT, id);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  it('delete removes the row and compacts remaining sort_order; response reflects the change', async () => {
    const id = insertClothingItem();
    const insert = db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
    );
    const p1 = uuidv4();
    const p2 = uuidv4();
    const p3 = uuidv4();
    insert.run(p1, id, `${id}/p1.png`, 1);
    insert.run(p2, id, `${id}/p2.png`, 2);
    insert.run(p3, id, `${id}/p3.png`, 3);

    const res = await DELETE(deleteRequest(id, p2), { params: Promise.resolve({ id, photoId: p2 }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.photos.map((p: { id: string }) => p.id)).toEqual([p1, p3]);
    expect(body.photos.map((p: { sort_order: number }) => p.sort_order)).toEqual([1, 2]);

    const remaining = db.prepare('SELECT id FROM item_photos WHERE item_id = ?').all(id) as {
      id: string;
    }[];
    expect(remaining.map((r) => r.id).sort()).toEqual([p1, p3].sort());

    // The response's `remaining` array is built from an in-memory `rows`
    // array whose sort_order fields get overwritten unconditionally after
    // the `if (row.sort_order !== newSortOrder)` check — so asserting on
    // body.photos above passes even if the actual DB UPDATE never ran.
    // Re-query the DB directly to confirm p3's sort_order (3 -> 2) was
    // actually persisted, not just reflected in the JSON response.
    const p3Row = db.prepare('SELECT sort_order FROM item_photos WHERE id = ?').get(p3) as {
      sort_order: number;
    };
    expect(p3Row.sort_order).toBe(2);
    // p1 already had sort_order 1 == its newSortOrder (1), so the UPDATE is
    // skipped for it — confirms the boundary on the other side of `!==`.
    const p1Row = db.prepare('SELECT sort_order FROM item_photos WHERE id = ?').get(p1) as {
      sort_order: number;
    };
    expect(p1Row.sort_order).toBe(1);
  });

  it('delete only issues an UPDATE for rows whose sort_order actually changed, not for every remaining row', async () => {
    // A no-op `UPDATE ... SET sort_order = <same value>` is indistinguishable
    // from skipping it by re-querying the final value alone (both leave the
    // row at 1) — the `if (row.sort_order !== newSortOrder)` guard has to be
    // verified by counting actual UPDATE statement executions instead.
    const id = insertClothingItem();
    const insert = db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
    );
    const p1 = uuidv4();
    const p2 = uuidv4();
    const p3 = uuidv4();
    insert.run(p1, id, `${id}/p1.png`, 1);
    insert.run(p2, id, `${id}/p2.png`, 2);
    insert.run(p3, id, `${id}/p3.png`, 3);

    let updateCalls = 0;
    const realPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql.startsWith('UPDATE item_photos SET sort_order')) {
        const realRun = stmt.run.bind(stmt);
        return {
          run: (...args: unknown[]) => {
            updateCalls++;
            return (realRun as (...a: unknown[]) => unknown)(...args);
          },
        } as unknown as ReturnType<typeof db.prepare>;
      }
      return stmt;
    }) as typeof db.prepare);

    try {
      // Deleting p2 (middle) leaves p1 (already sort_order 1, needs no
      // UPDATE) and p3 (sort_order 3 -> 2, needs exactly one UPDATE) — so
      // exactly 1 UPDATE call is correct, not 2.
      const res = await DELETE(deleteRequest(id, p2), { params: Promise.resolve({ id, photoId: p2 }) });
      expect(res.status).toBe(200);
    } finally {
      prepareSpy.mockRestore();
    }

    expect(updateCalls).toBe(1);
  });

  it('delete removes the file from disk', async () => {
    const id = insertClothingItem();
    const uploadRes = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
    const uploadBody = await uploadRes.json();
    const photoId = uploadBody.photos[0].id as string;
    const relPath = uploadBody.photos[0].path as string;
    const fullPath = path.join(PHOTOS_ROOT, relPath);
    expect(fs.existsSync(fullPath)).toBe(true);

    const res = await DELETE(deleteRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
    expect(res.status).toBe(200);
    expect(fs.existsSync(fullPath)).toBe(false);
  });

  it('deleting a non-existent photoId returns 404', async () => {
    const id = insertClothingItem();
    const missingPhotoId = uuidv4();
    const res = await DELETE(deleteRequest(id, missingPhotoId), {
      params: Promise.resolve({ id, photoId: missingPhotoId }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/Photo not found/);
  });

  it('deleting a photoId that belongs to a different item returns 404 (IDOR defense)', async () => {
    const idA = insertClothingItem();
    const idB = insertClothingItem();
    const photoId = uuidv4();
    db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
    ).run(photoId, idA, `${idA}/p1.png`, 1);

    // Attempt to delete idA's photo while scoped under idB.
    const res = await DELETE(deleteRequest(idB, photoId), { params: Promise.resolve({ id: idB, photoId }) });
    expect(res.status).toBe(404);

    // Row must still exist under idA, untouched.
    const row = db.prepare('SELECT id FROM item_photos WHERE id = ?').get(photoId);
    expect(row).toBeTruthy();
  });

  it('deleting with a malformed (non-UUIDv4) item id returns 400', async () => {
    const res = await DELETE(deleteRequest('not-a-uuid', uuidv4()), {
      params: Promise.resolve({ id: 'not-a-uuid', photoId: uuidv4() }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid item id.');
  });

  it('deleting the only photo leaves an empty photos array', async () => {
    const id = insertClothingItem();
    const photoId = uuidv4();
    db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
    ).run(photoId, id, `${id}/only.png`, 1);

    const res = await DELETE(deleteRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.photos).toEqual([]);
  });

  it('a photo row whose stored path resolves outside the item directory 404s (defense-in-depth)', async () => {
    // path.basename('') === '' -> path.join(itemDir, '') resolves to
    // itemDir itself, which does NOT start with `itemDir + path.sep` -
    // resolvePhotoPath returns null. Exercises the containment check that
    // guards every filesystem operation, via a deliberately malformed
    // (but DB-plausible) stored path.
    //
    // itemDir is created for real (not left absent) so that a mutant which
    // skips the null-return would hit a REAL, EXISTING directory (EISDIR on
    // unlink) rather than a merely-absent path (ENOENT) — absent and
    // "exists but is a directory" both ultimately no-op/tolerate on this
    // DELETE path, so the only way to observe the difference is whether
    // fs.unlinkSync (and thus console.error, for the non-ENOENT case) is
    // invoked at all.
    const id = insertClothingItem();
    fs.mkdirSync(path.join(PHOTOS_ROOT, id), { recursive: true });
    const photoId = uuidv4();
    db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
    ).run(photoId, id, '', 1);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await DELETE(deleteRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
      // targetPath is null, so DELETE skips the unlink entirely but still
      // succeeds in removing the DB row (unlink is best-effort / guarded by
      // `if (targetPath)`) — and never touches the filesystem, so no error
      // is ever logged.
      expect(res.status).toBe(200);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
    const remaining = db.prepare('SELECT id FROM item_photos WHERE id = ?').get(photoId);
    expect(remaining).toBeUndefined();
  });

  it('an ENOENT (already-missing file) on unlink is tolerated silently — no error logged', async () => {
    const id = insertClothingItem();
    const photoId = uuidv4();
    // Row references a file that was never actually written to disk —
    // fs.unlinkSync will genuinely throw ENOENT.
    db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
    ).run(photoId, id, `${id}/never-written.png`, 1);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await DELETE(deleteRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
      expect(res.status).toBe(200);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('a non-ENOENT unlink error is tolerated but logged (request still succeeds, 200)', async () => {
    const id = insertClothingItem();
    const uploadRes = await POST(uploadRequest(id, [tinyPngFile()]), { params: Promise.resolve({ id }) });
    const uploadBody = await uploadRes.json();
    const photoId = uploadBody.photos[0].id as string;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });

    try {
      const res = await DELETE(deleteRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
      // Non-ENOENT unlink failures do not fail the request — the DB row is
      // already deleted, which is the source of truth.
      expect(res.status).toBe(200);
      expect(errSpy).toHaveBeenCalledWith(
        'DELETE /api/items/[id]/photos/[photoId] unlink error:',
        expect.any(Error),
      );
    } finally {
      unlinkSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('an unexpected error during the delete transaction is caught and returns 500', async () => {
    const id = insertClothingItem();
    const photoId = uuidv4();
    db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
    ).run(photoId, id, `${id}/p1.png`, 1);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const txnSpy = vi.spyOn(db, 'transaction').mockReturnValueOnce((() => {
      throw new Error('simulated transaction failure');
    }) as unknown as ReturnType<typeof db.transaction>);

    try {
      const res = await DELETE(deleteRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Internal server error.');
      expect(errSpy).toHaveBeenCalledWith(
        'DELETE /api/items/[id]/photos/[photoId] error:',
        expect.any(Error),
      );
    } finally {
      txnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('/api/items/[id]/photos/[photoId] (GET)', () => {
  beforeEach(() => {
    db.exec(
      'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
      'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
    );
    createdItemDirs.clear();
  });

  afterEach(() => {
    for (const id of createdItemDirs) {
      const dir = path.join(PHOTOS_ROOT, id);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

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
      'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
    ).run(photoId, id, `${id}/weird.xyz`, 1);

    const res = await GET(getRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes).toEqual(weirdBytes);
  });

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
      'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
    ).run(photoId, idA, `${idA}/p1.png`, 1);

    const res = await GET(getRequest(idB, photoId), { params: Promise.resolve({ id: idB, photoId }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Photo not found.');
  });

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
      'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
    ).run(photoId, id, '', 1);

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
      'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
    ).run(photoId, id, `${id}/does-not-exist-on-disk.png`, 1);

    const res = await GET(getRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Photo not found.');
  });

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
