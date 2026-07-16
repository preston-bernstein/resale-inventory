import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as connectionsGET, POST as connectionsPOST } from '@/app/api/connections/route';
import { GET as connectionGET } from '@/app/api/connections/[id]/route';
import { PATCH as credentialPATCH } from '@/app/api/connections/[id]/credential/route';
import db from '@/lib/db';
import {
  recordSuspensionSignal,
  getDecryptedCredential,
  listConnections,
  getConnection,
  createConnection,
  deleteConnection,
  ConnectionValidationError,
} from '@/lib/connections';
import { createTestTenant } from '../helpers/tenant';

// ---------------------------------------------------------------------------
// Acceptance tests for AC2 (cross-tenant 404), AC3 (cross-tenant credential
// queries return zero rows), AC4 (no raw secret ever leaks into a response,
// log line, or error message), and AC5 (raw SQLite credential column is not
// plaintext-recoverable). See requirements.md's Acceptance criteria and
// plan.md's Connections API contract.
// ---------------------------------------------------------------------------

function connectionsUrl() {
  return 'http://localhost/api/connections';
}
function connectionUrl(id: string) {
  return `http://localhost/api/connections/${id}`;
}
function credentialUrl(id: string) {
  return `http://localhost/api/connections/${id}/credential`;
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
function patchReq(url: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}
function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function createViaApi(cookie: string, platform: string, credential: unknown) {
  const res = await connectionsPOST(postReq(connectionsUrl(), { platform, credential }, cookie));
  const body = await res.json();
  return { res, body };
}

describe('POST /api/connections', () => {
  it('returns 401 when no tenant session is present (no cookie at all)', async () => {
    const res = await connectionsPOST(
      postReq(connectionsUrl(), { platform: 'ebay', credential: { a: 1 } }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects malformed JSON body, 400 Invalid JSON body', async () => {
    const tenant = createTestTenant();
    const req = new NextRequest(connectionsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: tenant.cookieHeader },
      body: '{not valid json',
    });
    const res = await connectionsPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid JSON body.');
  });

  it('a JSON body of literal null is treated as a missing platform, 422 invalid_platform (not a 500 crash)', async () => {
    const tenant = createTestTenant();
    const req = new NextRequest(connectionsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: tenant.cookieHeader },
      body: 'null',
    });
    const res = await connectionsPOST(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('invalid_platform');
  });

  it('creates a connection: 201, metadata-only shape, no credential field', async () => {
    const tenant = createTestTenant();
    const { res, body } = await createViaApi(tenant.cookieHeader, 'ebay', { apiKey: 'irrelevant-here' });
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ platform: 'ebay', status: 'active' });
    expect(body).not.toHaveProperty('credential');
    expect(body).not.toHaveProperty('encrypted_credential');
    expect(body.id).toBeTruthy();
  });

  it('rejects an unsupported platform, 422 invalid_platform', async () => {
    const tenant = createTestTenant();
    const res = await connectionsPOST(
      postReq(connectionsUrl(), { platform: 'not-a-real-platform', credential: { a: 1 } }, tenant.cookieHeader),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('invalid_platform');
  });

  it.each([
    ['a string', 'not-an-object'],
    ['an array', ['a', 'b']],
    ['null', null],
  ])('rejects a credential that is %s, 422 invalid_credential', async (_label, credential) => {
    const tenant = createTestTenant();
    const res = await connectionsPOST(
      postReq(connectionsUrl(), { platform: 'ebay', credential }, tenant.cookieHeader),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('invalid_credential');
  });

  it('rejects a second connection for the same (tenant, platform) while active, 409 connection_exists', async () => {
    const tenant = createTestTenant();
    await createViaApi(tenant.cookieHeader, 'etsy', { token: 'one' });
    const res = await connectionsPOST(
      postReq(connectionsUrl(), { platform: 'etsy', credential: { token: 'two' } }, tenant.cookieHeader),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('connection_exists');
  });

  it('rejects a second connection while the existing one is suspended, 409 connection_exists', async () => {
    const tenant = createTestTenant();
    const { body: created } = await createViaApi(tenant.cookieHeader, 'amazon', { token: 'one' });
    recordSuspensionSignal(tenant.tenantId, created.id, 'test_suspend', 'suspended');

    const res = await connectionsPOST(
      postReq(connectionsUrl(), { platform: 'amazon', credential: { token: 'two' } }, tenant.cookieHeader),
    );
    expect(res.status).toBe(409);
  });

  it('a revoked connection can be fully reconnected: 201, fresh id, no stale consent carried over', async () => {
    const tenant = createTestTenant();
    const { body: created } = await createViaApi(tenant.cookieHeader, 'depop', { token: 'one' });
    recordSuspensionSignal(tenant.tenantId, created.id, 'test_revoke', 'revoked');

    const res = await connectionsPOST(
      postReq(connectionsUrl(), { platform: 'depop', credential: { token: 'two' } }, tenant.cookieHeader),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).not.toBe(created.id);
    expect(body.status).toBe('active');

    // The old connection row (and its cascaded consent/status-event rows) is
    // gone, not merely status-flipped.
    const oldRow = db.prepare('SELECT id FROM platform_connections WHERE id = ?').get(created.id);
    expect(oldRow).toBeUndefined();
  });
});

describe('lib/connections.ts deleteConnection (used, unchecked, by the revoked-reconnect transaction)', () => {
  it('returns true when a row is actually deleted, and false for a nonexistent or cross-tenant id', () => {
    const tenant = createTestTenant();
    const intruder = createTestTenant();
    const connection = createConnection(tenant.tenantId, 'ebay', { token: 'x' });

    // Cross-tenant attempt: matches no row, must report false and leave the
    // real owner's connection untouched.
    expect(deleteConnection(intruder.tenantId, connection.id)).toBe(false);
    expect(getConnection(tenant.tenantId, connection.id)).not.toBeNull();

    // Nonexistent id: also false.
    expect(deleteConnection(tenant.tenantId, '00000000-0000-4000-8000-999999999999')).toBe(false);

    // A real delete: true, and the row is actually gone.
    expect(deleteConnection(tenant.tenantId, connection.id)).toBe(true);
    expect(getConnection(tenant.tenantId, connection.id)).toBeNull();
  });
});

describe('GET /api/connections/:id (AC2: cross-tenant 404)', () => {
  it('returns 401 when no tenant session is present (no cookie at all)', async () => {
    const id = '00000000-0000-4000-8000-999999999999';
    const res = await connectionGET(getReq(connectionUrl(id)), params(id));
    expect(res.status).toBe(401);
  });

  it('returns the owning tenant\'s connection metadata, 200', async () => {
    const tenant = createTestTenant();
    const { body: created } = await createViaApi(tenant.cookieHeader, 'mercari', { token: 'x' });

    const res = await connectionGET(getReq(connectionUrl(created.id), tenant.cookieHeader), params(created.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
  });

  it('returns 404 (not 403, not the data) when a different tenant requests the connection', async () => {
    const owner = createTestTenant();
    const intruder = createTestTenant();
    const { body: created } = await createViaApi(owner.cookieHeader, 'vinted', { token: 'owner-secret' });

    const res = await connectionGET(getReq(connectionUrl(created.id), intruder.cookieHeader), params(created.id));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found.');
    expect(body).not.toHaveProperty('platform');
    expect(JSON.stringify(body)).not.toContain('owner-secret');
  });

  it('returns 404 for a nonexistent connection id', async () => {
    const tenant = createTestTenant();
    const res = await connectionGET(
      getReq(connectionUrl('00000000-0000-4000-8000-999999999999'), tenant.cookieHeader),
      params('00000000-0000-4000-8000-999999999999'),
    );
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/connections/:id/credential (AC2: cross-tenant 404)', () => {
  it('returns 401 when no tenant session is present (no cookie at all)', async () => {
    const id = '00000000-0000-4000-8000-999999999999';
    const res = await credentialPATCH(patchReq(credentialUrl(id), { credential: { a: 1 } }), params(id));
    expect(res.status).toBe(401);
  });

  it('rotates the credential and returns metadata only', async () => {
    const tenant = createTestTenant();
    const { body: created } = await createViaApi(tenant.cookieHeader, 'grailed', { token: 'old' });
    const beforeRow = db
      .prepare('SELECT encrypted_credential FROM platform_connections WHERE id = ?')
      .get(created.id) as { encrypted_credential: Buffer };

    const res = await credentialPATCH(
      patchReq(credentialUrl(created.id), { credential: { token: 'new-value' } }, tenant.cookieHeader),
      params(created.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('credential');

    const afterRow = db
      .prepare('SELECT encrypted_credential FROM platform_connections WHERE id = ?')
      .get(created.id) as { encrypted_credential: Buffer };
    expect(Buffer.compare(beforeRow.encrypted_credential, afterRow.encrypted_credential)).not.toBe(0);
  });

  it('returns 404 when a different tenant attempts to rotate the credential', async () => {
    const owner = createTestTenant();
    const intruder = createTestTenant();
    const { body: created } = await createViaApi(owner.cookieHeader, 'ebay', { token: 'owner-only' });

    const res = await credentialPATCH(
      patchReq(credentialUrl(created.id), { credential: { token: 'hijacked' } }, intruder.cookieHeader),
      params(created.id),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found.');

    // Confirm the credential was NOT actually rotated by the intruder's attempt.
    const decrypted = getDecryptedCredential(owner.tenantId, created.id) as { token: string };
    expect(decrypted.token).toBe('owner-only');
  });

  it('rejects an invalid credential shape, 422 invalid_credential', async () => {
    const tenant = createTestTenant();
    const { body: created } = await createViaApi(tenant.cookieHeader, 'etsy', { token: 'x' });
    const res = await credentialPATCH(
      patchReq(credentialUrl(created.id), { credential: 'not-an-object' }, tenant.cookieHeader),
      params(created.id),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('invalid_credential');
  });

  it('a non-ConnectionValidationError raised during rotation is a 500, not misreported as 404/422', async () => {
    const tenant = createTestTenant();
    const { body: created } = await createViaApi(tenant.cookieHeader, 'grailed', { token: 'x' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('SET encrypted_credential')) {
        throw new Error('simulated disk failure');
      }
      return realPrepare(sql);
    });

    try {
      const res = await credentialPATCH(
        patchReq(credentialUrl(created.id), { credential: { token: 'new' } }, tenant.cookieHeader),
        params(created.id),
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

describe('AC3: cross-tenant credential queries return zero rows', () => {
  it('listConnections/getConnection for tenant B never surface tenant A\'s connection', async () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();
    const { body: createdA } = await createViaApi(tenantA.cookieHeader, 'poshmark', { token: 'a-secret' });
    await createViaApi(tenantB.cookieHeader, 'mercari', { token: 'b-secret' });

    expect(getConnection(tenantB.tenantId, createdA.id)).toBeNull();
    expect(listConnections(tenantB.tenantId).some((c) => c.id === createdA.id)).toBe(false);

    // The literal query shape every lib/connections.ts function uses,
    // exercised directly against the raw table: zero rows, not an empty
    // credential or a null field on a matched row.
    const rows = db
      .prepare('SELECT * FROM platform_connections WHERE id = ? AND tenant_id = ?')
      .all(createdA.id, tenantB.tenantId);
    expect(rows).toHaveLength(0);
  });

  it('getDecryptedCredential scoped to the wrong tenant throws instead of returning any value', async () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();
    const { body: createdA } = await createViaApi(tenantA.cookieHeader, 'grailed', { token: 'a-secret-2' });

    expect(() => getDecryptedCredential(tenantB.tenantId, createdA.id)).toThrow(ConnectionValidationError);
  });

  it('GET /api/connections only ever lists the calling tenant\'s own rows', async () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();
    await createViaApi(tenantA.cookieHeader, 'depop', { token: 'a' });
    await createViaApi(tenantB.cookieHeader, 'depop', { token: 'b' });

    const resA = await connectionsGET(getReq(connectionsUrl(), tenantA.cookieHeader));
    const bodyA = await resA.json();
    const resB = await connectionsGET(getReq(connectionsUrl(), tenantB.cookieHeader));
    const bodyB = await resB.json();

    const idsA = new Set(bodyA.map((c: { id: string }) => c.id));
    const idsB = new Set(bodyB.map((c: { id: string }) => c.id));
    expect([...idsA].some((id) => idsB.has(id))).toBe(false);
  });
});

describe('AC4: no raw credential/secret value ever appears in a response body, log line, or error message', () => {
  const SECRET_MARKER = 'MARKER_SECRET_9f3a7c2b_do_not_leak';

  it('the create response never contains the submitted secret', async () => {
    const tenant = createTestTenant();
    const { res, body } = await createViaApi(tenant.cookieHeader, 'ebay', { apiKey: SECRET_MARKER });
    expect(res.status).toBe(201);
    expect(JSON.stringify(body)).not.toContain(SECRET_MARKER);
  });

  it('the GET-by-id response never contains the secret', async () => {
    const tenant = createTestTenant();
    const { body: created } = await createViaApi(tenant.cookieHeader, 'etsy', { apiKey: SECRET_MARKER });
    const res = await connectionGET(getReq(connectionUrl(created.id), tenant.cookieHeader), params(created.id));
    const text = await res.text();
    expect(text).not.toContain(SECRET_MARKER);
  });

  it('a cross-tenant 404 error body never contains the owner\'s secret', async () => {
    const owner = createTestTenant();
    const intruder = createTestTenant();
    const { body: created } = await createViaApi(owner.cookieHeader, 'amazon', { apiKey: SECRET_MARKER });
    const res = await connectionGET(getReq(connectionUrl(created.id), intruder.cookieHeader), params(created.id));
    const text = await res.text();
    expect(text).not.toContain(SECRET_MARKER);
  });

  it('the credential-rotation response never contains the old or new secret', async () => {
    const tenant = createTestTenant();
    const OLD_SECRET = `${SECRET_MARKER}_old`;
    const NEW_SECRET = `${SECRET_MARKER}_new`;
    const { body: created } = await createViaApi(tenant.cookieHeader, 'vinted', { apiKey: OLD_SECRET });
    const res = await credentialPATCH(
      patchReq(credentialUrl(created.id), { credential: { apiKey: NEW_SECRET } }, tenant.cookieHeader),
      params(created.id),
    );
    const text = await res.text();
    expect(text).not.toContain(OLD_SECRET);
    expect(text).not.toContain(NEW_SECRET);
  });

  it('no console.log/console.error/console.warn call during create/read/rotate/cross-tenant-deny ever includes the secret', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const owner = createTestTenant();
      const intruder = createTestTenant();
      const { body: created } = await createViaApi(owner.cookieHeader, 'poshmark', { apiKey: SECRET_MARKER });
      await connectionGET(getReq(connectionUrl(created.id), owner.cookieHeader), params(created.id));
      await connectionGET(getReq(connectionUrl(created.id), intruder.cookieHeader), params(created.id));
      await credentialPATCH(
        patchReq(credentialUrl(created.id), { credential: { apiKey: `${SECRET_MARKER}_rotated` } }, owner.cookieHeader),
        params(created.id),
      );

      const allCalls = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls];
      for (const call of allCalls) {
        const serialized = call
          .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg, Object.getOwnPropertyNames(arg ?? {}))))
          .join(' ');
        expect(serialized).not.toContain(SECRET_MARKER);
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('a 500 triggered mid-create still never surfaces the secret in the response body', async () => {
    const tenant = createTestTenant();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO platform_connections')) {
        throw new Error('simulated disk failure');
      }
      return realPrepare(sql);
    });

    try {
      const res = await connectionsPOST(
        postReq(connectionsUrl(), { platform: 'ebay', credential: { apiKey: SECRET_MARKER } }, tenant.cookieHeader),
      );
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain(SECRET_MARKER);
      expect(JSON.parse(text).error).toBe('Internal server error.');
      for (const call of errorSpy.mock.calls) {
        const serialized = call
          .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg, Object.getOwnPropertyNames(arg ?? {}))))
          .join(' ');
        expect(serialized).not.toContain(SECRET_MARKER);
      }
    } finally {
      prepareSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('AC5: raw SQLite credential column is not plaintext-recoverable', () => {
  it('the raw encrypted_credential BLOB never equals or contains the plaintext secret', async () => {
    const tenant = createTestTenant();
    const PLAINTEXT_SECRET = 'PLAINTEXT_SECRET_VALUE_ABC_12345';
    const { body: created } = await createViaApi(tenant.cookieHeader, 'ebay', { token: PLAINTEXT_SECRET });

    const row = db
      .prepare('SELECT encrypted_credential FROM platform_connections WHERE id = ?')
      .get(created.id) as { encrypted_credential: Buffer };

    expect(Buffer.isBuffer(row.encrypted_credential)).toBe(true);
    // iv(12B) + authTag(16B) + >=1B ciphertext, per the migration's CHECK.
    expect(row.encrypted_credential.length).toBeGreaterThanOrEqual(29);

    const asUtf8 = row.encrypted_credential.toString('utf8');
    const asBase64 = row.encrypted_credential.toString('base64');
    const asHex = row.encrypted_credential.toString('hex');

    expect(asUtf8).not.toBe(PLAINTEXT_SECRET);
    expect(asUtf8).not.toContain(PLAINTEXT_SECRET);
    expect(asBase64).not.toContain(PLAINTEXT_SECRET);
    expect(asHex).not.toContain(Buffer.from(PLAINTEXT_SECRET, 'utf8').toString('hex'));
  });

  it('two connections with the same credential value produce different ciphertext (random IV, not deterministic encoding)', async () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();
    const SAME_SECRET = 'IDENTICAL_SECRET_VALUE';

    const { body: createdA } = await createViaApi(tenantA.cookieHeader, 'etsy', { token: SAME_SECRET });
    const { body: createdB } = await createViaApi(tenantB.cookieHeader, 'etsy', { token: SAME_SECRET });

    const rowA = db
      .prepare('SELECT encrypted_credential FROM platform_connections WHERE id = ?')
      .get(createdA.id) as { encrypted_credential: Buffer };
    const rowB = db
      .prepare('SELECT encrypted_credential FROM platform_connections WHERE id = ?')
      .get(createdB.id) as { encrypted_credential: Buffer };

    expect(Buffer.compare(rowA.encrypted_credential, rowB.encrypted_credential)).not.toBe(0);
  });
});
