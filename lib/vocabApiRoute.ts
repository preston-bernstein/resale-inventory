import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireTenant } from '@/lib/apiRequest';

/**
 * Shared GET-handler factory for the four canonical-vocabulary endpoints
 * (/api/brands, /api/colors, /api/materials, /api/departments) — each is an
 * identical tenant-scoped `SELECT id, canonical_name` against one table,
 * differing only in table name and response JSON key. Extracted after
 * fallow's audit flagged the four route files as a byte-for-byte clone.
 */
export function createVocabGetRoute(tableName: string, responseKey: string) {
  return async function GET(request: NextRequest) {
    try {
      const tenant = requireTenant(request);
      if (tenant instanceof NextResponse) return tenant;

      const rows = db
        .prepare(
          `SELECT id, canonical_name
             FROM ${tableName}
            WHERE tenant_id = ?
            ORDER BY canonical_name COLLATE NOCASE
            LIMIT 200`,
        )
        .all(tenant.tenantId) as Array<{ id: string; canonical_name: string }>;

      return NextResponse.json({ [responseKey]: rows });
    } catch (err) {
      console.error(`GET /api/${responseKey} error:`, err);
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
    }
  };
}
