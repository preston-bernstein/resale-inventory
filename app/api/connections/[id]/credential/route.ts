import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAndParam, parseJsonBody } from '@/lib/apiRequest';
import { rotateCredential, ConnectionValidationError } from '@/lib/connections';

// ---------------------------------------------------------------------------
// PATCH /api/connections/:id/credential — re-encrypt and store a new
// credential for an existing connection (docs/reseller-multi-tenant-
// foundation/plan.md's API contract). Same credential object-shape
// validation as POST /api/connections (see app/api/connections/route.ts):
// rotateCredential() throws ConnectionValidationError -> 422 invalid_credential.
// rotateCredential() returns null when the connection doesn't exist or
// belongs to a different tenant -> 404, never 403, per FR4 (same pattern as
// GET /api/connections/[id]).
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolved = await requireTenantAndParam(request, params);
    if (resolved instanceof NextResponse) return resolved;
    const { tenantId, id } = resolved;

    const parsed = await parseJsonBody(request);
    if ('error' in parsed) return parsed.error;
    const { credential } = parsed.body;

    try {
      const updated = rotateCredential(tenantId, id, credential);
      if (!updated) {
        return NextResponse.json({ error: 'Not found.' }, { status: 404 });
      }
      return NextResponse.json(updated);
    } catch (err) {
      if (err instanceof ConnectionValidationError) {
        return NextResponse.json({ error: 'invalid_credential' }, { status: 422 });
      }
      throw err;
    }
  } catch (err) {
    console.error('PATCH /api/connections/[id]/credential error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
