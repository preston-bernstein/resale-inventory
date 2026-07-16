import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as reactivatePOST } from '@/app/api/connections/[id]/reactivate/route';
import { GET as connectionGET } from '@/app/api/connections/[id]/route';
import db from '@/lib/db';
import {
  createConnection,
  getConnection,
  recordSuspensionSignal,
  reactivateConnection,
  ConnectionValidationError,
  ConnectionNotSuspendedError,
} from '@/lib/connections';
import { recordConsent, getCurrentDisclosureVersion } from '@/lib/consent';
import { assertCanAutomate } from '@/lib/automationGate';
import { createTestTenant } from '../helpers/tenant';

// ---------------------------------------------------------------------------
// Acceptance tests for AC10 (synchronous suspension transition), AC11
// (mid-session suspension blocks the next automation attempt), and AC12
// (no auto-heal — suspended stays suspended absent an explicit reactivation
// call). See requirements.md's Acceptance criteria and plan.md's kill-switch
// library contract (lib/connections.ts's recordSuspensionSignal /
// reactivateConnection, lib/automationGate.ts's assertCanAutomate).
// ---------------------------------------------------------------------------

function reactivateUrl(id: string) {
  return `http://localhost/api/connections/${id}/reactivate`;
}
function connectionUrl(id: string) {
  return `http://localhost/api/connections/${id}`;
}
function postReq(url: string, cookie?: string): NextRequest {
  return new NextRequest(url, { method: 'POST', headers: cookie ? { Cookie: cookie } : undefined });
}
function getReq(url: string, cookie?: string): NextRequest {
  return new NextRequest(url, { headers: cookie ? { Cookie: cookie } : undefined });
}
function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function statusEventsFor(connectionId: string) {
  // Order by rowid, not detected_at: detected_at is a TEXT datetime('now')
  // with only second-level resolution, so two events recorded within the
  // same second (e.g. a suspend immediately followed by a reactivate, as in
  // the AC12 test below) would otherwise tie and sort unpredictably.
  return db
    .prepare(
      'SELECT from_status, to_status, reason, detected_at FROM connection_status_events WHERE connection_id = ? ORDER BY rowid ASC',
    )
    .all(connectionId) as Array<{ from_status: string; to_status: string; reason: string; detected_at: string }>;
}

describe('AC10: a suspension signal transitions status within the same call, no polling required', () => {
  it('status reads as suspended immediately after recordSuspensionSignal returns', () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'ebay', { token: 'x' });
    expect(getConnection(tenant.tenantId, connection.id)?.status).toBe('active');

    recordSuspensionSignal(tenant.tenantId, connection.id, 'ebay_api_403_account_suspended', 'suspended');

    // No await, no setTimeout, no poll loop — read the status back in the
    // very next statement (NFR: synchronous, not a delayed/best-effort job).
    const after = getConnection(tenant.tenantId, connection.id);
    expect(after?.status).toBe('suspended');
  });

  it('can transition directly to revoked (permanent loss of access)', () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'etsy', { token: 'x' });

    recordSuspensionSignal(tenant.tenantId, connection.id, 'account_permanently_banned', 'revoked');

    expect(getConnection(tenant.tenantId, connection.id)?.status).toBe('revoked');
  });

  it('persists a durable, queryable connection_status_events row for the transition (FR26)', () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'amazon', { token: 'x' });

    recordSuspensionSignal(tenant.tenantId, connection.id, 'suspicious_login_pattern', 'suspended');

    const events = statusEventsFor(connection.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      from_status: 'active',
      to_status: 'suspended',
      reason: 'suspicious_login_pattern',
    });
    expect(events[0].detected_at).toBeTruthy();
  });

  it('rejects a signal that would be a no-op transition (already in the target status)', () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'depop', { token: 'x' });
    recordSuspensionSignal(tenant.tenantId, connection.id, 'first_signal', 'suspended');

    expect(() =>
      recordSuspensionSignal(tenant.tenantId, connection.id, 'duplicate_signal', 'suspended'),
    ).toThrow(ConnectionValidationError);

    // Only the one real transition was recorded.
    expect(statusEventsFor(connection.id)).toHaveLength(1);
  });

  it('rejects a signal for a connection scoped to the wrong tenant, and leaves the real owner\'s status untouched', () => {
    const owner = createTestTenant();
    const intruder = createTestTenant();
    const connection = createConnection(owner.tenantId, 'mercari', { token: 'x' });

    expect(() =>
      recordSuspensionSignal(intruder.tenantId, connection.id, 'forged_signal', 'suspended'),
    ).toThrow(ConnectionValidationError);

    expect(getConnection(owner.tenantId, connection.id)?.status).toBe('active');
  });
});

describe('AC11: a connection suspended mid-session blocks the next automation attempt', () => {
  it('assertCanAutomate flips from ok:true to not_active the moment a suspension signal lands', () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'poshmark', { token: 'x' });
    const currentVersion = getCurrentDisclosureVersion().version;
    recordConsent(tenant.tenantId, connection.id, currentVersion);

    // "Session start": the first automated action is allowed.
    expect(assertCanAutomate(tenant.tenantId, connection.id)).toEqual({ ok: true });

    // Mid-session: the marketplace reports a suspension.
    recordSuspensionSignal(tenant.tenantId, connection.id, 'mid_session_suspension', 'suspended');

    // The very next action attempt on the same connection is blocked.
    expect(assertCanAutomate(tenant.tenantId, connection.id)).toEqual({
      ok: false,
      reason: 'not_active',
    });
  });

  it('a revoked connection is blocked the same way as a suspended one', () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'vinted', { token: 'x' });
    const currentVersion = getCurrentDisclosureVersion().version;
    recordConsent(tenant.tenantId, connection.id, currentVersion);
    expect(assertCanAutomate(tenant.tenantId, connection.id)).toEqual({ ok: true });

    recordSuspensionSignal(tenant.tenantId, connection.id, 'permanent_ban', 'revoked');

    expect(assertCanAutomate(tenant.tenantId, connection.id)).toEqual({
      ok: false,
      reason: 'not_active',
    });
  });
});

describe('AC12: a suspended connection never auto-heals absent an explicit reactivation call', () => {
  it('status remains suspended across repeated read-only checks with no reactivation call made', () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'grailed', { token: 'x' });
    recordSuspensionSignal(tenant.tenantId, connection.id, 'auto_heal_probe', 'suspended');

    // Repeated reads and automation-eligibility checks are the closest
    // in-process proxy for "time passing" / "process restart" available to
    // a synchronous unit test — none of them are allowed to be the thing
    // that flips status back to active.
    for (let i = 0; i < 5; i++) {
      expect(getConnection(tenant.tenantId, connection.id)?.status).toBe('suspended');
      expect(assertCanAutomate(tenant.tenantId, connection.id).ok).toBe(false);
    }
  });

  it('only an explicit reactivateConnection() call moves status back to active', () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'ebay', { token: 'x' });
    recordSuspensionSignal(tenant.tenantId, connection.id, 'needs_manual_review', 'suspended');
    expect(getConnection(tenant.tenantId, connection.id)?.status).toBe('suspended');

    const reactivated = reactivateConnection(tenant.tenantId, connection.id);

    expect(reactivated.status).toBe('active');
    const events = statusEventsFor(connection.id);
    expect(events[events.length - 1]).toMatchObject({
      from_status: 'suspended',
      to_status: 'active',
      reason: 'manual_reactivation',
    });
  });

  it('reactivating an already-active connection throws ConnectionNotSuspendedError', () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'etsy', { token: 'x' });
    expect(() => reactivateConnection(tenant.tenantId, connection.id)).toThrow(ConnectionNotSuspendedError);
  });

  it('reactivating a revoked connection throws ConnectionNotSuspendedError (no reactivate path from revoked)', () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'amazon', { token: 'x' });
    recordSuspensionSignal(tenant.tenantId, connection.id, 'permanent_ban', 'revoked');
    expect(() => reactivateConnection(tenant.tenantId, connection.id)).toThrow(ConnectionNotSuspendedError);
    expect(getConnection(tenant.tenantId, connection.id)?.status).toBe('revoked');
  });
});

describe('POST /api/connections/:id/reactivate', () => {
  it('returns 401 when no tenant session is present (no cookie at all)', async () => {
    const id = '00000000-0000-4000-8000-999999999999';
    const res = await reactivatePOST(postReq(reactivateUrl(id)), params(id));
    expect(res.status).toBe(401);
  });

  it('reactivates a suspended connection, 200, status active', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'depop', { token: 'x' });
    recordSuspensionSignal(tenant.tenantId, connection.id, 'route_test', 'suspended');

    const res = await reactivatePOST(postReq(reactivateUrl(connection.id), tenant.cookieHeader), params(connection.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
  });

  it('returns 409 not_suspended for an already-active connection', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'mercari', { token: 'x' });

    const res = await reactivatePOST(postReq(reactivateUrl(connection.id), tenant.cookieHeader), params(connection.id));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('not_suspended');
  });

  it('returns 409 not_suspended for a revoked connection (no reactivate path)', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'poshmark', { token: 'x' });
    recordSuspensionSignal(tenant.tenantId, connection.id, 'permanent_ban', 'revoked');

    const res = await reactivatePOST(postReq(reactivateUrl(connection.id), tenant.cookieHeader), params(connection.id));
    expect(res.status).toBe(409);
  });

  it('returns 404 (AC2) when a different tenant attempts to reactivate a connection they don\'t own', async () => {
    const owner = createTestTenant();
    const intruder = createTestTenant();
    const connection = createConnection(owner.tenantId, 'vinted', { token: 'x' });
    recordSuspensionSignal(owner.tenantId, connection.id, 'route_test', 'suspended');

    const res = await reactivatePOST(postReq(reactivateUrl(connection.id), intruder.cookieHeader), params(connection.id));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found.');

    // The real owner's connection is untouched by the intruder's attempt.
    expect(getConnection(owner.tenantId, connection.id)?.status).toBe('suspended');
  });

  it('a non-ConnectionValidationError raised during reactivation is a 500, not misreported as 404/409', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'poshmark', { token: 'x' });
    recordSuspensionSignal(tenant.tenantId, connection.id, 'test_suspend', 'suspended');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes("SET status = 'active'")) {
        throw new Error('simulated disk failure');
      }
      return realPrepare(sql);
    });

    try {
      const res = await reactivatePOST(postReq(reactivateUrl(connection.id), tenant.cookieHeader), params(connection.id));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Internal server error.');
    } finally {
      prepareSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('kill-switch status is visible to the owning tenant via the API (FR27)', () => {
  it('GET /api/connections/:id reflects a suspended status without inspecting logs or the DB directly', async () => {
    const tenant = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'grailed', { token: 'x' });
    recordSuspensionSignal(tenant.tenantId, connection.id, 'visibility_check', 'suspended');

    const res = await connectionGET(getReq(connectionUrl(connection.id), tenant.cookieHeader), params(connection.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('suspended');
  });
});
