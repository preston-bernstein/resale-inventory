import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import Papa from 'papaparse';
import db from '@/lib/db';
import { GET } from '@/app/api/export/route';
import { createTestTenant } from '../helpers/tenant';

// ---------------------------------------------------------------------------
// Throwaway verification for Task 20 (retrofit /api/export with tenant_id
// filtering). NOT a substitute for Task 22's full acceptance suite -- this
// only exercises the two behaviors that task called out: unauthenticated
// 401, and a per-tenant export containing only that tenant's own items.
// ---------------------------------------------------------------------------

function exportRequest(cookie?: string): NextRequest {
  return new NextRequest('http://localhost/api/export', {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}

function insertBookItem(tenantId: string, title: string): string {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO items
      (id, tenant_id, category, title, acquisition_cost, acquisition_date, status)
    VALUES
      (?, ?, 'book', ?, 500, '2024-01-01', 'Unlisted')
  `).run(id, tenantId, title);
  db.prepare(`
    INSERT INTO book_details (item_id, tenant_id, isbn, author, publisher, condition)
    VALUES (?, ?, NULL, 'Test Author', 'Test Publisher', 'Good')
  `).run(id, tenantId);
  return id;
}

function cleanTables() {
  db.exec(
    'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
    'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
  );
}

describe('tenant scoping: /api/export', () => {
  beforeEach(() => {
    cleanTables();
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await GET(exportRequest());
    expect(res.status).toBe(401);
  });

  it("scopes the exported CSV to the authenticated tenant's own items only", async () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();

    const itemA = insertBookItem(tenantA.tenantId, 'Tenant A Exclusive Book');
    const itemB = insertBookItem(tenantB.tenantId, 'Tenant B Exclusive Book');

    const resA = await GET(exportRequest(tenantA.cookieHeader));
    expect(resA.status).toBe(200);
    const textA = await resA.text();
    const parsedA = Papa.parse<Record<string, string>>(textA, { header: true, skipEmptyLines: true });
    const idsA = parsedA.data.map((r) => r.id);
    expect(idsA).toContain(itemA);
    expect(idsA).not.toContain(itemB);

    const resB = await GET(exportRequest(tenantB.cookieHeader));
    expect(resB.status).toBe(200);
    const textB = await resB.text();
    const parsedB = Papa.parse<Record<string, string>>(textB, { header: true, skipEmptyLines: true });
    const idsB = parsedB.data.map((r) => r.id);
    expect(idsB).toContain(itemB);
    expect(idsB).not.toContain(itemA);
  });
});
