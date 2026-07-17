import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import db from '@/lib/db';
import { GET } from '@/app/api/colors/route';
import { STARTER_COLORS } from '@/lib/vocabSeed';
import { createTestTenant } from '../helpers/tenant';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let currentTenant: ReturnType<typeof createTestTenant>;

function cleanTables() {
  db.exec('DELETE FROM clothing_colors;');
}

function getColorsReq(tenant: ReturnType<typeof createTestTenant> = currentTenant) {
  return new NextRequest('http://localhost/api/colors', {
    headers: { Cookie: tenant.cookieHeader },
  });
}

function insertColorForTenant(tenantId: string, name: string) {
  db.prepare('INSERT INTO clothing_colors (id, tenant_id, canonical_name) VALUES (?, ?, ?)').run(
    crypto.randomUUID(),
    tenantId,
    name,
  );
}

// Every freshly created tenant (via createTestTenant -> lib/tenantAuth.ts's
// createTenant -> lib/vocabSeed.ts's seedStarterVocabulary) atomically gets
// these 14 canonical colors at creation time -- a fresh tenant's
// clothing_colors table is never empty. Sort case-insensitively (mirroring
// the route's `ORDER BY canonical_name COLLATE NOCASE`) to get the expected
// response order without hand-transcribing it (and risking a typo).
function expectedSeededOrder(): string[] {
  return [...STARTER_COLORS].sort((a, b) => {
    const upperA = a.toUpperCase();
    const upperB = b.toUpperCase();
    return upperA < upperB ? -1 : upperA > upperB ? 1 : 0;
  });
}

describe('GET /api/colors', () => {
  beforeEach(() => {
    cleanTables();
    currentTenant = createTestTenant();
  });

  it('returns { colors: [...] } shape with id + canonical_name only, including all 14 seeded colors ordered COLLATE NOCASE', async () => {
    const res = await GET(getColorsReq());
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.colors).toHaveLength(STARTER_COLORS.length);
    expect(Object.keys(data.colors[0]).sort()).toEqual(['canonical_name', 'id']);
    for (const color of data.colors as Array<{ id: string; canonical_name: string }>) {
      expect(typeof color.id).toBe('string');
      expect(typeof color.canonical_name).toBe('string');
    }
    expect(data.colors.map((c: { canonical_name: string }) => c.canonical_name)).toEqual(
      expectedSeededOrder(),
    );
  });

  it('scopes results to the requesting tenant only (cross-tenant isolation)', async () => {
    const tenantA = currentTenant;
    const tenantB = createTestTenant();

    insertColorForTenant(tenantA.tenantId, 'Only Tenant A Color');

    const resA = await GET(getColorsReq(tenantA));
    const dataA = await resA.json();
    const namesA = dataA.colors.map((c: { canonical_name: string }) => c.canonical_name);
    expect(namesA).toContain('Only Tenant A Color');
    expect(dataA.colors).toHaveLength(STARTER_COLORS.length + 1);

    const resB = await GET(getColorsReq(tenantB));
    const dataB = await resB.json();
    const namesB = dataB.colors.map((c: { canonical_name: string }) => c.canonical_name);
    expect(namesB).not.toContain('Only Tenant A Color');
    // Tenant B still has its own independent 14-color seeded baseline.
    expect(dataB.colors).toHaveLength(STARTER_COLORS.length);
    expect(namesB).toEqual(expectedSeededOrder());
  });

  it('returns 401 for an unauthenticated request (no session cookie)', async () => {
    const req = new NextRequest('http://localhost/api/colors');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('does not include a frequency/count field in the response shape', async () => {
    const res = await GET(getColorsReq());
    const data = await res.json();
    expect(data.colors[0]).not.toHaveProperty('count');
    expect(data.colors[0]).not.toHaveProperty('frequency');
  });

  it('an unexpected error (e.g. a DB failure) returns a generic 500, never leaking the raw error', async () => {
    const dbError = new Error('simulated unexpected database failure');
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
      throw dbError;
    });

    try {
      const res = await GET(getColorsReq());
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Internal server error.');
      expect(JSON.stringify(body)).not.toContain(dbError.message);
    } finally {
      prepareSpy.mockRestore();
    }
  });
});
