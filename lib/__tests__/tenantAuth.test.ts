import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import db from '@/lib/db';
import {
  createTenant,
  verifyPassword,
  resolveSession,
  revokeSession,
  setSessionCookie,
  clearSessionCookie,
  DuplicateEmailError,
} from '@/lib/tenantAuth';

// Unit-level coverage for lib/tenantAuth.ts's internal branches that aren't
// already exercised black-box through tests/api/auth.test.ts's route tests
// -- see docs comment in tests/helpers/tenant.ts pointing here. Written
// after a Stryker mutation pass surfaced survivors in: verifyPasswordHash's
// malformed-input handling, createTenant's non-constraint DB error path,
// and the session cookie's exact Set-Cookie attributes (not just presence).

function uniqueEmail(tag: string): string {
  return `${tag}-${crypto.randomUUID()}@example.invalid`;
}

describe('verifyPassword / verifyPasswordHash malformed stored-hash handling', () => {
  it('authenticates with a genuinely correct password against a real createTenant-produced hash (positive control)', () => {
    const email = uniqueEmail('good-hash');
    const password = 'a-perfectly-fine-password';
    const { tenantId } = createTenant(email, password);

    expect(verifyPassword(email, password)).toBe(tenantId);
  });

  it('rejects the correct email with a wrong password against a real hash (positive control, negative case)', () => {
    const email = uniqueEmail('wrong-pw');
    createTenant(email, 'the-real-password-here');

    expect(verifyPassword(email, 'not-the-real-password')).toBeNull();
  });

  it('returns null (never throws) for a stored hash with too few colon-separated parts', () => {
    const email = uniqueEmail('short-parts');
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO tenants (id, email, password_hash) VALUES (?, ?, ?)').run(
      id,
      email,
      '16384:8:1:deadbeef', // 4 parts, missing the hash segment
    );

    expect(() => verifyPassword(email, 'anything')).not.toThrow();
    expect(verifyPassword(email, 'anything')).toBeNull();
  });

  it('returns null (never throws) for a stored hash with too many colon-separated parts', () => {
    const email = uniqueEmail('long-parts');
    db.prepare('INSERT INTO tenants (id, email, password_hash) VALUES (?, ?, ?)').run(
      crypto.randomUUID(),
      email,
      '16384:8:1:deadbeef:cafebabe:extra',
    );

    expect(verifyPassword(email, 'anything')).toBeNull();
  });

  it('returns null (never throws) when N/r/p are non-numeric', () => {
    const email = uniqueEmail('non-numeric-params');
    db.prepare('INSERT INTO tenants (id, email, password_hash) VALUES (?, ?, ?)').run(
      crypto.randomUUID(),
      email,
      'not-a-number:8:1:deadbeef:cafebabe',
    );

    expect(() => verifyPassword(email, 'anything')).not.toThrow();
    expect(verifyPassword(email, 'anything')).toBeNull();
  });

  it('returns null (never throws) when N/r/p are non-integer floats', () => {
    const email = uniqueEmail('float-params');
    db.prepare('INSERT INTO tenants (id, email, password_hash) VALUES (?, ?, ?)').run(
      crypto.randomUUID(),
      email,
      '16384.5:8:1:deadbeef:cafebabe',
    );

    expect(verifyPassword(email, 'anything')).toBeNull();
  });

  it('returns null (never throws) when the salt hex decodes to zero bytes', () => {
    const email = uniqueEmail('empty-salt');
    db.prepare('INSERT INTO tenants (id, email, password_hash) VALUES (?, ?, ?)').run(
      crypto.randomUUID(),
      email,
      '16384:8:1::cafebabe', // empty salt segment
    );

    expect(verifyPassword(email, 'anything')).toBeNull();
  });

  it('returns null (never throws) when the derived-key hex decodes to zero bytes', () => {
    const email = uniqueEmail('empty-hash');
    db.prepare('INSERT INTO tenants (id, email, password_hash) VALUES (?, ?, ?)').run(
      crypto.randomUUID(),
      email,
      '16384:8:1:deadbeef:', // empty hash segment
    );

    expect(verifyPassword(email, 'anything')).toBeNull();
  });

  it('returns null (never throws) for the seeded "unclaimed" placeholder-style malformed hash', () => {
    // Mirrors data/migrations/005_tenants.sql's deliberately-unusable
    // seeded default tenant row (comment: "password_hash is a deliberately
    // unusable placeholder, not a valid scrypt").
    const email = uniqueEmail('placeholder');
    db.prepare('INSERT INTO tenants (id, email, password_hash) VALUES (?, ?, ?)').run(
      crypto.randomUUID(),
      email,
      'unclaimed',
    );

    expect(() => verifyPassword(email, 'anything')).not.toThrow();
    expect(verifyPassword(email, 'anything')).toBeNull();
  });

  it('returns null for a nonexistent email without throwing (dummy-hash timing-safe path)', () => {
    expect(verifyPassword(uniqueEmail('no-such-user'), 'whatever')).toBeNull();
  });

  it('rejects an empty-string password against a real hash', () => {
    const email = uniqueEmail('empty-pw-check');
    createTenant(email, 'a-real-password-1234');

    expect(verifyPassword(email, '')).toBeNull();
  });

  it('rejects a stored hash with a trailing extra segment even though the first five fields match a real hash exactly (parts.length !== 5 must fire before any comparison)', () => {
    // Distinguishes the parts.length !== 5 guard from a no-op: if it were
    // skipped, array destructuring would still pull out valid N/r/p/salt/hash
    // from the first five fields and the comparison below would genuinely
    // match, wrongly authenticating a corrupted stored hash.
    const email = uniqueEmail('extra-segment');
    const password = 'a-real-password-99999';
    createTenant(email, password);
    const row = db.prepare('SELECT password_hash FROM tenants WHERE email = ?').get(email) as {
      password_hash: string;
    };
    db.prepare('UPDATE tenants SET password_hash = ? WHERE email = ?').run(
      `${row.password_hash}:extra`,
      email,
    );

    expect(verifyPassword(email, password)).toBeNull();
  });

  it('rejects a stored hash with an empty salt segment even when the derived key was genuinely computed with an empty salt (salt.length === 0 guard must fire independently of comparison outcome)', () => {
    // Distinguishes the salt.length === 0 guard from a no-op: scryptSync
    // does not itself throw on a zero-length salt, so without this guard a
    // hash stored with an empty salt segment that happens to match would
    // wrongly authenticate.
    const password = 'empty-salt-password-123';
    const emptySalt = Buffer.alloc(0);
    const derived = crypto.scryptSync(password, emptySalt, 64, { N: 16384, r: 8, p: 1 });
    const packedHash = `16384:8:1::${derived.toString('hex')}`;
    const email = uniqueEmail('empty-salt-match');
    db.prepare('INSERT INTO tenants (id, email, password_hash) VALUES (?, ?, ?)').run(
      crypto.randomUUID(),
      email,
      packedHash,
    );

    expect(verifyPassword(email, password)).toBeNull();
  });

  it('verifies using the N/r/p params packed into the stored hash, not Node scryptSync defaults (which happen to equal SCRYPT_PARAMS)', () => {
    // SCRYPT_PARAMS (N=16384, r=8, p=1) is identical to Node's own scrypt
    // defaults, so a mutant that drops { N, r, p } entirely from the
    // scryptSync call is invisible against hashes created with those
    // params. A hash packed with a deliberately different N distinguishes
    // "uses the parsed params" from "uses whatever Node defaults to".
    const password = 'custom-cost-params-password';
    // r=4 differs from Node's scryptSync default (r=8, which happens to
    // equal SCRYPT_PARAMS.r) while staying well under the default memory
    // ceiling -- unlike bumping N, which can trip scrypt's maxmem guard.
    const N = 16384;
    const r = 4;
    const p = 1;
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync(password, salt, 64, { N, r, p });
    const packedHash = `${N}:${r}:${p}:${salt.toString('hex')}:${derived.toString('hex')}`;
    const email = uniqueEmail('custom-params');
    const tenantId = crypto.randomUUID();
    db.prepare('INSERT INTO tenants (id, email, password_hash) VALUES (?, ?, ?)').run(
      tenantId,
      email,
      packedHash,
    );

    expect(verifyPassword(email, password)).toBe(tenantId);
  });
});

describe('createTenant DB-error handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rethrows a non-constraint DB error as-is, not as DuplicateEmailError', () => {
    const email = uniqueEmail('db-error');
    const dbError = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });

    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO tenants')) {
        return { run: () => { throw dbError; } } as unknown as ReturnType<typeof db.prepare>;
      }
      return originalPrepare(sql);
    });

    let caught: unknown;
    try {
      createTenant(email, 'a-strong-enough-password');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(dbError);
    expect(caught).not.toBeInstanceOf(DuplicateEmailError);
  });

  it('still converts SQLITE_CONSTRAINT_UNIQUE specifically into DuplicateEmailError (contrast case)', () => {
    const email = uniqueEmail('real-dup');
    createTenant(email, 'a-strong-enough-password');

    expect(() => createTenant(email, 'a-different-password')).toThrow(DuplicateEmailError);
  });

  it('propagates a thrown non-Error value (e.g. undefined) as-is, without crashing on optional chaining into .code', () => {
    // If the `?.` in `(err as {code?: string} | undefined)?.code` were
    // replaced with a plain `.`, this would throw a TypeError instead of
    // re-throwing the original (non-Error) thrown value -- a real crash on
    // the error-handling path itself.
    const email = uniqueEmail('undefined-throw');
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO tenants')) {
        return { run: () => { throw undefined; } } as unknown as ReturnType<typeof db.prepare>;
      }
      return originalPrepare(sql);
    });

    let caught: unknown = 'sentinel-not-thrown';
    try {
      createTenant(email, 'a-strong-enough-password');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeUndefined();
  });

  it('converts SQLITE_CONSTRAINT_PRIMARYKEY the same way as SQLITE_CONSTRAINT_UNIQUE', () => {
    const email = uniqueEmail('pk-collision');
    const pkError = Object.assign(new Error('UNIQUE constraint failed: tenants.id'), {
      code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
    });

    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO tenants')) {
        return { run: () => { throw pkError; } } as unknown as ReturnType<typeof db.prepare>;
      }
      return originalPrepare(sql);
    });

    expect(() => createTenant(email, 'a-strong-enough-password')).toThrow(DuplicateEmailError);
  });
});

describe('resolveSession / revokeSession fail fast on malformed tokens without touching the DB', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolveSession never queries tenant_sessions for a malformed (non-hex-64) token', () => {
    // If the early `if (!TOKEN_HEX_RE.test(rawToken)) { return null; }`
    // guard's body were dropped, execution would fall through to hash the
    // malformed token and query the DB anyway -- still likely resolving to
    // null, but only by accident (no matching row), not by construction.
    // This asserts the actual short-circuit, not just the end result.
    const querySpy = vi.spyOn(db, 'prepare');
    const result = resolveSession('not-a-valid-hex-token');

    expect(result).toBeNull();
    const sessionQueries = querySpy.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('tenant_sessions'),
    );
    expect(sessionQueries.length).toBe(0);
  });

  it('revokeSession never touches tenant_sessions for a malformed (non-hex-64) token', () => {
    const querySpy = vi.spyOn(db, 'prepare');
    revokeSession('not-a-valid-hex-token');

    const updateQueries = querySpy.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('tenant_sessions'),
    );
    expect(updateQueries.length).toBe(0);
  });
});

describe('session cookie attributes (setSessionCookie / clearSessionCookie)', () => {
  it('setSessionCookie sets httpOnly, sameSite=lax, path=/, and an Expires attribute derived from expiresAt', () => {
    const response = NextResponse.json({ ok: true }, { status: 200 });
    const expiresAt = Date.now() + 60_000;
    setSessionCookie(response, 'a'.repeat(64), expiresAt);

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Expires=');
    expect(setCookie).toContain(new Date(expiresAt).toUTCString());
  });

  it('clearSessionCookie sets httpOnly, sameSite=lax, path=/, and Max-Age=0 (not just an emptied value)', () => {
    const response = new NextResponse(null, { status: 204 });
    clearSessionCookie(response);

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=0');
  });

  it('clearSessionCookie always sets the cookie value to empty, regardless of what token is passed in', () => {
    const response = new NextResponse(null, { status: 204 });
    clearSessionCookie(response);

    const setCookie = response.headers.get('set-cookie') ?? '';
    // Value should be empty before the first ';' attribute separator.
    expect(setCookie.split(';')[0]).toMatch(/=$/);
  });
});
