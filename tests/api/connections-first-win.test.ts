import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { createConnection } from '@/lib/connections';
import { createTestTenant } from '../helpers/tenant';

// ---------------------------------------------------------------------------
// GET /api/connections/:id/first-win tests (task 9's route). The route's
// only real branching logic is: 1) resolveOwnedConnection's 401/404
// tenant-ownership gate (shared with connections.test.ts's other :id
// sub-routes), 2) mapping checkConnectionHealth's outcome (resolved
// HealthResult / thrown ConnectorNotConfiguredError / thrown anything else)
// onto {healthy, detail}, and 3) the readyCount query (Unlisted items for
// the calling tenant, not already listed on this connection's platform).
//
// `ebayConnector` is mocked here (rather than exercising any real platform
// connector's own health-check internals -- that belongs to
// lib/connectors/__tests__/ebay.test.ts) purely as a controllable stand-in
// so we can force each of the three checkConnectionHealth outcomes this
// route must handle. The amazon.ts case additionally uses the REAL amazon
// connector: this repo's test env (vitest.config.ts) sets no
// AMAZON_LWA_CLIENT_ID/SECRET/refresh-token env vars, so
// amazon.ts#checkConnectionHealth naturally throws AmazonNotConfiguredError
// (a ConnectorNotConfiguredError subclass) without any mocking -- exercising
// the route's real, unmocked error-mapping path end to end.
// ---------------------------------------------------------------------------

vi.mock('@/lib/connectors/ebay', () => ({
  ebayConnector: {
    createListing: vi.fn(),
    updateListing: vi.fn(),
    markSold: vi.fn(),
    delist: vi.fn(),
    checkConnectionHealth: vi.fn(),
  },
}));

import { GET } from '@/app/api/connections/[id]/first-win/route';
import { ebayConnector } from '@/lib/connectors/ebay';

const mockedEbayHealth = vi.mocked(ebayConnector.checkConnectionHealth);

function getReq(url: string, cookie?: string): NextRequest {
  return new NextRequest(url, { headers: cookie ? { Cookie: cookie } : undefined });
}
function params(id: string) {
  return { params: Promise.resolve({ id }) };
}
function firstWinUrl(id: string) {
  return `http://localhost/api/connections/${id}/first-win`;
}

function insertBookItem(tenantId: string, overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'First Win Test Book',
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

function itemPlatformsCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM item_platforms').get() as { n: number };
  return row.n;
}

describe('GET /api/connections/:id/first-win', () => {
  // Reset the shared ebayConnector mock's queued return values AND call
  // history before every test -- otherwise a `mockResolvedValueOnce`/
  // `mockRejectedValueOnce` queued by one test but never consumed (e.g. a
  // test that fails before reaching its GET call) would silently leak into
  // and skew the very next test's result.
  beforeEach(() => {
    mockedEbayHealth.mockReset();
  });

  it('returns 401 when no tenant session is present', async () => {
    const id = '00000000-0000-4000-8000-999999999999';
    const res = await GET(getReq(firstWinUrl(id)), params(id));
    expect(res.status).toBe(401);
  });

  it('healthy connector: readyCount reflects Unlisted items, excluding items already listed on this platform', async () => {
    mockedEbayHealth.mockResolvedValueOnce({ healthy: true });
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'ebay', { token: 'x' });
    insertBookItem(tenant.tenantId, { title: 'Ready One' });
    insertBookItem(tenant.tenantId, { title: 'Ready Two' });

    const beforeCount = itemPlatformsCount();
    const res = await GET(getReq(firstWinUrl(connection.id), tenant.cookieHeader), params(connection.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.healthy).toBe(true);
    expect(body.readyCount).toBe(2);
    expect(itemPlatformsCount()).toBe(beforeCount);
  });

  it('readyCount excludes non-Unlisted items (a Sold item never counts)', async () => {
    mockedEbayHealth.mockResolvedValueOnce({ healthy: true });
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'ebay', { token: 'x' });
    insertBookItem(tenant.tenantId, { title: 'Still Unlisted', status: 'Unlisted' });
    insertBookItem(tenant.tenantId, {
      title: 'Already Sold',
      status: 'Sold',
      sale_price: 1500,
      sale_date: '2024-02-01',
      sale_platform: 'ebay',
    });

    const res = await GET(getReq(firstWinUrl(connection.id), tenant.cookieHeader), params(connection.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.readyCount).toBe(1);
  });

  it('excludes an item already listed on this connection\'s platform (item_platforms row present)', async () => {
    mockedEbayHealth.mockResolvedValueOnce({ healthy: true });
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'ebay', { token: 'x' });
    insertBookItem(tenant.tenantId, { title: 'Not Yet Listed' });
    const alreadyListedId = insertBookItem(tenant.tenantId, { title: 'Already On Ebay' });

    db.prepare(
      `INSERT INTO item_platforms (id, item_id, platform, listed_at, tenant_id)
       VALUES (?, ?, 'ebay', datetime('now'), ?)`,
    ).run(uuidv4(), alreadyListedId, tenant.tenantId);

    const res = await GET(getReq(firstWinUrl(connection.id), tenant.cookieHeader), params(connection.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.readyCount).toBe(1);
  });

  it('a connector throwing ConnectorNotConfiguredError (real amazon connector, no env vars configured) maps to {healthy:false, detail:"connector not configured"}, status 200', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'amazon', { token: 'x' });

    const res = await GET(getReq(firstWinUrl(connection.id), tenant.cookieHeader), params(connection.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.healthy).toBe(false);
    expect(body.detail).toBe('connector not configured');
  });

  it('a connector throwing any other error maps to {healthy:false, detail:"health check failed"}, not a 500', async () => {
    mockedEbayHealth.mockRejectedValueOnce(new Error('platform is on fire'));
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'ebay', { token: 'x' });
    insertBookItem(tenant.tenantId);

    const res = await GET(getReq(firstWinUrl(connection.id), tenant.cookieHeader), params(connection.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.healthy).toBe(false);
    expect(body.detail).toBe('health check failed');
    // readyCount is still computed even when the health probe itself failed.
    expect(body.readyCount).toBe(1);
  });

  it('never counts a second tenant\'s items in the first tenant\'s readyCount', async () => {
    mockedEbayHealth.mockResolvedValueOnce({ healthy: true });
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();
    const connectionA = createConnection(tenantA.tenantId, 'ebay', { token: 'a' });
    insertBookItem(tenantA.tenantId, { title: 'Tenant A Item' });
    insertBookItem(tenantB.tenantId, { title: 'Tenant B Item 1' });
    insertBookItem(tenantB.tenantId, { title: 'Tenant B Item 2' });

    const res = await GET(getReq(firstWinUrl(connectionA.id), tenantA.cookieHeader), params(connectionA.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.readyCount).toBe(1);
  });

  it('returns 404 for a connection id that does not exist', async () => {
    const tenant = createTestTenant();
    const missingId = '00000000-0000-4000-8000-999999999999';
    const res = await GET(getReq(firstWinUrl(missingId), tenant.cookieHeader), params(missingId));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found.');
  });

  it('returns 404 (not the data) for a connection owned by a different tenant', async () => {
    const owner = createTestTenant();
    const intruder = createTestTenant();
    const connection = createConnection(owner.tenantId, 'ebay', { token: 'owner-secret' });
    insertBookItem(owner.tenantId, { title: 'Owner Only Item' });

    const res = await GET(getReq(firstWinUrl(connection.id), intruder.cookieHeader), params(connection.id));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found.');
    expect(JSON.stringify(body)).not.toContain('Owner Only Item');
    expect(mockedEbayHealth).not.toHaveBeenCalled();
  });

  it('never writes a row to item_platforms as a side effect of the health probe or readyCount query', async () => {
    mockedEbayHealth.mockResolvedValueOnce({ healthy: true });
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'ebay', { token: 'x' });
    insertBookItem(tenant.tenantId);

    const before = itemPlatformsCount();
    await GET(getReq(firstWinUrl(connection.id), tenant.cookieHeader), params(connection.id));
    const after = itemPlatformsCount();
    expect(after).toBe(before);
  });

  it('an unexpected error outside the connector-health mapping (e.g. a DB failure) returns a generic 500, never leaking the raw error', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'ebay', { token: 'x' });

    const dbError = new Error('simulated unexpected database failure');
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
      throw dbError;
    });

    try {
      const res = await GET(getReq(firstWinUrl(connection.id), tenant.cookieHeader), params(connection.id));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Internal server error.');
      expect(JSON.stringify(body)).not.toContain(dbError.message);
    } finally {
      prepareSpy.mockRestore();
    }
  });
});
