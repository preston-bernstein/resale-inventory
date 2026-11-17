import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import db from '@/lib/db';
import { createTestTenant } from '../helpers/tenant';

type TestTenant = ReturnType<typeof createTestTenant>;
type VocabRow = { id: string; canonical_name: string };

interface VocabRouteConfig {
  /** Plural path segment and response key, e.g. 'colors'. */
  route: string;
  /** Singular name used in test titles and in the fabricated tenant-only row. */
  singular: string;
  table: string;
  GET: (request: NextRequest) => Promise<Response>;
  /** The starter vocabulary every new tenant is seeded with. */
  starter: readonly string[];
}

function upperCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Every freshly created tenant (via createTestTenant -> lib/tenantAuth.ts's
// createTenant -> lib/vocabSeed.ts's seedStarterVocabulary) atomically gets
// its starter vocabulary at creation time, so a fresh tenant's table is never
// empty. Sort case-insensitively (mirroring the route's `ORDER BY
// canonical_name COLLATE NOCASE`) to get the expected response order without
// hand-transcribing it (and risking a typo).
function expectedSeededOrder(starter: readonly string[]): string[] {
  return [...starter].sort((a, b) => {
    const upperA = a.toUpperCase();
    const upperB = b.toUpperCase();
    return upperA < upperB ? -1 : upperA > upperB ? 1 : 0;
  });
}

/** Request builders and fixtures for one vocabulary route; `currentTenant` is replaced before every test. */
function createVocabFixtures(config: VocabRouteConfig) {
  const { route, table, GET } = config;
  let currentTenant: TestTenant;

  function listRequest(tenant: TestTenant = currentTenant) {
    return new NextRequest(`http://localhost/api/${route}`, {
      headers: { Cookie: tenant.cookieHeader },
    });
  }

  return {
    listRequest,
    getCurrentTenant: () => currentTenant,
    insertForTenant(tenantId: string, name: string) {
      db.prepare(`INSERT INTO ${table} (id, tenant_id, canonical_name) VALUES (?, ?, ?)`).run(
        crypto.randomUUID(),
        tenantId,
        name,
      );
    },
    useFreshTenant() {
      beforeEach(() => {
        db.exec(`DELETE FROM ${table};`);
        currentTenant = createTestTenant();
      });
    },
    async rowsFor(tenant: TestTenant): Promise<{ names: string[]; rows: VocabRow[] }> {
      const data = await (await GET(listRequest(tenant))).json();
      const rows = data[route] as VocabRow[];
      return { names: rows.map((row) => row.canonical_name), rows };
    },
  };
}

type VocabFixtures = ReturnType<typeof createVocabFixtures>;

function describeShapeScopingAndAuth(config: VocabRouteConfig, fx: VocabFixtures): void {
  const { route, singular, GET, starter } = config;
  const label = upperCase(singular);

  describe(`GET /api/${route} › shape, scoping and auth`, () => {
    fx.useFreshTenant();

    it(`returns { ${route}: [...] } shape with id + canonical_name only, including all ${starter.length} seeded ${route} ordered COLLATE NOCASE`, async () => {
      const res = await GET(fx.listRequest());
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data[route]).toHaveLength(starter.length);
      expect(Object.keys(data[route][0]).sort()).toEqual(['canonical_name', 'id']);
      for (const row of data[route] as VocabRow[]) {
        expect(typeof row.id).toBe('string');
        expect(typeof row.canonical_name).toBe('string');
      }
      expect((data[route] as VocabRow[]).map((row) => row.canonical_name)).toEqual(
        expectedSeededOrder(starter),
      );
    });

    it('scopes results to the requesting tenant only (cross-tenant isolation)', async () => {
      const tenantA = fx.getCurrentTenant();
      const tenantB = createTestTenant();

      fx.insertForTenant(tenantA.tenantId, `Only Tenant A ${label}`);

      const a = await fx.rowsFor(tenantA);
      expect(a.names).toContain(`Only Tenant A ${label}`);
      expect(a.rows).toHaveLength(starter.length + 1);

      const b = await fx.rowsFor(tenantB);
      expect(b.names).not.toContain(`Only Tenant A ${label}`);
      // Tenant B still has its own independent seeded baseline.
      expect(b.rows).toHaveLength(starter.length);
      expect(b.names).toEqual(expectedSeededOrder(starter));
    });

    it('returns 401 for an unauthenticated request (no session cookie)', async () => {
      const res = await GET(new NextRequest(`http://localhost/api/${route}`));
      expect(res.status).toBe(401);
    });
  });
}

function describeCountFieldAndServerErrors(config: VocabRouteConfig, fx: VocabFixtures): void {
  const { route, GET } = config;

  describe(`GET /api/${route} › count field and server errors`, () => {
    fx.useFreshTenant();

    it('does not include a frequency/count field in the response shape', async () => {
      const res = await GET(fx.listRequest());
      const data = await res.json();
      expect(data[route][0]).not.toHaveProperty('count');
      expect(data[route][0]).not.toHaveProperty('frequency');
    });

    it('an unexpected error (e.g. a DB failure) returns a generic 500, never leaking the raw error', async () => {
      const dbError = new Error('simulated unexpected database failure');
      const prepareSpy = vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
        throw dbError;
      });

      try {
        const res = await GET(fx.listRequest());
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toBe('Internal server error.');
        expect(JSON.stringify(body)).not.toContain(dbError.message);
      } finally {
        prepareSpy.mockRestore();
      }
    });
  });
}

/**
 * The GET list contract shared by the per-tenant vocabulary routes
 * (/api/colors, /api/materials, /api/departments): response shape, seeded
 * order, tenant scoping, auth, no count field, and a generic 500.
 */
export function describeVocabListRoute(config: VocabRouteConfig): void {
  const fixtures = createVocabFixtures(config);
  describeShapeScopingAndAuth(config, fixtures);
  describeCountFieldAndServerErrors(config, fixtures);
}
