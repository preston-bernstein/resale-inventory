import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAndParam } from '@/lib/apiRequest';
import {
  reactivateConnection,
  ConnectionValidationError,
  ConnectionNotSuspendedError,
} from '@/lib/connections';

// ---------------------------------------------------------------------------
// POST /api/connections/:id/reactivate — explicit re-activation of a
// suspended connection (docs/reseller-multi-tenant-foundation/plan.md's API
// contract). lib/connections.ts's reactivateConnection() throws
// ConnectionValidationError when the connection doesn't exist or belongs to
// a different tenant (-> 404, never 403, per FR4) and
// ConnectionNotSuspendedError when the connection is already active or is
// revoked (-> 409 not_suspended, per FR28).
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolved = await requireTenantAndParam(request, params);
    if (resolved instanceof NextResponse) return resolved;
    const { tenantId, id } = resolved;

    try {
      const updated = reactivateConnection(tenantId, id);
      return NextResponse.json(updated);
    } catch (err) {
      if (err instanceof ConnectionNotSuspendedError) {
        return NextResponse.json({ error: 'not_suspended' }, { status: 409 });
      }
      if (err instanceof ConnectionValidationError) {
        return NextResponse.json({ error: 'Not found.' }, { status: 404 });
      }
      throw err;
    }
  } catch (err) {
    console.error('POST /api/connections/[id]/reactivate error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
