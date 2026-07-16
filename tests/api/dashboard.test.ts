import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/dashboard/route';
import * as dashboardLib from '@/lib/dashboard';
import { createTestTenant } from '../helpers/tenant';

// Task 19 retrofit (finished by Task 22): this route now requires a tenant
// session cookie.
let currentTenant: ReturnType<typeof createTestTenant>;

function dashboardRequest(): NextRequest {
  return new NextRequest('http://localhost/api/dashboard', {
    headers: { Cookie: currentTenant.cookieHeader },
  });
}

describe('GET /api/dashboard', () => {
  beforeEach(() => {
    currentTenant = createTestTenant();
  });

  it('returns getDashboardData()\'s result as JSON with status 200', async () => {
    const res = await GET(dashboardRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('held_count');
    expect(body).toHaveProperty('held_acquisition_cost');
    expect(body).toHaveProperty('by_condition');
    expect(body).toHaveProperty('by_status');
    expect(body).toHaveProperty('by_category');
  });

  it('returns 500 with an error message when getDashboardData() throws', async () => {
    const spy = vi.spyOn(dashboardLib, 'getDashboardData').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await GET(dashboardRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
    spy.mockRestore();
  });
});
