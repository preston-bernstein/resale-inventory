import { describe, it, expect, vi } from 'vitest';
import { GET } from '@/app/api/dashboard/route';
import * as dashboardLib from '@/lib/dashboard';

describe('GET /api/dashboard', () => {
  it('returns getDashboardData()\'s result as JSON with status 200', async () => {
    const res = await GET();
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
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
    spy.mockRestore();
  });
});
