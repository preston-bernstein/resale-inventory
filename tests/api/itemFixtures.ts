import { afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import db from '@/lib/db';
import { createTestTenant } from '../tenantFixtures';
import { createItemSeeder } from './itemSeed';

// ---------------------------------------------------------------------------
// Shared fixtures for the /api/items route tests.
// ---------------------------------------------------------------------------

// Task 15 retrofit (finished by Task 22): every route in this file now
// requires a tenant session cookie. A fresh tenant is created per test (see
// each describe block's beforeEach below) and stashed here so the request
// builders and item-insert helpers below can pick it up without every call
// site needing to be touched individually.
let currentTenant: ReturnType<typeof createTestTenant>;

export const { insertBookItem, insertClothingItem, insertElectronicsItem } = createItemSeeder(() => currentTenant.tenantId, 'Seed');

export function getCurrentTenant() {
  return currentTenant;
}

export function postRequest(body: unknown, cookie = currentTenant?.cookieHeader): NextRequest {
  return new NextRequest('http://localhost/api/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function getRequest(query = '', cookie = currentTenant?.cookieHeader): NextRequest {
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

export function cleanTables() {
  db.exec(
    'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
    'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM electronics_details; DELETE FROM items;',
  );
}

/** Per test: wipe the item tables and sign up a fresh tenant for the request builders to use. */
export function useFreshTenant() {
  beforeEach(() => {
    cleanTables();
    currentTenant = createTestTenant();
  });
  // Leave no rows behind: other test files clean only some of these tables, so
  // a leftover electronics row would break their DELETE FROM items.
  afterAll(cleanTables);
}
