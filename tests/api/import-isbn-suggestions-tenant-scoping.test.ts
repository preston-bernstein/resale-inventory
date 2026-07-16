import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as importPOST } from '@/app/api/import/route';
import { GET as isbnGET } from '@/app/api/isbn/[isbn]/route';
import { GET as suggestionsGET } from '@/app/api/items/suggestions/route';
import db from '@/lib/db';
import { createTestTenant } from '../helpers/tenant';

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

describe('tenant scoping: /api/import, /api/isbn, /api/items/suggestions', () => {
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

    const bookRes = await importPOST(importRequest(bookCsv, tenant.cookieHeader));
    expect(bookRes.status).toBe(200);
    const bookBody = await bookRes.json();
    expect(bookBody.errors).toEqual([]);
    expect(bookBody.imported).toBe(1);

    const clothingRes = await importPOST(importRequest(clothingCsv, tenant.cookieHeader));
    expect(clothingRes.status).toBe(200);
    const clothingBody = await clothingRes.json();
    expect(clothingBody.errors).toEqual([]);
    expect(clothingBody.imported).toBe(1);

    const bookItemRow = db
      .prepare(`SELECT id, tenant_id FROM items WHERE title = ?`)
      .get(bookTitle) as { id: string; tenant_id: string };
    expect(bookItemRow.tenant_id).toBe(tenant.tenantId);

    const bookDetailsRow = db
      .prepare(`SELECT tenant_id FROM book_details WHERE item_id = ?`)
      .get(bookItemRow.id) as { tenant_id: string };
    expect(bookDetailsRow.tenant_id).toBe(tenant.tenantId);

    const clothingItemRow = db
      .prepare(`SELECT id, tenant_id FROM items WHERE title = ?`)
      .get(clothingTitle) as { id: string; tenant_id: string };
    expect(clothingItemRow.tenant_id).toBe(tenant.tenantId);

    const clothingDetailsRow = db
      .prepare(`SELECT tenant_id FROM clothing_details WHERE item_id = ?`)
      .get(clothingItemRow.id) as { tenant_id: string };
    expect(clothingDetailsRow.tenant_id).toBe(tenant.tenantId);
  });

  it('scopes suggestions per-tenant across all three query blocks: size_label, clothing fields, and book fields', async () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();

    // Distinct, identifiable values per tenant so cross-contamination is
    // unambiguous to detect. Same brand across tenants for the size_label
    // check specifically, since that query is additionally scoped by brand.
    const sharedBrand = 'SharedBrandXYZ';

    const clothingA = {
      category: 'clothing',
      title: 'Tenant A Shirt',
      brand: sharedBrand,
      size_label: 'TENANT-A-SIZE',
      color: 'tenant-a-color',
      material: 'tenant-a-material',
      gender_department: 'Men',
      condition: 'GUC',
      acquisition_cost: 500,
      acquisition_date: '2024-01-01',
    };
    const clothingB = {
      ...clothingA,
      title: 'Tenant B Shirt',
      size_label: 'TENANT-B-SIZE',
      color: 'tenant-b-color',
      material: 'tenant-b-material',
    };
    const bookA = {
      category: 'book',
      title: 'Tenant A Book',
      author: 'tenant-a-author',
      publisher: 'tenant-a-publisher',
      condition: 'Good',
      acquisition_cost: 500,
      acquisition_date: '2024-01-01',
    };
    const bookB = {
      ...bookA,
      title: 'Tenant B Book',
      author: 'tenant-b-author',
      publisher: 'tenant-b-publisher',
    };

    // Insert directly via the items API pattern's underlying tables would
    // duplicate a lot of validation logic -- instead seed through the CSV
    // import route this task just retrofitted, keeping the seeding path
    // itself under test too.
    async function seedClothing(row: typeof clothingA, cookie: string) {
      const csvRow =
        'category,title,brand,size_label,color,material,gender_department,condition,acquisition_cost_usd,acquisition_date\n' +
        `${row.category},${row.title},${row.brand},${row.size_label},${row.color},${row.material},${row.gender_department},${row.condition},5.00,${row.acquisition_date}\n`;
      const res = await importPOST(importRequest(csvRow, cookie));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.errors).toEqual([]);
    }

    async function seedBook(row: typeof bookA, cookie: string) {
      const csvRow =
        'category,title,author,publisher,condition,acquisition_cost_usd,acquisition_date\n' +
        `${row.category},${row.title},${row.author},${row.publisher},${row.condition},5.00,${row.acquisition_date}\n`;
      const res = await importPOST(importRequest(csvRow, cookie));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.errors).toEqual([]);
    }

    await seedClothing(clothingA, tenantA.cookieHeader);
    await seedClothing(clothingB, tenantB.cookieHeader);
    await seedBook(bookA, tenantA.cookieHeader);
    await seedBook(bookB, tenantB.cookieHeader);

    // 1. size_label block (scoped by brand + tenant_id)
    const sizeResA = await suggestionsGET(
      suggestionsRequest(`?field=size_label&brand=${encodeURIComponent(sharedBrand)}`, tenantA.cookieHeader),
    );
    const sizeBodyA = await sizeResA.json();
    expect(sizeBodyA.values).toContain('TENANT-A-SIZE');
    expect(sizeBodyA.values).not.toContain('TENANT-B-SIZE');

    const sizeResB = await suggestionsGET(
      suggestionsRequest(`?field=size_label&brand=${encodeURIComponent(sharedBrand)}`, tenantB.cookieHeader),
    );
    const sizeBodyB = await sizeResB.json();
    expect(sizeBodyB.values).toContain('TENANT-B-SIZE');
    expect(sizeBodyB.values).not.toContain('TENANT-A-SIZE');

    // 2. CLOTHING_FIELDS block (color, material, brand, gender_department)
    const colorResA = await suggestionsGET(suggestionsRequest('?field=color', tenantA.cookieHeader));
    const colorBodyA = await colorResA.json();
    expect(colorBodyA.values).toContain('tenant-a-color');
    expect(colorBodyA.values).not.toContain('tenant-b-color');

    const materialResB = await suggestionsGET(suggestionsRequest('?field=material', tenantB.cookieHeader));
    const materialBodyB = await materialResB.json();
    expect(materialBodyB.values).toContain('tenant-b-material');
    expect(materialBodyB.values).not.toContain('tenant-a-material');

    // 3. BOOK_FIELDS block (author, publisher)
    const authorResA = await suggestionsGET(suggestionsRequest('?field=author', tenantA.cookieHeader));
    const authorBodyA = await authorResA.json();
    expect(authorBodyA.values).toContain('tenant-a-author');
    expect(authorBodyA.values).not.toContain('tenant-b-author');

    const publisherResB = await suggestionsGET(suggestionsRequest('?field=publisher', tenantB.cookieHeader));
    const publisherBodyB = await publisherResB.json();
    expect(publisherBodyB.values).toContain('tenant-b-publisher');
    expect(publisherBodyB.values).not.toContain('tenant-a-publisher');
  });
});
