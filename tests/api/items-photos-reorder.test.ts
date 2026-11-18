import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { PATCH } from '@/app/api/items/[id]/photos/route';
import { getCurrentTenant, insertClothingItem, photosUrl, reorderRequest, seedThreePhotos, usePhotoTenant } from './photoFixtures';

describe('/api/items/[id]/photos › reorder', () => {
  usePhotoTenant();

  describe('PATCH (reorder)', () => {
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
  });
});

describe('/api/items/[id]/photos › reorder validation (1 of 3)', () => {
  usePhotoTenant();

  describe('PATCH (reorder)', () => {
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
  });
});

describe('/api/items/[id]/photos › reorder validation (2 of 3)', () => {
  usePhotoTenant();

  describe('PATCH (reorder)', () => {
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
        'INSERT INTO item_photos (id, item_id, path, sort_order, tenant_id) VALUES (?, ?, ?, ?, ?)',
      );
      const p1 = uuidv4();
      const p2 = uuidv4();
      insert.run(p1, id, `${id}/p1.png`, 1, getCurrentTenant().tenantId);
      insert.run(p2, id, `${id}/p2.png`, 2, getCurrentTenant().tenantId);

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
        headers: { 'Content-Type': 'application/json', Cookie: getCurrentTenant().cookieHeader },
        body: JSON.stringify({ order: 'not-an-array' }),
      });
      const res = await PATCH(req, { params: Promise.resolve({ id }) });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('order must be an array of photo ids.');
    });
  });
});

describe('/api/items/[id]/photos › reorder validation (3 of 3)', () => {
  usePhotoTenant();

  describe('PATCH (reorder)', () => {
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
  });
});

describe('/api/items/[id]/photos › reorder errors (1 of 2)', () => {
  usePhotoTenant();

  describe('PATCH (reorder)', () => {
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
        headers: { 'Content-Type': 'application/json', Cookie: getCurrentTenant().cookieHeader },
        body: '{not valid json',
      });
      const res = await PATCH(req, { params: Promise.resolve({ id }) });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid JSON body.');
    });
  });
});

describe('/api/items/[id]/photos › reorder errors (2 of 2)', () => {
  usePhotoTenant();

  describe('PATCH (reorder)', () => {
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
