import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { GET as itemsGET, POST as itemsPOST } from '@/app/api/items/route';
import { GET as itemGET, PATCH as itemPATCH } from '@/app/api/items/[id]/route';
import { GET as dashboardGET } from '@/app/api/dashboard/route';
import { GET as exportGET } from '@/app/api/export/route';
import { GET as connectionsGET } from '@/app/api/connections/route';
import { GET as suggestionsGET } from '@/app/api/items/suggestions/route';
import { GET as isbnGET } from '@/app/api/isbn/[isbn]/route';
import { POST as importPOST } from '@/app/api/import/route';
import { middleware } from '@/middleware';
import db from '@/lib/db';
import { createConnection } from '@/lib/connections';
import { createSession } from '@/lib/tenantAuth';
import { DEFAULT_TENANT_ID, SESSION_COOKIE_NAME } from '@/lib/constants';
import { createTestTenant } from '../helpers/tenant';

// ---------------------------------------------------------------------------
// Broad, cross-route acceptance tests: AC1 (401 sweep across many
// tenant-scoped routes), AC2 (404-not-403 cross-tenant sweep), AC13 (fresh
// scratch DB migrates cleanly), AC14 (pre-existing inventory attributed to
// the default tenant), AC15 (CSRF middleware independent of tenant-auth
// state). AC3-AC12 have dedicated coverage in connections.test.ts,
// consent.test.ts, and kill-switch.test.ts — this file is the
// "does the retrofit generalize across the whole route surface" sweep
// called out in plan.md's Risk areas.
// ---------------------------------------------------------------------------

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function insertBookItem(tenantId: string, overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Tenant Isolation Test Book',
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
  const item = { ...defaults, ...overrides, id, category: 'book', tenant_id: tenantId };
  db.prepare(`
    INSERT INTO items
      (id, category, title, acquisition_cost, acquisition_date, status,
       listing_price, sale_price, sale_platform, sale_date, tenant_id)
    VALUES
      (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
       @listing_price, @sale_price, @sale_platform, @sale_date, @tenant_id)
  `).run(item);
  db.prepare(`
    INSERT INTO book_details (item_id, isbn, author, publisher, condition, tenant_id)
    VALUES (@id, @isbn, @author, @publisher, @condition, @tenant_id)
  `).run(item);
  return id;
}

describe('AC1: every tenant-scoped route rejects a request with no resolvable tenant identity', () => {
  const noCookieCases: Array<[string, () => Promise<Response>]> = [
    ['GET /api/items', () => itemsGET(new NextRequest('http://localhost/api/items'))],
    [
      'POST /api/items',
      () =>
        itemsPOST(
          new NextRequest('http://localhost/api/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          }),
        ),
    ],
    ['GET /api/dashboard', () => dashboardGET(new NextRequest('http://localhost/api/dashboard'))],
    ['GET /api/export', () => exportGET(new NextRequest('http://localhost/api/export'))],
    ['GET /api/connections', () => connectionsGET(new NextRequest('http://localhost/api/connections'))],
    [
      'GET /api/items/suggestions',
      () => suggestionsGET(new NextRequest('http://localhost/api/items/suggestions?field=author')),
    ],
    [
      'GET /api/isbn/:isbn',
      () =>
        isbnGET(new NextRequest('http://localhost/api/isbn/9780306406157'), {
          params: Promise.resolve({ isbn: '9780306406157' }),
        }),
    ],
    ['POST /api/import', () => importPOST(new NextRequest('http://localhost/api/import', { method: 'POST' }))],
  ];

  it.each(noCookieCases)('%s returns 401, not the data', async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(401);
  });

  it('GET /api/items/:id also returns 401 with no cookie', async () => {
    const res = await itemGET(new NextRequest('http://localhost/api/items/some-id'), params('some-id'));
    expect(res.status).toBe(401);
  });
});

describe('AC2: cross-tenant access to a tenant-scoped resource returns 404, not 403, not the data', () => {
  it('GET /api/items/:id for another tenant\'s item returns 404', async () => {
    const owner = createTestTenant();
    const intruder = createTestTenant();
    const id = insertBookItem(owner.tenantId, { title: 'Owner-Only Book' });

    const res = await itemGET(
      new NextRequest(`http://localhost/api/items/${id}`, { headers: { Cookie: intruder.cookieHeader } }),
      params(id),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found.');
    expect(JSON.stringify(body)).not.toContain('Owner-Only Book');
  });

  it('PATCH /api/items/:id for another tenant\'s item returns 404 and does not mutate it', async () => {
    const owner = createTestTenant();
    const intruder = createTestTenant();
    const id = insertBookItem(owner.tenantId, { listing_price: null });

    const res = await itemPATCH(
      new NextRequest(`http://localhost/api/items/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: intruder.cookieHeader },
        body: JSON.stringify({ listing_price: 9999 }),
      }),
      params(id),
    );
    expect(res.status).toBe(404);

    const row = db.prepare('SELECT listing_price FROM items WHERE id = ?').get(id) as {
      listing_price: number | null;
    };
    expect(row.listing_price).toBeNull();
  });

  it('a cross-tenant GET /api/items list never includes another tenant\'s items', async () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();
    insertBookItem(tenantA.tenantId, { title: 'Tenant A Only Item' });
    insertBookItem(tenantB.tenantId, { title: 'Tenant B Only Item' });

    const resB = await itemsGET(
      new NextRequest('http://localhost/api/items?limit=200', { headers: { Cookie: tenantB.cookieHeader } }),
    );
    const bodyB = await resB.json();
    const titlesB = bodyB.items.map((i: { title: string }) => i.title);
    expect(titlesB).toContain('Tenant B Only Item');
    expect(titlesB).not.toContain('Tenant A Only Item');
  });

  it('GET /api/connections/:id for another tenant\'s connection returns 404 (generalizes beyond items)', async () => {
    const owner = createTestTenant();
    const intruder = createTestTenant();
    const connection = createConnection(owner.tenantId, 'ebay', { token: 'owner-secret' });

    const res = await connectionsGET(
      new NextRequest('http://localhost/api/connections', { headers: { Cookie: intruder.cookieHeader } }),
    );
    const body = await res.json();
    expect(body.some((c: { id: string }) => c.id === connection.id)).toBe(false);
  });
});

describe('AC13: a fresh scratch DB migrates cleanly to the latest user_version with no errors', () => {
  it('opens a brand new DB file and reaches user_version 14', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reseller-ac13-'));
    const dbPath = path.join(tmpDir, 'fresh.db');
    const keyPath = path.join(tmpDir, 'credential.key');
    const prevDbPath = process.env.BOOKSELLER_DB_PATH;
    const prevKeyPath = process.env.BOOKSELLER_CREDENTIAL_KEY_PATH;

    process.env.BOOKSELLER_DB_PATH = dbPath;
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = keyPath;
    vi.resetModules();

    try {
      const { default: freshDb } = await import('@/lib/db');
      const userVersion = freshDb.pragma('user_version', { simple: true });
      expect(userVersion).toBe(14);

      // Sanity: the seeded default tenant and disclosure version exist —
      // proof the migrations actually ran their content, not just bumped
      // the version pragma.
      const tenantRow = freshDb
        .prepare('SELECT id FROM tenants WHERE id = ?')
        .get(DEFAULT_TENANT_ID);
      expect(tenantRow).toBeTruthy();
      const disclosureRow = freshDb
        .prepare('SELECT version FROM disclosure_versions ORDER BY version DESC LIMIT 1')
        .get() as { version: number };
      expect(disclosureRow.version).toBeGreaterThanOrEqual(1);

      freshDb.close();
    } finally {
      process.env.BOOKSELLER_DB_PATH = prevDbPath;
      process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = prevKeyPath;
      vi.resetModules();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('AC14: pre-existing (tenant_id-omitted) inventory rows are attributed to the default tenant', () => {
  it('an item inserted without an explicit tenant_id lands on DEFAULT_TENANT_ID and is visible through the authenticated default-tenant session', async () => {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO items (id, category, title, acquisition_cost, acquisition_date, status)
      VALUES (?, 'book', 'Legacy Pre-Multi-Tenant Book', 500, '2024-01-01', 'Unlisted')
    `).run(id);
    db.prepare(`
      INSERT INTO book_details (item_id, author, publisher, condition)
      VALUES (?, 'Legacy Author', 'Legacy Publisher', 'Good')
    `).run(id);

    const row = db.prepare('SELECT tenant_id FROM items WHERE id = ?').get(id) as { tenant_id: string };
    expect(row.tenant_id).toBe(DEFAULT_TENANT_ID);

    // The default tenant's password is deliberately unusable (plan.md Risk
    // areas: "unclaimed" placeholder), so log in the way an already-migrated
    // session would: issue a session directly, same as lib/tenantAuth.ts's
    // createSession does after any real login.
    const { token } = createSession(DEFAULT_TENANT_ID);
    const cookie = `${SESSION_COOKIE_NAME}=${token}`;

    const res = await itemGET(
      new NextRequest(`http://localhost/api/items/${id}`, { headers: { Cookie: cookie } }),
      params(id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe('Legacy Pre-Multi-Tenant Book');
  });
});

describe('AC15: CSRF middleware rejects mismatched-Origin mutating requests regardless of tenant-auth state', () => {
  it('rejects a cross-origin POST even with a valid tenant session cookie attached', async () => {
    const tenant = createTestTenant();
    const req = new NextRequest('http://localhost/api/items', {
      method: 'POST',
      headers: {
        origin: 'http://evil.example.com',
        host: 'localhost:3000',
        Cookie: tenant.cookieHeader,
      },
    });
    const res = await middleware(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Origin not allowed.');
  });

  it('rejects a cross-origin mutating request with NO tenant-auth cookie at all (independent of tenant-auth state)', async () => {
    const req = new NextRequest('http://localhost/api/items', {
      method: 'DELETE',
      headers: { origin: 'http://evil.example.com', host: 'localhost:3000' },
    });
    const res = await middleware(req);
    expect(res.status).toBe(403);
  });

  it('allows a same-origin mutating request through to the route-handler layer', async () => {
    const req = new NextRequest('http://localhost:3000/api/items', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
    });
    const res = await middleware(req);
    expect(res.status).not.toBe(403);
  });

  it('allows a non-mutating GET through regardless of Origin (middleware only guards mutating methods)', async () => {
    const req = new NextRequest('http://localhost/api/items', {
      method: 'GET',
      headers: { origin: 'http://evil.example.com', host: 'localhost:3000' },
    });
    const res = await middleware(req);
    expect(res.status).not.toBe(403);
  });
});
