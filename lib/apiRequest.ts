import { NextRequest, NextResponse } from 'next/server';
import { resolveSession } from '@/lib/tenantAuth';
import { SESSION_COOKIE_NAME } from '@/lib/constants';

// Standard UUIDv4 pattern, shared by every /api/items/[id]/** route handler
// that takes an item id path param. Not exported — parseItemId below is the
// only intended entry point; no caller needs the raw regex.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Await a route handler's `{ id }` params and validate it as a UUIDv4.
 * Returns the parsed id, or a ready-to-return 400 NextResponse if it's
 * malformed — callers just need `if (parsed instanceof NextResponse) return parsed;`.
 *
 * Rejecting a malformed id up front is the first line of path-traversal
 * defense for any caller that joins it into a filesystem path (see
 * app/api/items/[id]/photos/route.ts's resolved-path containment check for
 * the second line of defense, applied right before each file write).
 */
export async function parseItemId(
  params: Promise<{ id: string }>,
): Promise<{ id: string } | NextResponse> {
  const { id } = await params;
  if (!UUID_V4_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid item id.' }, { status: 400 });
  }
  return { id };
}

/**
 * Resolve the calling tenant from the `reseller_session` cookie on
 * `request`. Returns `{ tenantId }`, or a ready-to-return 401 NextResponse
 * if the cookie is missing, malformed, or resolves to no live session
 * (unknown, expired, or revoked) -- callers just need
 * `if (result instanceof NextResponse) return result;`, same convention as
 * parseItemId above.
 *
 * Every tenant-scoped route calls this first, before touching any
 * tenant-scoped table (FR2/FR3/AC1) -- see docs/reseller-multi-tenant-
 * foundation/plan.md's Architecture section. The two exceptions (the paired
 * phone's bearer-pairing-token paths, which never hold this cookie) resolve
 * tenant scope via lib/pairingToken.ts instead and do not call this
 * function.
 */
export function requireTenant(request: NextRequest): { tenantId: string } | NextResponse {
  const unauthorized = () => NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const cookie = request.cookies.get(SESSION_COOKIE_NAME);
  if (!cookie) {
    return unauthorized();
  }

  const resolved = resolveSession(cookie.value);
  if (!resolved) {
    return unauthorized();
  }

  return { tenantId: resolved.tenantId };
}
