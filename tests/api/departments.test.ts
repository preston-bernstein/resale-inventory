import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import db from '@/lib/db';
import { GET } from '@/app/api/departments/route';
import { STARTER_DEPARTMENTS } from '@/lib/vocabSeed';
import { createTestTenant } from '../helpers/tenant';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let currentTenant: ReturnType<typeof createTestTenant>;

function cleanTables() {
  db.exec('DELETE FROM clothing_departments;');
}

function getDepartmentsReq(tenant: ReturnType<typeof createTestTenant> = currentTenant) {
  return new NextRequest('http://localhost/api/departments', {
    headers: { Cookie: tenant.cookieHeader },
  });
}

function insertDepartmentForTenant(tenantId: string, name: string) {
  db.prepare('INSERT INTO clothing_departments (id, tenant_id, canonical_name) VALUES (?, ?, ?)').run(
    crypto.randomUUID(),
    tenantId,
    name,
  );
}

// Every freshly created tenant (via createTestTenant -> lib/tenantAuth.ts's
// createTenant -> lib/vocabSeed.ts's seedStarterVocabulary) atomically gets
// these 5 canonical departments at creation time -- a fresh tenant's
// clothing_departments table is never empty. Sort case-insensitively
// (mirroring the route's `ORDER BY canonical_name COLLATE NOCASE`) to get
// the expected response order without hand-transcribing it.
function expectedSeededOrder(): string[] {
  return [...STARTER_DEPARTMENTS].sort((a, b) => {
    const upperA = a.toUpperCase();
    const upperB = b.toUpperCase();
    return upperA < upperB ? -1 : upperA > upperB ? 1 : 0;
  });
}

describe('GET /api/departments', () => {
  beforeEach(() => {
    cleanTables();
    currentTenant = createTestTenant();
  });

  it('returns { departments: [...] } shape with id + canonical_name only, including all 5 seeded departments ordered COLLATE NOCASE', async () => {
    const res = await GET(getDepartmentsReq());
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.departments).toHaveLength(STARTER_DEPARTMENTS.length);
    expect(Object.keys(data.departments[0]).sort()).toEqual(['canonical_name', 'id']);
    for (const department of data.departments as Array<{ id: string; canonical_name: string }>) {
      expect(typeof department.id).toBe('string');
      expect(typeof department.canonical_name).toBe('string');
    }
    expect(
      data.departments.map((d: { canonical_name: string }) => d.canonical_name),
    ).toEqual(expectedSeededOrder());
  });

  it('scopes results to the requesting tenant only (cross-tenant isolation)', async () => {
    const tenantA = currentTenant;
    const tenantB = createTestTenant();

    insertDepartmentForTenant(tenantA.tenantId, 'Only Tenant A Department');

    const resA = await GET(getDepartmentsReq(tenantA));
    const dataA = await resA.json();
    const namesA = dataA.departments.map((d: { canonical_name: string }) => d.canonical_name);
    expect(namesA).toContain('Only Tenant A Department');
    expect(dataA.departments).toHaveLength(STARTER_DEPARTMENTS.length + 1);

    const resB = await GET(getDepartmentsReq(tenantB));
    const dataB = await resB.json();
    const namesB = dataB.departments.map((d: { canonical_name: string }) => d.canonical_name);
    expect(namesB).not.toContain('Only Tenant A Department');
    // Tenant B still has its own independent 5-department seeded baseline.
    expect(dataB.departments).toHaveLength(STARTER_DEPARTMENTS.length);
    expect(namesB).toEqual(expectedSeededOrder());
  });

  it('returns 401 for an unauthenticated request (no session cookie)', async () => {
    const req = new NextRequest('http://localhost/api/departments');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('does not include a frequency/count field in the response shape', async () => {
    const res = await GET(getDepartmentsReq());
    const data = await res.json();
    expect(data.departments[0]).not.toHaveProperty('count');
    expect(data.departments[0]).not.toHaveProperty('frequency');
  });

  it('an unexpected error (e.g. a DB failure) returns a generic 500, never leaking the raw error', async () => {
    const dbError = new Error('simulated unexpected database failure');
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
      throw dbError;
    });

    try {
      const res = await GET(getDepartmentsReq());
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Internal server error.');
      expect(JSON.stringify(body)).not.toContain(dbError.message);
    } finally {
      prepareSpy.mockRestore();
    }
  });
});
