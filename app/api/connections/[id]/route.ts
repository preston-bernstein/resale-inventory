import { NextRequest, NextResponse } from 'next/server';
import { requireTenant } from '@/lib/apiRequest';
import { getConnection } from '@/lib/connections';

// ---------------------------------------------------------------------------
// GET /api/connections/:id — fetch one connection's metadata, scoped to the
// resolved tenant. 404 whether the id doesn't exist at all or belongs to a
// different tenant -- the two cases are indistinguishable to the caller by
// design (FR4/AC2), so no separate malformed-id 400 branch is added here:
// getConnection()'s parameterized WHERE id = ? AND tenant_id = ? simply
// matches no row for a garbage id, which collapses to the same 404.
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const tenant = requireTenant(request);
    if (tenant instanceof NextResponse) return tenant;

    const { id } = await params;

    const connection = getConnection(tenant.tenantId, id);
    if (!connection) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }

    return NextResponse.json(connection);
  } catch (err) {
    console.error('GET /api/connections/[id] error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
