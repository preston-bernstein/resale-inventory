import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as importPOST } from '@/app/api/import/route';
import { GET as isbnGET } from '@/app/api/isbn/[isbn]/route';
import { GET as suggestionsGET } from '@/app/api/items/suggestions/route';
import db from '@/lib/db';
import { createTestTenant } from '../tenantFixtures';

// ---------------------------------------------------------------------------
// Throwaway verification for Task 21 (retrofit /api/import, /api/isbn, and
// /api/items/suggestions with tenant_id filtering). NOT a substitute for
// Task 22's full acceptance suite -- this only exercises the specific
// behaviors the spec-challenge review flagged: unauthenticated 401s on all
// three routes, imported items landing on the authenticated tenant (item +
// satellite row both), and suggestions for one tenant never leaking values
// (size, clothing fields, book fields) that only exist in another tenant's
// inventory.
// ---------------------------------------------------------------------------

function importRequest(csv: string, cookie?: string): NextRequest {
  const formData = new FormData();
  formData.append('file', new File([csv], 'import.csv', { type: 'text/csv' }));
  return new NextRequest('http://localhost/api/import', {
    method: 'POST',
    headers: cookie ? { Cookie: cookie } : undefined,
    body: formData,
  });
}

function isbnRequest(isbn: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost/api/isbn/${isbn}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}

function isbnParams(isbn: string) {
  return { params: Promise.resolve({ isbn }) };
}

function suggestionsRequest(query: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost/api/items/suggestions${query}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}


describe('tenant scoping: /api/import, /api/isbn, /api/items/suggestions › unauthenticated requests', () => {
  it('rejects unauthenticated POST /api/import with 401', async () => {
    const csv = 'category,title,author,condition,acquisition_cost_usd,acquisition_date\n' +
      'book,Some Book,Some Author,Good,5.00,2024-01-01\n';
    const res = await importPOST(importRequest(csv));
    expect(res.status).toBe(401);
  });

  it('rejects unauthenticated GET /api/isbn/:isbn with 401', async () => {
    const res = await isbnGET(isbnRequest('9780306406157'), isbnParams('9780306406157'));
    expect(res.status).toBe(401);
  });

  it('rejects unauthenticated GET /api/items/suggestions with 401', async () => {
    const res = await suggestionsGET(suggestionsRequest('?field=author'));
    expect(res.status).toBe(401);
  });
});

async function importRows(csv: string, cookie: string) {
  const res = await importPOST(importRequest(csv, cookie));
  expect(res.status).toBe(200);
  return res.json();
}

function tenantIdOfItem(title: string): { id: string; tenant_id: string } {
  return db.prepare(`SELECT id, tenant_id FROM items WHERE title = ?`).get(title) as {
    id: string;
    tenant_id: string;
  };
}

function tenantIdOfDetails(table: 'book_details' | 'clothing_details', itemId: string): string {
  const row = db.prepare(`SELECT tenant_id FROM ${table} WHERE item_id = ?`).get(itemId) as {
    tenant_id: string;
  };
  return row.tenant_id;
}

describe('tenant scoping: /api/import, /api/isbn, /api/items/suggestions › import', () => {
  it('lands imported items (and their satellite rows) on the authenticated tenant', async () => {
    const tenant = createTestTenant();

    // Titles carry a random suffix -- the scratch DB persists across test
    // runs (not wiped between `vitest run` invocations), so a fixed title
    // could collide with a leftover row from a prior run and this test
    // would silently pick up the wrong (older) row's tenant_id.
    const suffix = crypto.randomUUID();
    const bookTitle = `Import Tenant Book ${suffix}`;
    const clothingTitle = `Import Tenant Shirt ${suffix}`;

    // Two separate single-row CSVs (book, then clothing) since header rows
    // differ per category and papaparse treats row 1 as the header for the
    // whole file -- import each category in its own request.
    const bookCsv =
      'category,title,author,publisher,condition,acquisition_cost_usd,acquisition_date\n' +
      `book,${bookTitle},Import Tenant Author,Import Tenant Publisher,Good,5.00,2024-01-01\n`;
    const clothingCsv =
      'category,title,brand,size_label,condition,acquisition_cost_usd,acquisition_date\n' +
      `clothing,${clothingTitle},Import Tenant Brand,Import Tenant Size,GUC,5.00,2024-01-01\n`;

    const bookBody = await importRows(bookCsv, tenant.cookieHeader);
    expect(bookBody.errors).toEqual([]);
    expect(bookBody.imported).toBe(1);

    const clothingBody = await importRows(clothingCsv, tenant.cookieHeader);
    expect(clothingBody.errors).toEqual([]);
    expect(clothingBody.imported).toBe(1);

    const bookItemRow = tenantIdOfItem(bookTitle);
    expect(bookItemRow.tenant_id).toBe(tenant.tenantId);
    expect(tenantIdOfDetails('book_details', bookItemRow.id)).toBe(tenant.tenantId);

    const clothingItemRow = tenantIdOfItem(clothingTitle);
    expect(clothingItemRow.tenant_id).toBe(tenant.tenantId);
    expect(tenantIdOfDetails('clothing_details', clothingItemRow.id)).toBe(tenant.tenantId);
  });
});

// Distinct, identifiable values per tenant so cross-contamination is
// unambiguous to detect. Same brand across tenants for the size_label
// check specifically, since that query is additionally scoped by brand.
const SHARED_BRAND = 'SharedBrandXYZ';

const CLOTHING_A = {
  category: 'clothing',
  title: 'Tenant A Shirt',
  brand: SHARED_BRAND,
  size_label: 'TENANT-A-SIZE',
  color: 'tenant-a-color',
  material: 'tenant-a-material',
  gender_department: 'Men',
  condition: 'GUC',
  acquisition_cost: 500,
  acquisition_date: '2024-01-01',
};
const CLOTHING_B = {
  ...CLOTHING_A,
  title: 'Tenant B Shirt',
  size_label: 'TENANT-B-SIZE',
  color: 'tenant-b-color',
  material: 'tenant-b-material',
};
const BOOK_A = {
  category: 'book',
  title: 'Tenant A Book',
  author: 'tenant-a-author',
  publisher: 'tenant-a-publisher',
  condition: 'Good',
  acquisition_cost: 500,
  acquisition_date: '2024-01-01',
};
const BOOK_B = {
  ...BOOK_A,
  title: 'Tenant B Book',
  author: 'tenant-b-author',
  publisher: 'tenant-b-publisher',
};

// Seed through the CSV import route (not direct inserts) so the seeding path
// stays under test too and no validation logic is duplicated here.
async function seedClothing(row: typeof CLOTHING_A, cookie: string) {
  const csvRow =
    'category,title,brand,size_label,color,material,gender_department,condition,acquisition_cost_usd,acquisition_date\n' +
    `${row.category},${row.title},${row.brand},${row.size_label},${row.color},${row.material},${row.gender_department},${row.condition},5.00,${row.acquisition_date}\n`;
  const body = await importRows(csvRow, cookie);
  expect(body.errors).toEqual([]);
}

async function seedBook(row: typeof BOOK_A, cookie: string) {
  const csvRow =
    'category,title,author,publisher,condition,acquisition_cost_usd,acquisition_date\n' +
    `${row.category},${row.title},${row.author},${row.publisher},${row.condition},5.00,${row.acquisition_date}\n`;
  const body = await importRows(csvRow, cookie);
  expect(body.errors).toEqual([]);
}

async function suggestedValues(query: string, cookie: string): Promise<string[]> {
  const res = await suggestionsGET(suggestionsRequest(query, cookie));
  const body = await res.json();
  return body.values;
}

describe('tenant scoping: /api/import, /api/isbn, /api/items/suggestions › suggestions', () => {
  it('scopes suggestions per-tenant across all three query blocks: size_label, clothing fields, and book fields', async () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();

    await seedClothing(CLOTHING_A, tenantA.cookieHeader);
    await seedClothing(CLOTHING_B, tenantB.cookieHeader);
    await seedBook(BOOK_A, tenantA.cookieHeader);
    await seedBook(BOOK_B, tenantB.cookieHeader);

    // 1. size_label block (scoped by brand + tenant_id)
    const sizeQuery = `?field=size_label&brand=${encodeURIComponent(SHARED_BRAND)}`;
    const sizesA = await suggestedValues(sizeQuery, tenantA.cookieHeader);
    expect(sizesA).toContain('TENANT-A-SIZE');
    expect(sizesA).not.toContain('TENANT-B-SIZE');

    const sizesB = await suggestedValues(sizeQuery, tenantB.cookieHeader);
    expect(sizesB).toContain('TENANT-B-SIZE');
    expect(sizesB).not.toContain('TENANT-A-SIZE');

    // 2. CLOTHING_FIELDS block (color, material, brand, gender_department)
    const colorsA = await suggestedValues('?field=color', tenantA.cookieHeader);
    expect(colorsA).toContain('tenant-a-color');
    expect(colorsA).not.toContain('tenant-b-color');

    const materialsB = await suggestedValues('?field=material', tenantB.cookieHeader);
    expect(materialsB).toContain('tenant-b-material');
    expect(materialsB).not.toContain('tenant-a-material');

    // 3. BOOK_FIELDS block (author, publisher)
    const authorsA = await suggestedValues('?field=author', tenantA.cookieHeader);
    expect(authorsA).toContain('tenant-a-author');
    expect(authorsA).not.toContain('tenant-b-author');

    const publishersB = await suggestedValues('?field=publisher', tenantB.cookieHeader);
    expect(publishersB).toContain('tenant-b-publisher');
    expect(publishersB).not.toContain('tenant-a-publisher');
  });
});
