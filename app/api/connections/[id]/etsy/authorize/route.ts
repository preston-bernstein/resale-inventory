import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAndParam } from '@/lib/apiRequest';
import { getConnection } from '@/lib/connections';
import { startEtsyAuthorization } from '@/lib/etsyAuth';
import { ConnectorNotConfiguredError } from '@/lib/connectors/types';

// POST /api/connections/:id/etsy/authorize -- start the Etsy PKCE flow for an
// existing Etsy connection. Returns { authorizeUrl }; the browser goes there,
// and Etsy sends the user back to GET /api/oauth/etsy/callback.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolved = await requireTenantAndParam(request, params);
    if (resolved instanceof NextResponse) return resolved;
    const { tenantId, id } = resolved;

    const conn = getConnection(tenantId, id);
    if (!conn) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    if (conn.platform !== 'etsy') {
      return NextResponse.json({ error: 'not_an_etsy_connection' }, { status: 422 });
    }

    try {
      return NextResponse.json({ authorizeUrl: startEtsyAuthorization(tenantId, id) });
    } catch (err) {
      if (err instanceof ConnectorNotConfiguredError) {
        return NextResponse.json({ error: 'connector_not_configured' }, { status: 503 });
      }
      throw err;
    }
  } catch (err) {
    console.error('POST /api/connections/[id]/etsy/authorize error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
