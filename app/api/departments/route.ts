import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireTenant } from '@/lib/apiRequest';

export async function GET(request: NextRequest) {
  try {
    const tenant = requireTenant(request);
    if (tenant instanceof NextResponse) return tenant;

    const rows = db
      .prepare(
        `SELECT id, canonical_name
           FROM clothing_departments
          WHERE tenant_id = ?
          ORDER BY canonical_name COLLATE NOCASE
          LIMIT 200`,
      )
      .all(tenant.tenantId) as Array<{ id: string; canonical_name: string }>;

    return NextResponse.json({ departments: rows });
  } catch (err) {
    console.error('GET /api/departments error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
