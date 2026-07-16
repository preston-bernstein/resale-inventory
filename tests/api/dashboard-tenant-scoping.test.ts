import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as dashboardGET } from '@/app/api/dashboard/route';
import { POST as itemsPOST } from '@/app/api/items/route';
import { createTestTenant } from '../helpers/tenant';

// ---------------------------------------------------------------------------
// Throwaway verification for Task 19 (retrofit /api/dashboard + lib/dashboard
// getDashboardData() with tenant_id filtering). This is the fix for the
// cross-tenant data leak the spec-challenge review caught: every tenant
// dashboard read every other tenant's items/book_details/clothing_details
// with zero scoping. NOT a substitute for Task 22's full acceptance suite.
// ---------------------------------------------------------------------------

function dashboardRequest(cookie?: string): NextRequest {
  return new NextRequest('http://localhost/api/dashboard', {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}

function createRequest(body: unknown, cookie?: string): NextRequest {
  return new NextRequest('http://localhost/api/items', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function validBook(overrides: Record<string, unknown> = {}) {
  return {
    category: 'book',
    title: 'Dashboard Scoping Test Book',
    author: 'Some Author',
    publisher: 'Some Publisher',
    condition: 'Good',
    acquisition_cost: 500,
    acquisition_date: '2024-01-01',
    ...overrides,
  };
}

function validClothing(overrides: Record<string, unknown> = {}) {
  return {
    category: 'clothing',
    title: 'Dashboard Scoping Test Jacket',
    brand: "Levi's",
    size_label: 'M',
    condition: 'NWT',
    acquisition_cost: 1000,
    acquisition_date: '2024-01-01',
    ...overrides,
  };
}

describe('tenant scoping: /api/dashboard', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await dashboardGET(dashboardRequest());
    expect(res.status).toBe(401);
  });

  it("returns only the authenticated tenant's stats, with zero contamination from another tenant's data", async () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();

    // Tenant A: one held book (Good condition, Unlisted status by default).
    const bookA = await itemsPOST(
      createRequest(validBook({ title: 'Tenant A Book' }), tenantA.cookieHeader),
    );
    expect(bookA.status).toBe(201);

    // Tenant B: one held clothing item with a distinct condition/category so
    // any leak into tenant A's stats is visible.
    const clothingB = await itemsPOST(
      createRequest(validClothing({ title: 'Tenant B Jacket' }), tenantB.cookieHeader),
    );
    expect(clothingB.status).toBe(201);
    // Second tenant B item so tenant B's held_count/category totals are
    // clearly distinguishable from a single-item overlap.
    const bookB = await itemsPOST(
      createRequest(validBook({ title: 'Tenant B Book', condition: 'Poor' }), tenantB.cookieHeader),
    );
    expect(bookB.status).toBe(201);

    const dashA = await dashboardGET(dashboardRequest(tenantA.cookieHeader));
    expect(dashA.status).toBe(200);
    const dataA = await dashA.json();

    // Tenant A only has the one book: held_count reflects only tenant A.
    expect(dataA.held_count).toBe(1);
    expect(dataA.held_acquisition_cost).toBe(500);

    // by_condition: tenant A's book is "Good"; tenant B's "Poor" book and
    // NWT jacket must not leak in.
    expect(dataA.by_condition.Good).toBe(1);
    expect(dataA.by_condition.Poor).toBe(0);
    expect(dataA.by_condition.NWT).toBe(0);

    // by_status: only tenant A's single Unlisted item counted.
    expect(dataA.by_status.Unlisted).toBe(1);

    // by_category: tenant A has 1 book and 0 clothing -- tenant B's clothing
    // item and second book must not be counted here.
    expect(dataA.by_category.book.count).toBe(1);
    expect(dataA.by_category.book.acquisition_cost).toBe(500);
    expect(dataA.by_category.clothing.count).toBe(0);
    expect(dataA.by_category.clothing.acquisition_cost).toBe(0);

    // Cross-check from tenant B's side: its dashboard must reflect its own
    // 2 items (1 book + 1 clothing) and exclude tenant A's book entirely.
    const dashB = await dashboardGET(dashboardRequest(tenantB.cookieHeader));
    expect(dashB.status).toBe(200);
    const dataB = await dashB.json();

    expect(dataB.held_count).toBe(2);
    expect(dataB.held_acquisition_cost).toBe(1500); // 500 (book) + 1000 (clothing)
    expect(dataB.by_condition.Poor).toBe(1);
    expect(dataB.by_condition.NWT).toBe(1);
    expect(dataB.by_condition.Good).toBe(0); // tenant A's "Good" book must not leak in
    expect(dataB.by_category.book.count).toBe(1);
    expect(dataB.by_category.clothing.count).toBe(1);
  });
});
