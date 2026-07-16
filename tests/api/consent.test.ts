import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { GET as disclosuresGET } from '@/app/api/disclosures/current/route';
import {
  GET as consentGET,
  POST as consentPOST,
  DELETE as consentDELETE,
} from '@/app/api/connections/[id]/consent/route';
import db from '@/lib/db';
import { createConnection } from '@/lib/connections';
import { recordConsent, revokeConsent, hasValidConsent, getCurrentDisclosureVersion } from '@/lib/consent';
import { assertCanAutomate } from '@/lib/automationGate';
import { createTestTenant } from '../helpers/tenant';

// ---------------------------------------------------------------------------
// Acceptance tests for AC6-AC9 (consent capture / automation gating) plus
// the consent + disclosure HTTP routes. See requirements.md's Acceptance
// criteria and plan.md's Consent API contract / automation-gate section.
// ---------------------------------------------------------------------------

function consentUrl(id: string) {
  return `http://localhost/api/connections/${id}/consent`;
}
function getReq(url: string, cookie?: string): NextRequest {
  return new NextRequest(url, { headers: cookie ? { Cookie: cookie } : undefined });
}
function postReq(url: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}
function deleteReq(url: string, cookie?: string): NextRequest {
  return new NextRequest(url, { method: 'DELETE', headers: cookie ? { Cookie: cookie } : undefined });
}
function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** Insert a fresh disclosure_versions row with a higher version than current, for AC7. */
function bumpDisclosureVersion(): number {
  const current = getCurrentDisclosureVersion();
  const nextVersion = current.version + 1;
  db.prepare(
    'INSERT INTO disclosure_versions (id, version, content) VALUES (?, ?, ?)',
  ).run(uuidv4(), nextVersion, `Disclosure content v${nextVersion}`);
  return nextVersion;
}

describe('GET /api/disclosures/current', () => {
  it('works with no cookie at all — the disclosure document is not tenant-scoped', async () => {
    const res = await disclosuresGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.version).toBe('number');
    expect(typeof body.content).toBe('string');
    expect(body).toEqual(getCurrentDisclosureVersion());
  });
});

describe('AC6: automation blocked with a consent-identifying error when consent is missing', () => {
  it('assertCanAutomate returns reason: consent_required for a connection with no consent record', () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'ebay', { token: 'x' });

    expect(hasValidConsent(tenant.tenantId, connection.id)).toBe(false);
    const result = assertCanAutomate(tenant.tenantId, connection.id);
    expect(result).toEqual({ ok: false, reason: 'consent_required' });
  });
});

describe('AC7: automation blocked with the same consent-identifying error when consent is stale', () => {
  it('a consent recorded against an older disclosure version stops satisfying the check after a version bump', () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'etsy', { token: 'x' });
    const originalVersion = getCurrentDisclosureVersion().version;

    recordConsent(tenant.tenantId, connection.id, originalVersion);
    expect(hasValidConsent(tenant.tenantId, connection.id)).toBe(true);
    expect(assertCanAutomate(tenant.tenantId, connection.id)).toEqual({ ok: true });

    bumpDisclosureVersion();

    // Same "missing consent" error as AC6 — a stale consent is not a
    // separate reason code.
    expect(hasValidConsent(tenant.tenantId, connection.id)).toBe(false);
    expect(assertCanAutomate(tenant.tenantId, connection.id)).toEqual({
      ok: false,
      reason: 'consent_required',
    });
  });
});

describe('AC8: per-tenant-per-platform consent scoping', () => {
  it('consent for tenant A + platform X does not satisfy tenant A + platform Y, nor tenant B + platform X', () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();
    const currentVersion = getCurrentDisclosureVersion().version;

    const connectionAX = createConnection(tenantA.tenantId, 'ebay', { token: 'ax' });
    const connectionAY = createConnection(tenantA.tenantId, 'etsy', { token: 'ay' });
    const connectionBX = createConnection(tenantB.tenantId, 'ebay', { token: 'bx' });

    recordConsent(tenantA.tenantId, connectionAX.id, currentVersion);

    expect(hasValidConsent(tenantA.tenantId, connectionAX.id)).toBe(true);
    expect(hasValidConsent(tenantA.tenantId, connectionAY.id)).toBe(false);
    expect(hasValidConsent(tenantB.tenantId, connectionBX.id)).toBe(false);
  });
});

describe('AC9: revoking consent immediately blocks automation eligibility', () => {
  it('revokeConsent flips the very next eligibility check with no other state change required', () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'amazon', { token: 'x' });
    const currentVersion = getCurrentDisclosureVersion().version;

    recordConsent(tenant.tenantId, connection.id, currentVersion);
    expect(assertCanAutomate(tenant.tenantId, connection.id)).toEqual({ ok: true });

    revokeConsent(tenant.tenantId, connection.id);

    expect(hasValidConsent(tenant.tenantId, connection.id)).toBe(false);
    expect(assertCanAutomate(tenant.tenantId, connection.id)).toEqual({
      ok: false,
      reason: 'consent_required',
    });

    // No other state changed — the connection itself is still active.
    const row = db.prepare('SELECT status FROM platform_connections WHERE id = ?').get(connection.id) as {
      status: string;
    };
    expect(row.status).toBe('active');
  });

  it('revoking consent is idempotent — a second revoke is a no-op, not an error', () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'poshmark', { token: 'x' });
    revokeConsent(tenant.tenantId, connection.id); // nothing to revoke yet
    expect(hasValidConsent(tenant.tenantId, connection.id)).toBe(false);
  });
});

describe('POST /api/connections/:id/consent', () => {
  it('returns 401 when no tenant session is present (no cookie at all)', async () => {
    const id = '00000000-0000-4000-8000-999999999999';
    const res = await consentPOST(postReq(consentUrl(id), { disclosure_version: 1 }), params(id));
    expect(res.status).toBe(401);
  });

  it('records consent at the current version, 201', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'depop', { token: 'x' });
    const currentVersion = getCurrentDisclosureVersion().version;

    const res = await consentPOST(
      postReq(consentUrl(connection.id), { disclosure_version: currentVersion }, tenant.cookieHeader),
      params(connection.id),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.disclosure_version).toBe(currentVersion);
    expect(body.consented_at).toBeTruthy();
  });

  it('rejects a disclosure_version that does not exist, 422 invalid_disclosure_version', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'mercari', { token: 'x' });

    const res = await consentPOST(
      postReq(consentUrl(connection.id), { disclosure_version: 999_999 }, tenant.cookieHeader),
      params(connection.id),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('invalid_disclosure_version');
  });

  it('rejects a stale (existing but not current) disclosure_version, 422 stale_disclosure_version', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'vinted', { token: 'x' });
    const originalVersion = getCurrentDisclosureVersion().version;
    bumpDisclosureVersion();

    const res = await consentPOST(
      postReq(consentUrl(connection.id), { disclosure_version: originalVersion }, tenant.cookieHeader),
      params(connection.id),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('stale_disclosure_version');
  });

  it('returns 404 (AC2) when a different tenant attempts to consent on a connection they don\'t own', async () => {
    const owner = createTestTenant();
    const intruder = createTestTenant();
    const connection = createConnection(owner.tenantId, 'grailed', { token: 'x' });
    const currentVersion = getCurrentDisclosureVersion().version;

    const res = await consentPOST(
      postReq(consentUrl(connection.id), { disclosure_version: currentVersion }, intruder.cookieHeader),
      params(connection.id),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found.');
    expect(hasValidConsent(owner.tenantId, connection.id)).toBe(false);
  });

  it('rejects a disclosure_version sent as a numeric string with invalid_disclosure_version, never stale_disclosure_version (type-coercion edge case)', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'mercari', { token: 'x' });
    const currentVersion = getCurrentDisclosureVersion().version;

    // SQLite's numeric affinity would happily match the TEXT "1" against an
    // INTEGER version column if this string ever reached the SQL layer
    // unvalidated -- Number.isInteger must reject it in JS first, before any
    // query runs, so this hits invalid_disclosure_version, not a
    // stale-version mismatch (disclosureVersion !== current.version would
    // otherwise fire for the wrong reason: "1" !== 1).
    const res = await consentPOST(
      postReq(consentUrl(connection.id), { disclosure_version: String(currentVersion) }, tenant.cookieHeader),
      params(connection.id),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('invalid_disclosure_version');
  });

  it('rejects a non-integer numeric disclosure_version (float), 422 invalid_disclosure_version', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'vinted', { token: 'x' });
    const currentVersion = getCurrentDisclosureVersion().version;

    const res = await consentPOST(
      postReq(consentUrl(connection.id), { disclosure_version: currentVersion + 0.5 }, tenant.cookieHeader),
      params(connection.id),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('invalid_disclosure_version');
  });

  it('a non-consent-version error raised while recording consent is a 500, not misreported as 422', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'ebay', { token: 'x' });
    const currentVersion = getCurrentDisclosureVersion().version;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO tenant_consents')) {
        throw new Error('simulated disk failure');
      }
      return realPrepare(sql);
    });

    try {
      const res = await consentPOST(
        postReq(consentUrl(connection.id), { disclosure_version: currentVersion }, tenant.cookieHeader),
        params(connection.id),
      );
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Internal server error.');
    } finally {
      prepareSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('GET /api/connections/:id/consent', () => {
  it('returns 401 when no tenant session is present (no cookie at all)', async () => {
    const id = '00000000-0000-4000-8000-999999999999';
    const res = await consentGET(getReq(consentUrl(id)), params(id));
    expect(res.status).toBe(401);
  });

  it('reports has_valid_consent: false and consented_version: null before any consent is given', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'ebay', { token: 'x' });

    const res = await consentGET(getReq(consentUrl(connection.id), tenant.cookieHeader), params(connection.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_valid_consent).toBe(false);
    expect(body.consented_version).toBeNull();
    expect(body.consented_at).toBeNull();
    expect(typeof body.current_version).toBe('number');
  });

  it('reports has_valid_consent: true and the consented version after consenting', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'etsy', { token: 'x' });
    const currentVersion = getCurrentDisclosureVersion().version;
    recordConsent(tenant.tenantId, connection.id, currentVersion);

    const res = await consentGET(getReq(consentUrl(connection.id), tenant.cookieHeader), params(connection.id));
    const body = await res.json();
    expect(body.has_valid_consent).toBe(true);
    expect(body.consented_version).toBe(currentVersion);
    expect(body.consented_at).toBeTruthy();
  });

  it('returns 404 for a cross-tenant connection', async () => {
    const owner = createTestTenant();
    const intruder = createTestTenant();
    const connection = createConnection(owner.tenantId, 'amazon', { token: 'x' });

    const res = await consentGET(getReq(consentUrl(connection.id), intruder.cookieHeader), params(connection.id));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found.');
  });
});

describe('DELETE /api/connections/:id/consent', () => {
  it('returns 401 when no tenant session is present (no cookie at all)', async () => {
    const id = '00000000-0000-4000-8000-999999999999';
    const res = await consentDELETE(deleteReq(consentUrl(id)), params(id));
    expect(res.status).toBe(401);
  });

  it('revokes an active consent, 204, and the next GET reflects it', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'poshmark', { token: 'x' });
    const currentVersion = getCurrentDisclosureVersion().version;
    recordConsent(tenant.tenantId, connection.id, currentVersion);

    const res = await consentDELETE(deleteReq(consentUrl(connection.id), tenant.cookieHeader), params(connection.id));
    expect(res.status).toBe(204);

    const getRes = await consentGET(getReq(consentUrl(connection.id), tenant.cookieHeader), params(connection.id));
    const body = await getRes.json();
    expect(body.has_valid_consent).toBe(false);
  });

  it('is idempotent: a second DELETE with nothing to revoke still returns 204', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'depop', { token: 'x' });

    const res = await consentDELETE(deleteReq(consentUrl(connection.id), tenant.cookieHeader), params(connection.id));
    expect(res.status).toBe(204);
  });

  it('returns 404 for a cross-tenant connection and does not revoke the owner\'s consent', async () => {
    const owner = createTestTenant();
    const intruder = createTestTenant();
    const connection = createConnection(owner.tenantId, 'mercari', { token: 'x' });
    const currentVersion = getCurrentDisclosureVersion().version;
    recordConsent(owner.tenantId, connection.id, currentVersion);

    const res = await consentDELETE(deleteReq(consentUrl(connection.id), intruder.cookieHeader), params(connection.id));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found.');
    expect(hasValidConsent(owner.tenantId, connection.id)).toBe(true);
  });
});
