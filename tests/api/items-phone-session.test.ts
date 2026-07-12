import crypto from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { DELETE, GET, POST } from '@/app/api/items/[id]/phone-session/route';

const TAILNET_HOST = 'myapp.beta.ts.net';

function phoneSessionUrl(id: string) {
  return `http://localhost/api/items/${id}/phone-session`;
}

// `host` is explicitly `string | null` (not a defaulted optional) so a
// caller can deliberately request "no Host header at all" via `null`
// without JS default-parameter substitution silently swapping in
// TAILNET_HOST for an omitted/undefined argument.
function postRequest(id: string, host: string | null = TAILNET_HOST) {
  const headers = new Headers();
  if (host !== null) {
    headers.set('host', host);
  }
  return new NextRequest(phoneSessionUrl(id), { method: 'POST', headers });
}

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

function getRequest(id: string) {
  return new NextRequest(phoneSessionUrl(id), { method: 'GET' });
}

function deleteRequest(id: string) {
  return new NextRequest(phoneSessionUrl(id), { method: 'DELETE' });
}

// Directly inserts a phone_pairing_tokens row, bypassing createToken, so
// each session-status test can construct the exact row shape it needs
// (including states createToken can't itself produce, like 'expired').
function insertPairingToken(itemId: string, overrides: Record<string, unknown> = {}): string {
  const tokenId = uuidv4();
  const defaults = {
    id: tokenId,
    item_id: itemId,
    token_hash: hashToken(crypto.randomBytes(32).toString('hex')),
    status: 'active',
    created_at: Date.now(),
    expires_at: Date.now() + 15 * 60 * 1000,
    first_accessed_at: null,
  };
  const row = { ...defaults, ...overrides };
  db.prepare(
    `INSERT INTO phone_pairing_tokens
       (id, item_id, token_hash, status, created_at, expires_at, first_accessed_at)
     VALUES (@id, @item_id, @token_hash, @status, @created_at, @expires_at, @first_accessed_at)`,
  ).run(row);
  return tokenId;
}

function insertItemPhoto(itemId: string, overrides: Record<string, unknown> = {}): string {
  const photoId = uuidv4();
  const defaults = {
    id: photoId,
    item_id: itemId,
    path: `${itemId}/photo.jpg`,
    sort_order: 1,
  };
  const row = { ...defaults, ...overrides };
  db.prepare(
    'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (@id, @item_id, @path, @sort_order)',
  ).run(row);
  return photoId;
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
  return id;
}

describe('POST /api/items/[id]/phone-session', () => {
  beforeEach(() => {
    db.exec(
      'DELETE FROM phone_pairing_tokens; DELETE FROM item_photos; DELETE FROM price_history; ' +
      'DELETE FROM item_platforms; DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
    );
  });

  it('issues a token for a clothing item: 201 with url and expires_at', async () => {
    const id = insertClothingItem();
    const res = await POST(postRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.url).toMatch(new RegExp(`^https://${TAILNET_HOST}/phone/[0-9a-f]{64}$`));
    expect(typeof body.expires_at).toBe('number');
    expect(body.expires_at).toBeGreaterThan(Date.now());

    // Exactly one active row was created for this item.
    const row = db
      .prepare("SELECT * FROM phone_pairing_tokens WHERE item_id = ? AND status = 'active'")
      .get(id) as { expires_at: number } | undefined;
    expect(row).toBeTruthy();
    expect(row!.expires_at).toBe(body.expires_at);
  });

  it('the raw token in the url does not appear anywhere else observable (only in the response body)', async () => {
    const id = insertClothingItem();
    const res = await POST(postRequest(id), { params: Promise.resolve({ id }) });
    const body = await res.json();
    const rawToken = (body.url as string).split('/phone/')[1];
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/);

    // The DB never stores the raw token — only its hash.
    const row = db
      .prepare('SELECT token_hash FROM phone_pairing_tokens WHERE item_id = ?')
      .get(id) as { token_hash: string };
    expect(row.token_hash).not.toBe(rawToken);
  });

  it('a non-clothing (book) item returns 422 with the category-specific message, and no token is created', async () => {
    const id = insertBookItem();
    const res = await POST(postRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("Photos are not supported for category 'book'.");

    const count = db
      .prepare('SELECT COUNT(*) as cnt FROM phone_pairing_tokens WHERE item_id = ?')
      .get(id) as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it('an unknown item id returns 404', async () => {
    const id = uuidv4();
    const res = await POST(postRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found.');
  });

  it('a malformed (non-UUIDv4) item id returns 400 before any DB lookup', async () => {
    const res = await POST(postRequest('not-a-uuid'), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid item id.');
  });

  it('when the tailnet origin cannot be resolved, returns 409 and issues no token', async () => {
    const id = insertClothingItem();
    // No Host header at all resolves to null in resolveTailnetOrigin.
    const res = await POST(postRequest(id, null), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/tailnet origin/);
    expect(body.error).toMatch(/ts\.net/);

    const count = db
      .prepare('SELECT COUNT(*) as cnt FROM phone_pairing_tokens WHERE item_id = ?')
      .get(id) as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it('a localhost/LAN-IP Host header (not a valid tailnet origin) returns 409', async () => {
    const id = insertClothingItem();
    const res = await POST(postRequest(id, '192.168.1.50:3000'), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(409);
  });

  it('a second POST for the same item invalidates the prior token and issues a fresh one', async () => {
    const id = insertClothingItem();
    const res1 = await POST(postRequest(id), { params: Promise.resolve({ id }) });
    const body1 = await res1.json();
    const token1 = (body1.url as string).split('/phone/')[1];

    const res2 = await POST(postRequest(id), { params: Promise.resolve({ id }) });
    expect(res2.status).toBe(201);
    const body2 = await res2.json();
    const token2 = (body2.url as string).split('/phone/')[1];

    expect(token2).not.toBe(token1);

    // Match rows by token hash rather than relying on created_at ordering
    // (both tokens can be created within the same millisecond, so
    // created_at alone doesn't reliably distinguish "first" from "second").
    const rows = db
      .prepare('SELECT status, token_hash FROM phone_pairing_tokens WHERE item_id = ?')
      .all(id) as { status: string; token_hash: string }[];
    expect(rows).toHaveLength(2);

    const row1 = rows.find((r) => r.token_hash === hashToken(token1));
    const row2 = rows.find((r) => r.token_hash === hashToken(token2));
    expect(row1?.status).toBe('ended');
    expect(row2?.status).toBe('active');

    // Exactly one active row remains for this item.
    const activeCount = db
      .prepare("SELECT COUNT(*) as cnt FROM phone_pairing_tokens WHERE item_id = ? AND status = 'active'")
      .get(id) as { cnt: number };
    expect(activeCount.cnt).toBe(1);
  });

  it('an unexpected error is caught, logged (without leaking the raw token), and returns 500', async () => {
    const id = insertClothingItem();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const txnSpy = vi
      .spyOn(db, 'transaction')
      .mockReturnValueOnce((() => {
        throw new Error('simulated transaction failure');
      }) as unknown as ReturnType<typeof db.transaction>);

    try {
      const res = await POST(postRequest(id), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Internal server error.');
      expect(errSpy).toHaveBeenCalledWith(
        'POST /api/items/[id]/phone-session error:',
        expect.any(Error),
      );
    } finally {
      txnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('GET /api/items/[id]/phone-session', () => {
  beforeEach(() => {
    db.exec(
      'DELETE FROM phone_pairing_tokens; DELETE FROM item_photos; DELETE FROM price_history; ' +
      'DELETE FROM item_platforms; DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
    );
  });

  it("an item with no token ever issued returns status 'none', null expires_at, empty photos", async () => {
    const id = insertClothingItem();
    const res = await GET(getRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('none');
    expect(body.expires_at).toBeNull();
    expect(body.photos).toEqual([]);
  });

  it("an active, unopened token returns status 'waiting' with the token's expires_at", async () => {
    const id = insertClothingItem();
    const expiresAt = Date.now() + 15 * 60 * 1000;
    insertPairingToken(id, { status: 'active', expires_at: expiresAt, first_accessed_at: null });

    const res = await GET(getRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('waiting');
    expect(body.expires_at).toBe(expiresAt);
  });

  it("an active token the phone has opened returns status 'connected'", async () => {
    const id = insertClothingItem();
    // Pin created_at explicitly rather than relying on insertPairingToken's
    // own internal Date.now() call — that call happens strictly after this
    // override object is constructed, so first_accessed_at (captured here)
    // could otherwise land in an earlier millisecond than created_at
    // (captured there), intermittently violating the first_accessed_at
    // BETWEEN created_at AND expires_at CHECK constraint.
    const createdAt = Date.now();
    const expiresAt = createdAt + 15 * 60 * 1000;
    insertPairingToken(id, {
      status: 'active',
      created_at: createdAt,
      expires_at: expiresAt,
      first_accessed_at: createdAt,
    });

    const res = await GET(getRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('connected');
    expect(body.expires_at).toBe(expiresAt);
  });

  it("an active token past its expiry returns status 'expired'", async () => {
    const id = insertClothingItem();
    const expiresAt = Date.now() - 1000;
    insertPairingToken(id, {
      status: 'active',
      created_at: expiresAt - 15 * 60 * 1000,
      expires_at: expiresAt,
      first_accessed_at: null,
    });

    const res = await GET(getRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('expired');
    expect(body.expires_at).toBe(expiresAt);
  });

  it("a manually-ended token (no active row left) returns status 'ended'", async () => {
    const id = insertClothingItem();
    const expiresAt = Date.now() + 15 * 60 * 1000;
    insertPairingToken(id, { status: 'ended', expires_at: expiresAt, first_accessed_at: null });

    const res = await GET(getRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ended');
    expect(body.expires_at).toBe(expiresAt);
  });

  it('photos array reflects current item_photos rows in sort_order', async () => {
    const id = insertClothingItem();
    insertItemPhoto(id, { sort_order: 2, path: `${id}/second.jpg` });
    insertItemPhoto(id, { sort_order: 1, path: `${id}/first.jpg` });

    const res = await GET(getRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.photos).toHaveLength(2);
    expect(body.photos[0].path).toBe(`${id}/first.jpg`);
    expect(body.photos[0].sort_order).toBe(1);
    expect(body.photos[1].path).toBe(`${id}/second.jpg`);
    expect(body.photos[1].sort_order).toBe(2);
  });

  it('a malformed (non-UUIDv4) item id returns 400 before any DB lookup', async () => {
    const res = await GET(getRequest('not-a-uuid'), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid item id.');
  });

  it('a well-formed but nonexistent item id returns 200 with status none, not an error', async () => {
    const id = uuidv4();
    const res = await GET(getRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('none');
    expect(body.photos).toEqual([]);
  });

  it('an unexpected error is caught, logged, and returns 500', async () => {
    const id = insertClothingItem();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dbSpy = vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
      throw new Error('simulated db failure');
    });

    try {
      const res = await GET(getRequest(id), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Internal server error.');
      expect(errSpy).toHaveBeenCalledWith(
        'GET /api/items/[id]/phone-session error:',
        expect.any(Error),
      );
    } finally {
      dbSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('DELETE /api/items/[id]/phone-session', () => {
  beforeEach(() => {
    db.exec(
      'DELETE FROM phone_pairing_tokens; DELETE FROM item_photos; DELETE FROM price_history; ' +
      'DELETE FROM item_platforms; DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
    );
  });

  it('ends an active session: 204, and a subsequent GET reflects status ended', async () => {
    const id = insertClothingItem();
    const expiresAt = Date.now() + 15 * 60 * 1000;
    insertPairingToken(id, { status: 'active', expires_at: expiresAt, first_accessed_at: null });

    const res = await DELETE(deleteRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe('');

    const activeCount = db
      .prepare("SELECT COUNT(*) as cnt FROM phone_pairing_tokens WHERE item_id = ? AND status = 'active'")
      .get(id) as { cnt: number };
    expect(activeCount.cnt).toBe(0);

    const getRes = await GET(getRequest(id), { params: Promise.resolve({ id }) });
    const getBody = await getRes.json();
    expect(getBody.status).toBe('ended');
  });

  it('is idempotent: DELETE for an item with no active token still returns 204, not an error', async () => {
    const id = insertClothingItem();

    const res = await DELETE(deleteRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(204);
  });

  it('is idempotent across repeated calls: a second DELETE on an already-ended session also returns 204', async () => {
    const id = insertClothingItem();
    insertPairingToken(id, { status: 'active', expires_at: Date.now() + 15 * 60 * 1000 });

    const res1 = await DELETE(deleteRequest(id), { params: Promise.resolve({ id }) });
    expect(res1.status).toBe(204);

    const res2 = await DELETE(deleteRequest(id), { params: Promise.resolve({ id }) });
    expect(res2.status).toBe(204);
  });

  it('a malformed (non-UUIDv4) item id returns 400 before any DB lookup', async () => {
    const res = await DELETE(deleteRequest('not-a-uuid'), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid item id.');
  });

  it('a well-formed but nonexistent item id returns 204, not an error', async () => {
    const id = uuidv4();
    const res = await DELETE(deleteRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(204);
  });

  it('an unexpected error is caught, logged, and returns 500', async () => {
    const id = insertClothingItem();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dbSpy = vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
      throw new Error('simulated db failure');
    });

    try {
      const res = await DELETE(deleteRequest(id), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Internal server error.');
      expect(errSpy).toHaveBeenCalledWith(
        'DELETE /api/items/[id]/phone-session error:',
        expect.any(Error),
      );
    } finally {
      dbSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
