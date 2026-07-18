import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { NextResponse } from 'next/server';
import db from '@/lib/db';
import { SESSION_COOKIE_NAME } from '@/lib/constants';
import { seedStarterVocabulary } from '@/lib/vocabSeed';

// ---------------------------------------------------------------------------
// Session tokens -- mirrors lib/pairingToken.ts's exact hashed-token idiom:
// 32 random bytes (256 bits), hex-encoded → 64 hex chars. This is the raw
// token handed to the browser (only via an httpOnly cookie); only its
// SHA-256 hash is ever persisted (tenant_sessions.session_token_hash).
// ---------------------------------------------------------------------------
const TOKEN_BYTES = 32;
const TOKEN_HEX_RE = /^[0-9a-f]{64}$/;

// Session TTL: 7 days. There is no refresh/sliding-expiry mechanic here --
// "session management mechanics" beyond issuance/validation are explicitly
// out of scope (requirements.md "Out of scope"). A session simply expires
// and the tenant logs in again.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Password hashing -- Node built-in crypto.scryptSync (Technology choices:
// no bcrypt/argon2 dependency). Cost parameters meet the OWASP baseline
// floor (N>=16384, r=8, p>=1) and are exported so a test can assert that
// floor is actually met, per the NFR.
// ---------------------------------------------------------------------------
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

// Password strength floor (NFR: "minimum length requirement"). This is a
// floor, not a full strength-meter -- password-reset/MFA/general strength
// tooling is explicitly out of scope.
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Hash a password with scrypt, packing cost params + salt + derived key into
 * a single stored string: "N:r:p:salt_hex:hash_hex" (per the column comment
 * on tenants.password_hash in data/migrations/005_tenants.sql). Packing the
 * params alongside the hash means a future cost-parameter bump doesn't
 * invalidate already-stored hashes -- verification always uses whatever
 * params a given hash was created with, not today's SCRYPT_PARAMS.
 */
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return `${SCRYPT_PARAMS.N}:${SCRYPT_PARAMS.r}:${SCRYPT_PARAMS.p}:${salt.toString('hex')}:${derivedKey.toString('hex')}`;
}

/**
 * Recompute scrypt over `password` using the params/salt packed into
 * `packedHash`, then compare against the packed hash with timingSafeEqual
 * (never `===`, which short-circuits on the first differing byte and leaks
 * timing). Malformed packed strings (e.g. the seeded default tenant's
 * deliberately-unusable "unclaimed" placeholder -- see 005_tenants.sql)
 * fail closed without doing any scrypt work.
 */
function verifyPasswordHash(password: string, packedHash: string): boolean {
  const parts = packedHash.split(':');
  if (parts.length !== 5) {
    return false;
  }
  const [nStr, rStr, pStr, saltHex, hashHex] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  const derived = crypto.scryptSync(password, salt, expected.length, { N, r, p });
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

// A fixed, validly-packed dummy hash, computed once at module load. Used by
// verifyPassword below to pay the same scrypt cost when an email doesn't
// exist as when it does, so a login attempt's timing can't be used to probe
// whether an account exists (login must return the same failure for
// "no such email" and "wrong password" -- API contract for POST
// /api/auth/login).
const DUMMY_PACKED_HASH = hashPassword(crypto.randomBytes(SALT_BYTES).toString('hex'));

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`Email already registered: ${email}`);
    this.name = 'DuplicateEmailError';
  }
}

export class WeakPasswordError extends Error {
  constructor() {
    super(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    this.name = 'WeakPasswordError';
  }
}

interface TenantRow {
  id: string;
  email: string;
  password_hash: string;
}

/**
 * Create a new tenant: validates the password meets the minimum-length
 * floor, hashes it with scrypt, and inserts a `tenants` row. Throws
 * WeakPasswordError if the password is too short, or DuplicateEmailError if
 * the email is already taken (tenants.email is UNIQUE COLLATE NOCASE at the
 * DB level; this catches that constraint violation and re-throws it as a
 * typed error callers can distinguish without string-matching a SQLite
 * error message).
 */
export function createTenant(email: string, password: string): { tenantId: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError();
  }

  const id = uuidv4();
  const passwordHash = hashPassword(password);

  // Wrap the tenants INSERT and starter-vocabulary seeding in one atomic
  // unit, so every new tenant either gets both a row and its 14
  // colors/materials/departments/brands, or gets neither on failure.
  //
  // seedStarterVocabulary() internally calls its own db.transaction() --
  // better-sqlite3 supports this nesting natively (verified against the
  // installed better-sqlite3@12.11.1: lib/methods/transaction.js checks
  // db.inTransaction and, when already inside one, uses a SAVEPOINT/RELEASE/
  // ROLLBACK TO pair instead of BEGIN/COMMIT/ROLLBACK -- so the inner call
  // composes into this outer transaction rather than throwing "transaction
  // already running", and an error from either step unwinds the whole
  // thing).
  const createTenantTx = db.transaction(() => {
    try {
      db.prepare('INSERT INTO tenants (id, email, password_hash) VALUES (?, ?, ?)').run(
        id,
        email,
        passwordHash,
      );
    } catch (err) {
      // Scoped to just the tenants INSERT so a constraint violation from
      // the seeding step below (which should never legitimately happen for
      // a brand-new id) is never misreported as a duplicate email.
      const code = (err as { code?: string } | undefined)?.code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw new DuplicateEmailError(email);
      }
      throw err;
    }

    seedStarterVocabulary(id);
  });

  createTenantTx();

  return { tenantId: id };
}

/**
 * Verify an email/password pair. Returns the tenant id on success, or null
 * on any failure -- a nonexistent email and a wrong password are
 * indistinguishable from the caller's perspective (same null return, same
 * approximate timing via DUMMY_PACKED_HASH above), so a login endpoint can't
 * be used to enumerate registered emails.
 */
export function verifyPassword(email: string, password: string): string | null {
  const row = db
    .prepare('SELECT id, email, password_hash FROM tenants WHERE email = ? COLLATE NOCASE')
    .get(email) as TenantRow | undefined;

  const packedHash = row ? row.password_hash : DUMMY_PACKED_HASH;
  const ok = verifyPasswordHash(password, packedHash);

  if (!row || !ok) {
    return null;
  }
  return row.id;
}

/**
 * Look up a tenant by email (case-insensitive). Returns the tenant id if
 * found, or null if no tenant with that email exists. Used by middleware
 * to resolve tenants from verified JWT email claims.
 */
export function findTenantByEmail(email: string): string | null {
  const row = db
    .prepare('SELECT id FROM tenants WHERE email = ? COLLATE NOCASE LIMIT 1')
    .get(email) as { id: string } | undefined;
  return row ? row.id : null;
}

interface TenantSessionRow {
  id: string;
  tenant_id: string;
  session_token_hash: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

/**
 * Issue a fresh session for a tenant. Returns the RAW token -- the only time
 * it is ever available; only its SHA-256 hash is stored (tenant_sessions.
 * session_token_hash).
 */
export function createSession(tenantId: string): { token: string; expiresAt: number } {
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(rawToken);
  const id = uuidv4();
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_TTL_MS;

  db.prepare(
    `INSERT INTO tenant_sessions (id, tenant_id, session_token_hash, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(id, tenantId, tokenHash, createdAt, expiresAt);

  return { token: rawToken, expiresAt };
}

export interface ResolvedSession {
  tenantId: string;
  sessionId: string;
}

/**
 * Resolve a raw session token (as read from the reseller_session cookie)
 * back to its tenant/session identity, or null if it's malformed, unknown,
 * expired, or revoked. Mirrors lib/pairingToken.ts::resolveToken's shape.
 */
export function resolveSession(rawToken: string): ResolvedSession | null {
  // Reject malformed input before hashing at all -- a valid raw token is
  // always exactly 64 lowercase hex chars (32 random bytes, hex-encoded).
  if (!TOKEN_HEX_RE.test(rawToken)) {
    return null;
  }

  const tokenHash = hashToken(rawToken);
  const row = db
    .prepare('SELECT * FROM tenant_sessions WHERE session_token_hash = ?')
    .get(tokenHash) as TenantSessionRow | undefined;

  if (!row) {
    return null;
  }

  // Defense-in-depth: confirm the match with a constant-time comparison
  // rather than trusting `WHERE session_token_hash = ?` alone, same
  // reasoning as lib/pairingToken.ts::resolveToken.
  const rowHashBuf = Buffer.from(row.session_token_hash, 'hex');
  const computedHashBuf = Buffer.from(tokenHash, 'hex');
  if (
    rowHashBuf.length !== computedHashBuf.length ||
    !crypto.timingSafeEqual(rowHashBuf, computedHashBuf)
  ) {
    return null;
  }

  if (row.revoked_at !== null || Date.now() > row.expires_at) {
    return null;
  }

  return { tenantId: row.tenant_id, sessionId: row.id };
}

/**
 * Revoke a session by its raw token (e.g. on logout). Idempotent: revoking
 * an already-revoked, expired, unknown, or malformed token is a no-op.
 */
export function revokeSession(rawToken: string): void {
  if (!TOKEN_HEX_RE.test(rawToken)) {
    return;
  }
  const tokenHash = hashToken(rawToken);
  db.prepare(
    'UPDATE tenant_sessions SET revoked_at = ? WHERE session_token_hash = ? AND revoked_at IS NULL',
  ).run(Date.now(), tokenHash);
}

// ---------------------------------------------------------------------------
// Cookie helpers -- thin wrappers around NextResponse's built-in cookie jar
// (Technology choices: no separate cookie-parsing library). httpOnly is a
// hard NFR (must be verified by an automated test asserting the cookie's
// flags) and is always set explicitly, never left to a default.
//
// `secure` is gated on NODE_ENV=production rather than hardcoded true: this
// app is local-first and, per middleware.ts's CSRF comment, is designed to
// run bound to localhost (and, per this repo's deployment notes, reachable
// over plain-HTTP Tailscale/LAN in some deployments) -- unconditionally
// requiring `secure` would make the session cookie silently never get set
// over that plain-HTTP path. In production builds it's on.
// ---------------------------------------------------------------------------
const COOKIE_SECURE = process.env.NODE_ENV === 'production';

/**
 * Set the session cookie on a response after a successful signup/login.
 * `expiresAt` is the epoch-ms value returned by createSession.
 */
export function setSessionCookie(
  response: NextResponse,
  rawToken: string,
  expiresAt: number,
): void {
  response.cookies.set(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    path: '/',
    expires: new Date(expiresAt),
  });
}

/**
 * Clear the session cookie on a response (e.g. on logout). Flags must match
 * setSessionCookie's for the browser to actually overwrite/expire the
 * existing cookie rather than setting an unrelated one.
 */
export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: 0,
  });
}
