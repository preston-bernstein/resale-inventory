import { NextRequest, NextResponse } from 'next/server';
import { resolveOwnedConnection } from '@/lib/apiRequest';
import {
  getCurrentDisclosureVersion,
  recordConsent,
  revokeConsent,
  hasValidConsent,
  InvalidDisclosureVersionError,
  StaleDisclosureVersionError,
} from '@/lib/consent';
import db from '@/lib/db';

// Consent capture routes (FR13-FR20, plan.md's "Consent" API contract
// section). All three handlers below are scoped to a single
// platform_connections row, so each one first resolves the tenant
// (requireTenant) and then re-verifies ownership of :id via
// lib/connections.ts's getConnection (404, never 403, per FR4 -- same
// pattern as the other /api/connections/:id/** routes).

interface ActiveConsentRow {
  disclosure_version: number;
  consented_at: string;
}

/**
 * The tenant's currently-active (non-revoked) consent row for this
 * connection, if any. lib/consent.ts's hasValidConsent only returns a
 * boolean, not the version/timestamp -- this mirrors its query to surface
 * that extra detail for the GET response, without modifying lib/consent.ts
 * (outside this task's file list).
 */
function getActiveConsent(tenantId: string, connectionId: string): ActiveConsentRow | null {
  const row = db
    .prepare(
      `SELECT disclosure_version, consented_at FROM tenant_consents
       WHERE tenant_id = ? AND connection_id = ? AND revoked_at IS NULL`,
    )
    .get(tenantId, connectionId) as ActiveConsentRow | undefined;

  return row ?? null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolved = await resolveOwnedConnection(request, params);
    if (resolved instanceof NextResponse) return resolved;
    const { tenantId, connection } = resolved;

    const current = getCurrentDisclosureVersion();
    const active = getActiveConsent(tenantId, connection.id);

    return NextResponse.json({
      has_valid_consent: hasValidConsent(tenantId, connection.id),
      current_version: current.version,
      consented_version: active?.disclosure_version ?? null,
      consented_at: active?.consented_at ?? null,
    });
  } catch (err) {
    console.error('GET /api/connections/[id]/consent error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolved = await resolveOwnedConnection(request, params);
    if (resolved instanceof NextResponse) return resolved;
    const { tenantId, connection } = resolved;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
    }
    const { disclosure_version: disclosureVersion } = (body ?? {}) as Record<string, unknown>;

    try {
      const consent = recordConsent(tenantId, connection.id, disclosureVersion as number);
      return NextResponse.json(
        {
          disclosure_version: consent.disclosureVersion,
          consented_at: consent.consentedAt,
        },
        { status: 201 },
      );
    } catch (err) {
      if (err instanceof InvalidDisclosureVersionError) {
        return NextResponse.json({ error: 'invalid_disclosure_version' }, { status: 422 });
      }
      if (err instanceof StaleDisclosureVersionError) {
        return NextResponse.json({ error: 'stale_disclosure_version' }, { status: 422 });
      }
      throw err;
    }
  } catch (err) {
    console.error('POST /api/connections/[id]/consent error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolved = await resolveOwnedConnection(request, params);
    if (resolved instanceof NextResponse) return resolved;
    const { tenantId, connection } = resolved;

    // Idempotent per the API contract -- revokeConsent is a no-op (not an
    // error) when there's nothing active to revoke, so this always 204s.
    revokeConsent(tenantId, connection.id);

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error('DELETE /api/connections/[id]/consent error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
