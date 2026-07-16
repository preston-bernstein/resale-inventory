import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireTenant } from '@/lib/apiRequest';
import { SUPPORTED_PLATFORMS } from '@/lib/constants';
import { createConnection, deleteConnection, listConnections, ConnectionValidationError } from '@/lib/connections';

// ---------------------------------------------------------------------------
// GET /api/connections — list this tenant's connections (metadata only, no
// credential -- see lib/connections.ts's ConnectionMetadata / toMetadata).
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const tenant = requireTenant(request);
    if (tenant instanceof NextResponse) return tenant;

    const connections = listConnections(tenant.tenantId);
    return NextResponse.json(connections);
  } catch (err) {
    console.error('GET /api/connections error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

/** Parse the JSON request body. Mirrors app/api/items/route.ts's parseRequestBody. */
async function parseRequestBody(
  request: NextRequest,
): Promise<{ body: Record<string, unknown> } | { error: NextResponse }> {
  try {
    const body = await request.json();
    return { body };
  } catch {
    return { error: NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }) };
  }
}

interface ExistingConnectionRow {
  id: string;
  status: string;
}

// ---------------------------------------------------------------------------
// POST /api/connections — create a connection for (tenant, platform).
//
// Three cases, per docs/reseller-multi-tenant-foundation/plan.md's API
// contract:
//   1. No existing (tenant_id, platform) row -> plain createConnection(), 201.
//   2. An existing row with status active/suspended -> 409 connection_exists
//      (rotate via PATCH .../credential, or reactivate via
//      POST .../reactivate -- neither route is this task's concern).
//   3. An existing row with status revoked -> a full reconnect: within a
//      single db.transaction(), delete the old row (cascades to its
//      tenant_consents/connection_status_events rows via ON DELETE CASCADE)
//      and insert a fresh row with status='active', requiring fresh consent.
//      This must be one atomic transaction, not two separate calls that
//      could partially fail -- deleteConnection() and createConnection()
//      both operate on the same lib/db.ts `db` singleton, so wrapping both
//      calls in db.transaction() here composes them atomically without
//      lib/connections.ts needing a dedicated function for this route-only
//      concern.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const tenant = requireTenant(request);
    if (tenant instanceof NextResponse) return tenant;
    const { tenantId } = tenant;

    const parsed = await parseRequestBody(request);
    if ('error' in parsed) return parsed.error;

    const body = parsed.body as Record<string, unknown> | null;
    const platform = body?.platform;
    const credential = body?.credential;

    if (typeof platform !== 'string' || !(SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) {
      return NextResponse.json({ error: 'invalid_platform' }, { status: 422 });
    }

    const existing = db
      .prepare('SELECT id, status FROM platform_connections WHERE tenant_id = ? AND platform = ?')
      .get(tenantId, platform) as ExistingConnectionRow | undefined;

    try {
      if (!existing) {
        const created = createConnection(tenantId, platform, credential);
        return NextResponse.json(created, { status: 201 });
      }

      if (existing.status === 'active' || existing.status === 'suspended') {
        return NextResponse.json({ error: 'connection_exists' }, { status: 409 });
      }

      // existing.status === 'revoked' -- reconnect path (see comment above).
      const created = db.transaction(() => {
        deleteConnection(tenantId, existing.id);
        return createConnection(tenantId, platform, credential);
      })();

      return NextResponse.json(created, { status: 201 });
    } catch (err) {
      if (err instanceof ConnectionValidationError) {
        return NextResponse.json({ error: 'invalid_credential' }, { status: 422 });
      }
      throw err;
    }
  } catch (err) {
    console.error('POST /api/connections error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
