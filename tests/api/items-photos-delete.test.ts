import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import db from '@/lib/db';
import { PHOTOS_ROOT } from '@/lib/photos';
import { DELETE } from '@/app/api/items/[id]/photos/[photoId]/route';
import { POST } from '@/app/api/items/[id]/photos/route';
import { deleteRequest, getCurrentTenant, insertClothingItem, tinyPngFile, uploadRequest, usePhotoTenant } from './photoFixtures';

describe('/api/items/[id]/photos/[photoId] (DELETE) › delete (1 of 3)', () => {
  usePhotoTenant();

  it('delete removes the row and compacts remaining sort_order; response reflects the change', async () => {
    const id = insertClothingItem();
    const insert = db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
    );
    const p1 = uuidv4();
    const p2 = uuidv4();
    const p3 = uuidv4();
    insert.run(p1, id, `${id}/p1.png`, 1, getCurrentTenant().tenantId);
    insert.run(p2, id, `${id}/p2.png`, 2, getCurrentTenant().tenantId);
    insert.run(p3, id, `${id}/p3.png`, 3, getCurrentTenant().tenantId);

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
});

describe('/api/items/[id]/photos/[photoId] (DELETE) › delete (2 of 3)', () => {
  usePhotoTenant();

  it('delete only issues an UPDATE for rows whose sort_order actually changed, not for every remaining row', async () => {
    // A no-op `UPDATE ... SET sort_order = <same value>` is indistinguishable
    // from skipping it by re-querying the final value alone (both leave the
    // row at 1) — the `if (row.sort_order !== newSortOrder)` guard has to be
    // verified by counting actual UPDATE statement executions instead.
    const id = insertClothingItem();
    const insert = db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
    );
    const p1 = uuidv4();
    const p2 = uuidv4();
    const p3 = uuidv4();
    insert.run(p1, id, `${id}/p1.png`, 1, getCurrentTenant().tenantId);
    insert.run(p2, id, `${id}/p2.png`, 2, getCurrentTenant().tenantId);
    insert.run(p3, id, `${id}/p3.png`, 3, getCurrentTenant().tenantId);

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
});

describe('/api/items/[id]/photos/[photoId] (DELETE) › delete (3 of 3)', () => {
  usePhotoTenant();

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
});

describe('/api/items/[id]/photos/[photoId] (DELETE) › delete errors (1 of 2)', () => {
  usePhotoTenant();

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
      'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ).run(photoId, idA, `${idA}/p1.png`, 1, getCurrentTenant().tenantId);

    // Attempt to delete idA's photo while scoped under idB.
    const res = await DELETE(deleteRequest(idB, photoId), { params: Promise.resolve({ id: idB, photoId }) });
    expect(res.status).toBe(404);

    // Row must still exist under idA, untouched.
    const row = db.prepare('SELECT id FROM item_photos WHERE id = ?').get(photoId);
    expect(row).toBeTruthy();
  });
});

describe('/api/items/[id]/photos/[photoId] (DELETE) › delete errors (2 of 2)', () => {
  usePhotoTenant();

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
      'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ).run(photoId, id, `${id}/only.png`, 1, getCurrentTenant().tenantId);

    const res = await DELETE(deleteRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.photos).toEqual([]);
  });
});

describe('/api/items/[id]/photos/[photoId] (DELETE) › delete file handling (1 of 4)', () => {
  usePhotoTenant();

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
      'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ).run(photoId, id, '', 1, getCurrentTenant().tenantId);
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
});

describe('/api/items/[id]/photos/[photoId] (DELETE) › delete file handling (2 of 4)', () => {
  usePhotoTenant();

  it('an ENOENT (already-missing file) on unlink is tolerated silently — no error logged', async () => {
    const id = insertClothingItem();
    const photoId = uuidv4();
    // Row references a file that was never actually written to disk —
    // fs.unlinkSync will genuinely throw ENOENT.
    db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ).run(photoId, id, `${id}/never-written.png`, 1, getCurrentTenant().tenantId);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await DELETE(deleteRequest(id, photoId), { params: Promise.resolve({ id, photoId }) });
      expect(res.status).toBe(200);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('/api/items/[id]/photos/[photoId] (DELETE) › delete file handling (3 of 4)', () => {
  usePhotoTenant();

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
});

describe('/api/items/[id]/photos/[photoId] (DELETE) › delete file handling (4 of 4)', () => {
  usePhotoTenant();

  it('an unexpected error during the delete transaction is caught and returns 500', async () => {
    const id = insertClothingItem();
    const photoId = uuidv4();
    db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ).run(photoId, id, `${id}/p1.png`, 1, getCurrentTenant().tenantId);

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
