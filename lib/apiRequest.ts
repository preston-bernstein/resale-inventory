import { NextRequest, NextResponse } from 'next/server';
import { resolveSession } from '@/lib/tenantAuth';
import { SESSION_COOKIE_NAME } from '@/lib/constants';
import db from '@/lib/db';
import { getConnection, type ConnectionMetadata } from '@/lib/connections';

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
 * Combine parseItemId + requireTenant + an item-ownership lookup, the
 * pattern repeated across app/api/items/[id]/phone-session/route.ts (GET,
 * DELETE) and app/api/items/[id]/photos/route.ts (PATCH): validate the id,
 * resolve the tenant, then confirm this item belongs to that tenant --
 * folding "doesn't exist" and "belongs to a different tenant" into the same
 * 404, never leaking which. Returns `{ id, tenantId }`, or a ready-to-return
 * NextResponse -- same `if (result instanceof NextResponse) return result;`
 * convention as the other helpers in this file.
 */
export async function resolveOwnedItem(
  request: NextRequest,
  params: Promise<{ id: string }>,
): Promise<{ id: string; tenantId: string } | NextResponse> {
  const parsed = await parseItemId(params);
  if (parsed instanceof NextResponse) return parsed;
  const { id } = parsed;

  const tenant = requireTenant(request);
  if (tenant instanceof NextResponse) return tenant;

  const item = db.prepare('SELECT id FROM items WHERE id = ? AND tenant_id = ?').get(id, tenant.tenantId) as
    | { id: string }
    | undefined;
  if (!item) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  return { id, tenantId: tenant.tenantId };
}

/**
 * Resolve the calling tenant, then await the route's `{ id }` param.
 * Returns `{ tenantId, id }`, or the 401 NextResponse from requireTenant --
 * the auth+param-resolution prefix shared by every /api/connections/:id/**
 * and /api/items/:id route handler, ahead of each one's own domain-specific
 * lookup.
 */
export async function requireTenantAndParam(
  request: NextRequest,
  params: Promise<{ id: string }>,
): Promise<{ tenantId: string; id: string } | NextResponse> {
  const tenant = requireTenant(request);
  if (tenant instanceof NextResponse) return tenant;
  const { id } = await params;
  return { tenantId: tenant.tenantId, id };
}

/**
 * requireTenantAndParam + lib/connections.ts's getConnection, the pattern
 * repeated across every /api/connections/:id/** route that needs the
 * connection itself (not just its id): GET, and all three consent
 * handlers. 404, never 403, whether :id doesn't exist or belongs to a
 * different tenant -- getConnection's own WHERE id = ? AND tenant_id = ?
 * already collapses both cases (FR4).
 */
export async function resolveOwnedConnection(
  request: NextRequest,
  params: Promise<{ id: string }>,
): Promise<{ tenantId: string; connection: ConnectionMetadata } | NextResponse> {
  const resolved = await requireTenantAndParam(request, params);
  if (resolved instanceof NextResponse) return resolved;
  const { tenantId, id } = resolved;

  const connection = getConnection(tenantId, id);
  if (!connection) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  return { tenantId, connection };
}

/**
 * Parse a request body as JSON. Returns `{ body }`, or a ready-to-return 400
 * NextResponse if the body isn't valid JSON -- same
 * `if ('error' in parsed) return parsed.error;` convention as the other
 * helpers in this file. Shared by every POST/PATCH handler that accepts a
 * JSON body (auth, items, and their siblings).
 */
export async function parseJsonBody(
  request: NextRequest,
): Promise<{ body: Record<string, unknown> } | { error: NextResponse }> {
  try {
    const body = await request.json();
    return { body };
  } catch {
    return { error: NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }) };
  }
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
