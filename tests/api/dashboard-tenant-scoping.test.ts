import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as dashboardGET } from '@/app/api/dashboard/route';
import { POST as itemsPOST } from '@/app/api/items/route';
import { createTestTenant } from '../fixtures/tenant';

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

type DashboardStats = {
  held_count: number;
  held_acquisition_cost: number;
  by_condition: Record<string, number>;
  by_status: Record<string, number>;
  by_category: Record<string, { count: number; acquisition_cost: number }>;
};

async function createItemFor(cookie: string, body: Record<string, unknown>) {
  const res = await itemsPOST(createRequest(body, cookie));
  expect(res.status).toBe(201);
}

async function fetchDashboard(cookie: string) {
  const res = await dashboardGET(dashboardRequest(cookie));
  expect(res.status).toBe(200);
  return (await res.json()) as DashboardStats;
}

// Tenant A only has the one Good book: no tenant B data may leak in.
function expectOnlyTenantAStats(dataA: DashboardStats) {
  // held_count reflects only tenant A.
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
}

// Tenant B has 1 book + 1 clothing item and excludes tenant A's book entirely.
function expectOnlyTenantBStats(dataB: DashboardStats) {
  expect(dataB.held_count).toBe(2);
  expect(dataB.held_acquisition_cost).toBe(1500); // 500 (book) + 1000 (clothing)
  expect(dataB.by_condition.Poor).toBe(1);
  expect(dataB.by_condition.NWT).toBe(1);
  expect(dataB.by_condition.Good).toBe(0); // tenant A's "Good" book must not leak in
  expect(dataB.by_category.book.count).toBe(1);
  expect(dataB.by_category.clothing.count).toBe(1);
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
    await createItemFor(tenantA.cookieHeader, validBook({ title: 'Tenant A Book' }));

    // Tenant B: one held clothing item with a distinct condition/category so
    // any leak into tenant A's stats is visible, plus a second item so tenant
    // B's held_count/category totals are clearly distinguishable from a
    // single-item overlap.
    await createItemFor(tenantB.cookieHeader, validClothing({ title: 'Tenant B Jacket' }));
    await createItemFor(tenantB.cookieHeader, validBook({ title: 'Tenant B Book', condition: 'Poor' }));

    expectOnlyTenantAStats(await fetchDashboard(tenantA.cookieHeader));
    expectOnlyTenantBStats(await fetchDashboard(tenantB.cookieHeader));
  });
});
