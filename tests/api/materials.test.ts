import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import db from '@/lib/db';
import { GET } from '@/app/api/materials/route';
import { STARTER_MATERIALS } from '@/lib/vocabSeed';
import { createTestTenant } from '../helpers/tenant';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let currentTenant: ReturnType<typeof createTestTenant>;

function cleanTables() {
  db.exec('DELETE FROM clothing_materials;');
}

function getMaterialsReq(tenant: ReturnType<typeof createTestTenant> = currentTenant) {
  return new NextRequest('http://localhost/api/materials', {
    headers: { Cookie: tenant.cookieHeader },
  });
}

function insertMaterialForTenant(tenantId: string, name: string) {
  db.prepare('INSERT INTO clothing_materials (id, tenant_id, canonical_name) VALUES (?, ?, ?)').run(
    crypto.randomUUID(),
    tenantId,
    name,
  );
}

// Every freshly created tenant (via createTestTenant -> lib/tenantAuth.ts's
// createTenant -> lib/vocabSeed.ts's seedStarterVocabulary) atomically gets
// these 14 canonical materials at creation time -- a fresh tenant's
// clothing_materials table is never empty. Sort case-insensitively
// (mirroring the route's `ORDER BY canonical_name COLLATE NOCASE`) to get
// the expected response order without hand-transcribing it.
function expectedSeededOrder(): string[] {
  return [...STARTER_MATERIALS].sort((a, b) => {
    const upperA = a.toUpperCase();
    const upperB = b.toUpperCase();
    return upperA < upperB ? -1 : upperA > upperB ? 1 : 0;
  });
}

describe('GET /api/materials', () => {
  beforeEach(() => {
    cleanTables();
    currentTenant = createTestTenant();
  });

  it('returns { materials: [...] } shape with id + canonical_name only, including all 14 seeded materials ordered COLLATE NOCASE', async () => {
    const res = await GET(getMaterialsReq());
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.materials).toHaveLength(STARTER_MATERIALS.length);
    expect(Object.keys(data.materials[0]).sort()).toEqual(['canonical_name', 'id']);
    for (const material of data.materials as Array<{ id: string; canonical_name: string }>) {
      expect(typeof material.id).toBe('string');
      expect(typeof material.canonical_name).toBe('string');
    }
    expect(data.materials.map((m: { canonical_name: string }) => m.canonical_name)).toEqual(
      expectedSeededOrder(),
    );
  });

  it('scopes results to the requesting tenant only (cross-tenant isolation)', async () => {
    const tenantA = currentTenant;
    const tenantB = createTestTenant();

    insertMaterialForTenant(tenantA.tenantId, 'Only Tenant A Material');

    const resA = await GET(getMaterialsReq(tenantA));
    const dataA = await resA.json();
    const namesA = dataA.materials.map((m: { canonical_name: string }) => m.canonical_name);
    expect(namesA).toContain('Only Tenant A Material');
    expect(dataA.materials).toHaveLength(STARTER_MATERIALS.length + 1);

    const resB = await GET(getMaterialsReq(tenantB));
    const dataB = await resB.json();
    const namesB = dataB.materials.map((m: { canonical_name: string }) => m.canonical_name);
    expect(namesB).not.toContain('Only Tenant A Material');
    // Tenant B still has its own independent 14-material seeded baseline.
    expect(dataB.materials).toHaveLength(STARTER_MATERIALS.length);
    expect(namesB).toEqual(expectedSeededOrder());
  });

  it('returns 401 for an unauthenticated request (no session cookie)', async () => {
    const req = new NextRequest('http://localhost/api/materials');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('does not include a frequency/count field in the response shape', async () => {
    const res = await GET(getMaterialsReq());
    const data = await res.json();
    expect(data.materials[0]).not.toHaveProperty('count');
    expect(data.materials[0]).not.toHaveProperty('frequency');
  });

  it('an unexpected error (e.g. a DB failure) returns a generic 500, never leaking the raw error', async () => {
    const dbError = new Error('simulated unexpected database failure');
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
      throw dbError;
    });

    try {
      const res = await GET(getMaterialsReq());
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Internal server error.');
      expect(JSON.stringify(body)).not.toContain(dbError.message);
    } finally {
      prepareSpy.mockRestore();
    }
  });
});
