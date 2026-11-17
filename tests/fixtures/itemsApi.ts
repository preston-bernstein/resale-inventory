import { NextRequest } from 'next/server';
import { createTestTenant, type TestTenant } from './tenant';
import { deleteAllItems, seedBookItem, seedClothingItem, seedElectronicsItem } from './items';

// Request builders and seeders for the /api/items route tests. Every route
// needs a tenant session cookie, so a fresh tenant is created per test
// (resetItemsAndTenant) and kept here for the builders below.
let activeTenant: TestTenant | undefined;

export function postRequest(body: unknown, cookie = activeTenant?.cookieHeader): NextRequest {
  return new NextRequest('http://localhost/api/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function getRequest(query = '', cookie = activeTenant?.cookieHeader): NextRequest {
  return new NextRequest(`http://localhost/api/items${query}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}

export function validBook(overrides: Record<string, unknown> = {}) {
  return {
    category: 'book',
    title: 'The Great Gatsby',
    author: 'F. Scott Fitzgerald',
    publisher: 'Scribner',
    condition: 'Good',
    acquisition_cost: 500,
    acquisition_date: '2024-01-01',
    ...overrides,
  };
}

export function validClothing(overrides: Record<string, unknown> = {}) {
  return {
    category: 'clothing',
    title: 'Denim Jacket',
    brand: 'Levi\'s',
    size_label: 'M',
    condition: 'EUC',
    acquisition_cost: 2000,
    acquisition_date: '2024-02-01',
    ...overrides,
  };
}

export function validElectronics(overrides: Record<string, unknown> = {}) {
  return {
    category: 'electronics',
    title: 'Apple MacBook Pro',
    brand: 'Apple',
    model: 'MacBook Pro',
    condition: 'Excellent',
    acquisition_cost: 45000,
    acquisition_date: '2024-03-01',
    ...overrides,
  };
}

export function currentTenant(): TestTenant {
  if (!activeTenant) throw new Error('resetItemsAndTenant() must run before this helper');
  return activeTenant;
}

export function insertBookItem(overrides: Record<string, unknown> = {}): string {
  return seedBookItem(currentTenant().tenantId, overrides);
}

export function insertClothingItem(overrides: Record<string, unknown> = {}): string {
  return seedClothingItem(currentTenant().tenantId, overrides);
}

export function insertElectronicsItem(overrides: Record<string, unknown> = {}): string {
  return seedElectronicsItem(currentTenant().tenantId, overrides);
}

export function resetItemsAndTenant() {
  deleteAllItems();
  activeTenant = createTestTenant();
}
