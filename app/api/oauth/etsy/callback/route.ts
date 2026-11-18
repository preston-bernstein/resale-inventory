import type { NextRequest} from 'next/server';
import { NextResponse } from 'next/server';
import { requireTenant } from '@/lib/apiRequest';
import {
  cancelEtsyAuthorization,
  completeEtsyAuthorization,
  EtsyAuthError,
} from '@/lib/etsyAuth';
import { ConnectorNotConfiguredError } from '@/lib/connectors/types';

// GET /api/oauth/etsy/callback -- Etsy redirects the browser here after the
// user approves (code + state) or declines (error + state). The session
// cookie identifies the tenant; the one-time state ties the flow to it.
function back(request: NextRequest, result: string) {
  return NextResponse.redirect(new URL(`/connections?etsy=${result}`, request.url));
}

/** Finish the OAuth flow; maps each known failure to its own redirect or 400. */
async function completeFlow(request: NextRequest, tenantId: string, code: string, state: string) {
  try {
    await completeEtsyAuthorization(tenantId, code, state);
    return back(request, 'connected');
  } catch (err) {
    if (err instanceof EtsyAuthError) {
      if (err.code === 'invalid_state') {
        return NextResponse.json({ error: 'invalid_state' }, { status: 400 });
      }
      return back(request, err.code);
    }
    if (err instanceof ConnectorNotConfiguredError) {
      return back(request, 'connector_not_configured');
    }
    throw err;
  }
}

export async function GET(request: NextRequest) {
  try {
    const tenant = requireTenant(request);
    if (tenant instanceof NextResponse) return tenant;

    const q = request.nextUrl.searchParams;
    const state = q.get('state') ?? '';

    if (q.get('error')) {
      cancelEtsyAuthorization(tenant.tenantId, state);
      return back(request, 'denied');
    }

    const code = q.get('code');
    if (!code || !state) {
      return NextResponse.json({ error: 'invalid_state' }, { status: 400 });
    }

    return await completeFlow(request, tenant.tenantId, code, state);
  } catch (err) {
    console.error('GET /api/oauth/etsy/callback error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
