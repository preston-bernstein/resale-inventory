# Plan: Multi-Tenant Foundation for Reseller/Cross-Listing Integration

## Approach

Add tenant identity as a first-class, additive layer on top of the existing single-file SQLite schema: a `tenants` table plus a `tenant_id` column on `items` and every satellite, a hashed-session-cookie auth mechanism (mirroring the existing `phone_pairing_tokens` hashed-token pattern in `lib/pairingToken.ts`), an encrypted-at-rest `platform_connections` table that unifies credential storage and kill-switch state per tenant+platform, and a small `disclosure_versions`/`tenant_consents` pair for ban-risk consent. Every new capability uses only Node's built-in `crypto` module (scrypt for passwords, AES-256-GCM for credentials, sha256+randomBytes for session tokens — all already precedented in this repo) and `better-sqlite3`'s synchronous transactions, so the kill-switch's "no delayed enforcement" requirement falls out of the existing architecture for free and no new npm dependency is needed. This fits the constraints because it never restructures `items` or its existing satellites (all additive `ALTER TABLE ADD COLUMN` / new tables), keeps the app's "zero external services" value intact, and centralizes the two enforcement-critical checks (connection status, consent validity) into one small module in the same spirit as `lib/transitions.ts`.

## Architecture

```
Browser
  |  Cookie: reseller_session (httpOnly, sha256-hashed at rest)
  v
middleware.ts  (UNCHANGED — CSRF Origin check on mutating /api/:path*, runs first,
                 orthogonal to tenant auth; a request must pass BOTH independently)
  v
Route handler (app/api/**)
  1. lib/apiRequest.ts :: requireTenant(request) -> { tenantId } | 401 NextResponse
       -> lib/tenantAuth.ts resolves session cookie -> tenant_sessions row (hashed lookup)
       -> EXCEPTION: app/api/phone-session/[token]/route.ts and the X-Pairing-Token
          header branch inside app/api/items/[id]/photos/route.ts do NOT call
          requireTenant() -- the paired phone authenticates via a 15-minute bearer
          pairing token in the URL/header (lib/pairingToken.ts's resolveToken) and
          never holds a reseller_session cookie. Tenant scope there comes from
          resolving pairing token -> item -> tenant_id instead. By contrast,
          app/api/items/[id]/phone-session/route.ts (which ISSUES a new pairing
          token -- the tenant's own browser, acting on their own item) DOES keep
          requireTenant() normally, same as every other retrofitted route.
  2. existing route logic, every db query now scoped: WHERE ... AND tenant_id = ?
       -> cross-tenant lookups naturally fall through to "not found" -> 404 (FR4)
  3. connection/consent-gated routes only:
       lib/automationGate.ts :: assertCanAutomate(tenantId, connectionId)
         -> lib/connections.ts   (status must be 'active')
         -> lib/consent.ts       (latest non-revoked consent must match current disclosure version)
  v
lib/db.ts (unchanged singleton, same VERSIONED_MIGRATIONS gate, same BOOKSELLER_DB_PATH override)
  |
  +-- tenants ---1:N--- tenant_sessions
  +-- tenants ---1:N--- items (+ tenant_id added to its 5 satellites: book_details,
  |                              clothing_details, item_platforms, item_photos, price_history)
  +-- tenants ---1:N--- platform_connections  (UNIQUE(tenant_id, platform); holds
  |     |                                       status + encrypted credential)
  |     +--1:N--- connection_status_events    (kill-switch audit trail)
  |     +--1:N--- tenant_consents
  +-- disclosure_versions ---1:N--- tenant_consents (by version number)

lib/credentialCrypto.ts (AES-256-GCM helpers, master key from BOOKSELLER_CREDENTIAL_KEY env
  var or a local data/credential.key fallback file, whose path is itself overridable
  via BOOKSELLER_CREDENTIAL_KEY_PATH -- see Integration points) is called ONLY from inside
  lib/connections.ts — no HTTP-facing code path in this increment ever decrypts or returns
  a credential value; the decrypt function exists solely for future connector code to consume.
```

Future connector code (out of scope here) is the intended caller of `lib/connections.ts::getDecryptedCredential()`, `lib/automationGate.ts::assertCanAutomate()`, and `lib/connections.ts::recordSuspensionSignal()` — this increment builds and tests those three entry points as the load-bearing contract, without any connector behind them yet.

## Data model

Four new additive migrations, `005`–`008`, appended to `VERSIONED_MIGRATIONS` in `lib/db.ts`. All new PKs use the existing UUIDv4 `CHECK (length(id) = 36 AND substr(id, 15, 1) = '4')` idiom from `004_phone_pairing_tokens.sql`. No existing table is dropped or rebuilt.

### `data/migrations/005_tenants.sql`

```sql
CREATE TABLE tenants (
  id            TEXT PRIMARY KEY
                CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- case-insensitive uniqueness --
                                                        -- otherwise Foo@x.com and foo@x.com
                                                        -- would collide at login but not at
                                                        -- signup, producing duplicate accounts
  password_hash TEXT NOT NULL,        -- scrypt, packed "N:r:p:salt_hex:hash_hex"
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
                CHECK (created_at LIKE '____-__-__%'),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
                CHECK (updated_at LIKE '____-__-__%')
);

-- Epoch-ms INTEGER timestamps here (unlike the TEXT ISO-8601 convention on
-- the other three new tables below) are deliberate, not an oversight -- this
-- mirrors phone_pairing_tokens' existing epoch-ms TTL-arithmetic pattern
-- (created_at/expires_at compared and diffed directly as numbers).
CREATE TABLE tenant_sessions (
  id                 TEXT PRIMARY KEY
                     CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  session_token_hash TEXT NOT NULL UNIQUE     -- sha256(raw token), hex; raw token
                     CHECK (length(session_token_hash) = 64),  -- lives only in the cookie
  created_at         INTEGER NOT NULL,         -- epoch ms
  expires_at         INTEGER NOT NULL CHECK (expires_at > created_at),
  revoked_at         INTEGER                   -- epoch ms; NULL = valid until expiry
);

-- FR7: the single default tenant all pre-existing inventory rows migrate onto.
-- password_hash is a deliberately unusable placeholder, not a valid scrypt
-- encoding of any real password -- see plan Risk areas re: the operator's
-- one-time credential-claim step.
INSERT INTO tenants (id, email, password_hash, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000000', 'default@local.invalid',
        'unclaimed', datetime('now'), datetime('now'));

CREATE INDEX idx_tenant_sessions_tenant   ON tenant_sessions(tenant_id);
-- No session-cleanup/GC job is built in this increment (out of scope), but
-- this index is added now anyway so a future cleanup job (DELETE WHERE
-- expires_at < ?) is cheap to add later instead of requiring a migration.
CREATE INDEX idx_tenant_sessions_expires  ON tenant_sessions(expires_at);
```

### `data/migrations/006_tenant_scoping.sql`

```sql
-- Additive per SQLite semantics: ADD COLUMN with a constant DEFAULT does not
-- rebuild the table. Backfills every pre-existing row onto the default tenant
-- (FR6, FR7) without touching any other column or existing CHECK constraint.
ALTER TABLE items            ADD COLUMN tenant_id TEXT NOT NULL REFERENCES tenants(id)
                              DEFAULT '00000000-0000-4000-8000-000000000000';
ALTER TABLE book_details      ADD COLUMN tenant_id TEXT NOT NULL REFERENCES tenants(id)
                              DEFAULT '00000000-0000-4000-8000-000000000000';
ALTER TABLE clothing_details  ADD COLUMN tenant_id TEXT NOT NULL REFERENCES tenants(id)
                              DEFAULT '00000000-0000-4000-8000-000000000000';
ALTER TABLE item_platforms    ADD COLUMN tenant_id TEXT NOT NULL REFERENCES tenants(id)
                              DEFAULT '00000000-0000-4000-8000-000000000000';
ALTER TABLE item_photos       ADD COLUMN tenant_id TEXT NOT NULL REFERENCES tenants(id)
                              DEFAULT '00000000-0000-4000-8000-000000000000';
ALTER TABLE price_history     ADD COLUMN tenant_id TEXT NOT NULL REFERENCES tenants(id)
                              DEFAULT '00000000-0000-4000-8000-000000000000';

CREATE INDEX idx_items_tenant        ON items(tenant_id);
CREATE INDEX idx_items_tenant_status ON items(tenant_id, status);
-- Satellite tenant_id columns exist to satisfy FR6's literal per-table
-- requirement and give defense-in-depth filtering; no extra index is added
-- on them since every existing query path reaches them via item_id, already
-- indexed. Application code sets each satellite row's tenant_id equal to its
-- parent item's tenant_id at insert time (see Integration points).

-- The six ALTER TABLE statements above run inside the same single
-- db.transaction() every versioned migration file in lib/db.ts's runner
-- already gets automatically -- this is not a new mechanism, just a
-- confirmation that the existing atomic-migration guarantee (all-or-nothing
-- per file) already covers a mid-file crash partway through this migration.

-- A CHECK constraint can't reference another table in SQLite, so a trigger
-- backs up the "satellite tenant_id must match parent item's tenant_id"
-- invariant at the DB level -- mirrors the items_category_immutable trigger
-- precedent in 003_multi_category.sql. Without this, a drift bug (e.g. a
-- satellite insert that forgets to copy the parent's tenant_id) silently
-- makes that row invisible to its owning tenant (fails the WHERE tenant_id
-- = ? filter) instead of erroring loudly -- this makes FR9's "isolation
-- must not depend solely on application code" hold at the DB level too, not
-- just via explicit tenantId parameters threaded through lib/*.
CREATE TRIGGER book_details_tenant_matches_item_ins
BEFORE INSERT ON book_details
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'book_details.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER book_details_tenant_matches_item_upd
BEFORE UPDATE ON book_details
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'book_details.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER clothing_details_tenant_matches_item_ins
BEFORE INSERT ON clothing_details
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'clothing_details.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER clothing_details_tenant_matches_item_upd
BEFORE UPDATE ON clothing_details
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'clothing_details.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER item_platforms_tenant_matches_item_ins
BEFORE INSERT ON item_platforms
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'item_platforms.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER item_platforms_tenant_matches_item_upd
BEFORE UPDATE ON item_platforms
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'item_platforms.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER item_photos_tenant_matches_item_ins
BEFORE INSERT ON item_photos
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'item_photos.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER item_photos_tenant_matches_item_upd
BEFORE UPDATE ON item_photos
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'item_photos.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER price_history_tenant_matches_item_ins
BEFORE INSERT ON price_history
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'price_history.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER price_history_tenant_matches_item_upd
BEFORE UPDATE ON price_history
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'price_history.tenant_id must match items.tenant_id');
END;
```

### `data/migrations/007_platform_connections.sql`

```sql
-- Column is named `status`, not `connection_status` -- matches the bare-
-- `status` naming convention already established on items.status and
-- phone_pairing_tokens.status elsewhere in this codebase. ("connection
-- status" remains fine as prose/concept language in the plan and API docs.)
CREATE TABLE platform_connections (
  id                   TEXT PRIMARY KEY
                       CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  platform             TEXT NOT NULL,           -- validated against lib/constants.ts
                                                  -- SUPPORTED_PLATFORMS at the app layer,
                                                  -- NOT a DB CHECK enum -- a new connector
                                                  -- platform then ships without the
                                                  -- create-copy-drop-rename protocol
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','suspended','revoked')),
  encrypted_credential BLOB NOT NULL             -- AES-256-GCM: iv(12B)||authTag(16B)||ciphertext
                       CHECK (length(encrypted_credential) >= 29),
                                                  -- iv 12B + authTag 16B + >=1B ciphertext = >=29B;
                                                  -- matches this codebase's length-CHECK convention
                                                  -- on other encoded fields (id=36, token_hash=64
                                                  -- in 004_phone_pairing_tokens.sql)
  last_verified_at     TEXT                      -- ISO-8601 datetime; NULL until first verified
                       CHECK (last_verified_at IS NULL OR last_verified_at LIKE '____-__-__%'),
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
                       CHECK (created_at LIKE '____-__-__%'),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
                       CHECK (updated_at LIKE '____-__-__%'),
  UNIQUE (tenant_id, platform)
);

CREATE INDEX idx_platform_connections_tenant ON platform_connections(tenant_id);

-- Kill-switch audit trail (FR26) -- one row per status transition, append-only,
-- same spirit as price_history logging every previous/new price.
-- ON DELETE CASCADE (here and on tenant_consents.connection_id in
-- 008_consent_capture.sql below): the revoked-connection reconnect path
-- (see API contract, POST /api/connections) deletes the old
-- platform_connections row outright, and foreign_keys=ON (lib/db.ts) would
-- otherwise block that delete while child rows still reference it.
CREATE TABLE connection_status_events (
  id            TEXT PRIMARY KEY
                CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  connection_id TEXT NOT NULL REFERENCES platform_connections(id) ON DELETE CASCADE,
  from_status   TEXT NOT NULL CHECK (from_status IN ('active','suspended','revoked')),
  to_status     TEXT NOT NULL CHECK (to_status   IN ('active','suspended','revoked')),
  reason        TEXT NOT NULL CHECK (length(reason) <= 500),
                                                  -- e.g. "ebay_api_403_account_suspended" --
                                                  -- capped since this may carry text derived
                                                  -- from a remote platform's error response,
                                                  -- which has no bound today
  detected_at   TEXT NOT NULL DEFAULT (datetime('now'))
                CHECK (detected_at LIKE '____-__-__%'),
  CHECK (from_status != to_status)               -- rejects meaningless no-op audit rows
);

CREATE INDEX idx_connection_status_events_connection
  ON connection_status_events(connection_id, detected_at DESC);
```

### `data/migrations/008_consent_capture.sql`

```sql
CREATE TABLE disclosure_versions (
  id         TEXT PRIMARY KEY
             CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  version    INTEGER NOT NULL UNIQUE,     -- monotonic; "current" = row with MAX(version)
  content    TEXT NOT NULL,               -- ToS/ban-risk disclosure text
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
             CHECK (created_at LIKE '____-__-__%')
);

INSERT INTO disclosure_versions (id, version, content, created_at)
VALUES ('00000000-0000-4000-8000-000000000001', 1,
        'Automating a marketplace account through this app may violate that ' ||
        'marketplace''s Terms of Service and can result in suspension or ' ||
        'permanent ban of the connected account. You are solely responsible ' ||
        'for that risk.',
        datetime('now'));

-- ON DELETE CASCADE: see the matching note on connection_status_events in
-- 007_platform_connections.sql -- the revoked-connection reconnect path
-- deletes the old platform_connections row, and its now-stale consent
-- records must go with it for that delete to succeed under foreign_keys=ON.
CREATE TABLE tenant_consents (
  id                 TEXT PRIMARY KEY
                     CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  connection_id      TEXT NOT NULL REFERENCES platform_connections(id) ON DELETE CASCADE,
  disclosure_version INTEGER NOT NULL REFERENCES disclosure_versions(version),
  consented_at       TEXT NOT NULL DEFAULT (datetime('now'))
                     CHECK (consented_at LIKE '____-__-__%'),
  revoked_at         TEXT
                     CHECK (revoked_at IS NULL OR revoked_at LIKE '____-__-__%')
);

CREATE INDEX idx_tenant_consents_connection ON tenant_consents(connection_id, consented_at DESC);
CREATE INDEX idx_tenant_consents_tenant     ON tenant_consents(tenant_id);
-- Mirrors the idx_ppt_item_active partial-unique-index precedent in
-- 004_phone_pairing_tokens.sql: makes "the current consent row" for a
-- connection unambiguous. Without this, nothing stops two simultaneously-
-- active (non-revoked) consent rows existing for the same connection.
CREATE UNIQUE INDEX idx_tenant_consents_active ON tenant_consents(connection_id)
  WHERE revoked_at IS NULL;
```

`lib/db.ts`'s `VERSIONED_MIGRATIONS` array gains four entries (versions 5–8) pointing at these files, following the exact pattern already used for `004_phone_pairing_tokens.sql`.

**Enum-extension acknowledgment** (per the NFR): `platform_connections.status` and `connection_status_events.from_status`/`to_status` are inline `CHECK` constraints. Adding a fourth status later (e.g. a `pending_reauth` state) requires the same create-new-table/copy/drop/rename protocol `003_multi_category.sql` already exercises — no `ALTER ... CHECK` in SQLite.

## API / interface contract

All routes below sit under `/api`, so `middleware.ts`'s existing Origin check applies to every mutating one unchanged. Every route first calls `requireTenant(request)`; on failure it returns `401 { error: 'Unauthorized.' }` before touching any tenant-scoped table (FR2/FR3/AC1). `tenant_id` is **never** accepted from a request body or path param — it always comes from the resolved session, which by construction satisfies FR11 (no code path exists that could write under a mismatched tenant). **Two explicit exceptions**: `app/api/phone-session/[token]/route.ts` and the `X-Pairing-Token` header branch of `app/api/items/[id]/photos/route.ts` do NOT call `requireTenant()` — the paired phone authenticates via a 15-minute bearer pairing token, never a session cookie, and tenant scope for those two paths comes from resolving the pairing token → item → `tenant_id` via `lib/pairingToken.ts` instead. `app/api/items/[id]/phone-session/route.ts` (which issues a new pairing token, called by the tenant's own browser) is not an exception and calls `requireTenant()` like every other route.

**Auth**
- `POST /api/auth/signup` — `{ email, password }` → creates a `tenants` row (scrypt-hashes the password), sets the `reseller_session` cookie, `201 { tenant_id }`. `409` if email already taken.
- `POST /api/auth/login` — `{ email, password }` → verifies via `timingSafeEqual` over the scrypt output, sets cookie, `200 { tenant_id }`. `401` on bad credentials (generic message, no user-enumeration detail).
- `POST /api/auth/logout` — revokes the session row, clears the cookie, `204`.

**Connections** (metadata only — encrypted credential material never appears in any response)
- `GET /api/connections` — `200 [{ id, platform, status, last_verified_at, created_at, updated_at }]`, scoped to the resolved tenant.
- `POST /api/connections` — `{ platform, credential: {...} }` → `credential` must validate as a non-null object (not a string, array, or `null`) before encryption, else `422 { error: 'invalid_credential' }`. On success, encrypts `credential`, inserts row with `status = 'active'`, `201` with the same metadata shape (no secret). `422` if `platform` isn't in `SUPPORTED_PLATFORMS`. `409` if `(tenant_id, platform)` already exists **and its `status` is `active` or `suspended`** (use `PATCH .../credential` to rotate, or `.../reactivate` for `suspended`). **If the existing `(tenant_id, platform)` row's `status` is `revoked`, the request instead succeeds**: within a single `db.transaction()`, the old row (and its now-cascaded `tenant_consents`/`connection_status_events` rows — see Data model's `ON DELETE CASCADE` notes) is deleted and a fresh `platform_connections` row is inserted with `status = 'active'`, requiring fresh consent before automation (no `tenant_consents` row survives the delete). This is a full reconnection, not a status flip — `revoked` by design means the tenant must reconnect with new/re-verified credentials, not resume.
- `GET /api/connections/:id` — `200` metadata, or `404` if missing or owned by a different tenant (FR4/AC2).
- `PATCH /api/connections/:id/credential` — `{ credential: {...} }` → re-encrypts, `200` metadata. `404` per above. Same `credential` object-shape validation as `POST`.
- `POST /api/connections/:id/reactivate` — explicit re-activation (FR28), for `suspended` connections only. `200` metadata if it was `suspended`; `409 { error: 'not_suspended' }` if it was already `active` **or is `revoked`** (a `revoked` connection has no `/reactivate` path — see `POST /api/connections` above for the only way back, a full reconnect).

**Consent**
- `GET /api/disclosures/current` — `200 { version, content }`. Not tenant-scoped (the disclosure text itself isn't tenant data).
- `GET /api/connections/:id/consent` — `200 { has_valid_consent, current_version, consented_version, consented_at }`. `404` per ownership rule.
- `POST /api/connections/:id/consent` — `{ disclosure_version }` → `disclosure_version` must validate as an integer that exists in `disclosure_versions` first, else `422 { error: 'invalid_disclosure_version' }`; then `422 { error: 'stale_disclosure_version' }` if it doesn't match the current (`MAX(version)`) row; otherwise inserts a `tenant_consents` row, `201`.
- `DELETE /api/connections/:id/consent` — sets `revoked_at` on the current consent row, `204`. Idempotent (no-op with `204` if nothing to revoke).

**Kill-switch / automation gate** (library contract, not an HTTP route — the signal source is out of scope per the spec)
- `lib/connections.ts :: recordSuspensionSignal(tenantId, connectionId, reason, toStatus: 'suspended' | 'revoked'): void` — single `db.transaction()` that re-verifies ownership, transitions `status`, and inserts a `connection_status_events` row, all synchronously (NFR: no queuing). This is the function future connector code calls when a platform returns a suspension signal; this increment's tests call it directly to simulate a signal (AC10/AC11).
- `lib/automationGate.ts :: assertCanAutomate(tenantId, connectionId): { ok: true } | { ok: false; reason: 'not_found' | 'not_active' | 'consent_required' }` — the single choke point future connector code must call immediately before every marketplace-mutating action (FR24/FR25), not just at connection setup.

**Error shape convention**: consent-blocked paths return `403 { error: 'consent_required', message: '...' }` (FR19 — identifies the condition, not a bare 403); status-blocked paths return `409 { error: 'connection_not_active', status }` (FR24).

## Integration points

- `data/migrations/005_tenants.sql`, `006_tenant_scoping.sql`, `007_platform_connections.sql`, `008_consent_capture.sql` — new, per Data model above.
- `lib/db.ts` — append four entries (versions 5–8) to `VERSIONED_MIGRATIONS`.
- `lib/constants.ts` — add `DEFAULT_TENANT_ID`, `SESSION_COOKIE_NAME`, `SUPPORTED_PLATFORMS` (app-layer platform allowlist, since `platform` is not a DB CHECK enum).
- `lib/tenantAuth.ts` (new) — scrypt password hashing/verification, session token issuance/resolution using the same hash-at-rest + `timingSafeEqual` pattern as `lib/pairingToken.ts`, cookie set/clear helpers.
- `lib/credentialCrypto.ts` (new) — AES-256-GCM encrypt/decrypt for `platform_connections.encrypted_credential`, loading the master key from `BOOKSELLER_CREDENTIAL_KEY` env var or a local `data/credential.key` fallback (0600, gitignored) for zero-config local dev. The fallback file's path is **not** hardcoded to `process.cwd()`-relative `data/credential.key` — it resolves via a new `BOOKSELLER_CREDENTIAL_KEY_PATH` env var (falling back to that same relative path when unset), mirroring the existing `BOOKSELLER_DB_PATH`/`BOOKSELLER_PHOTOS_PATH` override pattern. Without this, tests would resolve the key file against the real repo root instead of a scratch directory — the same class of problem `BOOKSELLER_DB_PATH`/`BOOKSELLER_PHOTOS_PATH` were introduced to prevent (see `vitest.config.ts`'s documented past incident).
- `lib/connections.ts` (new) — `platform_connections` CRUD, `recordSuspensionSignal`, `reactivateConnection`; every function takes `tenantId` as an explicit first parameter and includes it in every `WHERE` clause (FR9).
- `lib/consent.ts` (new) — `getCurrentDisclosureVersion`, `recordConsent`, `revokeConsent`, `hasValidConsent`.
- `lib/automationGate.ts` (new) — `assertCanAutomate`, centralizing the connection-status + consent checks in one module, mirroring the `lib/transitions.ts` centralization precedent.
- `lib/apiRequest.ts` — add `requireTenant(request)` alongside the existing `parseItemId`, same `{ tenantId } | NextResponse` convention.
- `lib/pairingToken.ts` — `loadClothingItemOrThrow` gains a `tenantId` parameter so phone-pairing can't be issued against another tenant's item.
- `lib/dashboard.ts` — `getDashboardData()` currently takes **zero parameters** and runs 5 separate hand-written SQL queries (held-count/cost, condition counts, status counts, category breakdown, and one more — all reading unscoped from `items`/`book_details`/`clothing_details`). This is a signature change, not a one-line filter add: `getDashboardData()` becomes `getDashboardData(tenantId: string)`, and `tenant_id = ?` (bound to `tenantId`) is threaded into the `WHERE` clause of all 5 queries individually. `app/api/dashboard/route.ts` has no SQL of its own — it only calls `getDashboardData()` — so its change is just resolving `tenantId` via `requireTenant()` and passing it through.
- `app/api/auth/signup/route.ts`, `app/api/auth/login/route.ts`, `app/api/auth/logout/route.ts` (new).
- `app/api/connections/route.ts`, `app/api/connections/[id]/route.ts`, `app/api/connections/[id]/credential/route.ts`, `app/api/connections/[id]/reactivate/route.ts`, `app/api/connections/[id]/consent/route.ts`, `app/api/disclosures/current/route.ts` (new).
- `app/api/items/route.ts`, `app/api/items/[id]/route.ts`, `app/api/items/[id]/status/route.ts`, `app/api/items/[id]/photos/route.ts`, `app/api/items/[id]/photos/[photoId]/route.ts`, `app/api/items/[id]/phone-session/route.ts`, `app/api/dashboard/route.ts`, `app/api/export/route.ts`, `app/api/import/route.ts`, `app/api/isbn/[isbn]/route.ts`, `app/api/items/suggestions/route.ts` — each gains a `requireTenant()` call up front and `tenant_id` in every DB query's `WHERE` clause (11 existing routes retrofitted). `app/api/items/[id]/photos/route.ts` is a **partial** case: its normal browser/cookie POST path gets `requireTenant()` like the rest, but the `X-Pairing-Token` header branch inside the same handler — used by the paired phone — does not; that branch resolves tenant scope via `resolveToken()` (`lib/pairingToken.ts`) instead (see API contract).
- `app/api/phone-session/[token]/route.ts` — **explicitly excluded** from the `requireTenant()` retrofit, not missed. This route is hit by the paired phone itself via its 15-minute bearer pairing token (`lib/pairingToken.ts`'s `resolveToken`), and never holds a `reseller_session` cookie; a blanket `requireTenant()` here would 401 every phone-pairing request and break the already-shipped phone-handoff feature. Its tenant scoping comes from resolving pairing token → item → `tenant_id` instead.
- `app/login/page.tsx`, `app/signup/page.tsx` (new) — plain, unstyled HTML forms (no visual design work) that POST to `/api/auth/login` and `/api/auth/signup` respectively, so the app remains usable through the browser after this increment ships. Either two pages or one combined page is acceptable; functional only.
- `middleware.ts` — no code change. Next.js middleware always runs before route handlers, so the CSRF Origin check and tenant-cookie resolution are naturally independent layers already (AC15 holds without modification).
- `tests/setup.ts` / a new `tests/helpers/tenant.ts` — a `createTestTenant()` fixture (insert a tenant row + a valid session cookie) that every existing `tests/api/*.test.ts` file needs to call, since those tests currently make unauthenticated requests that will start returning 401 once `requireTenant()` lands.
- `tests/api/auth.test.ts`, `tests/api/connections.test.ts`, `tests/api/consent.test.ts`, `tests/api/tenant-isolation.test.ts`, `tests/api/kill-switch.test.ts` (new, or consolidated) — acceptance tests covering AC1–AC15 (auth flows, cross-tenant isolation, consent blocking, suspension atomicity, etc.).
- `vitest.config.ts`, `playwright.config.ts` — **do** need a change: `BOOKSELLER_DB_PATH` scratch-DB resolution already causes the new migrations to run automatically against the scratch DB on first `lib/db.ts` import, but `lib/credentialCrypto.ts`'s new `BOOKSELLER_CREDENTIAL_KEY_PATH` override (see above) is a separate env var pointing at a separate file, and needs its own scratch path set in each config's `test.env` block — exactly like the existing `BOOKSELLER_DB_PATH`/`BOOKSELLER_PHOTOS_PATH` entries — or credential-encryption tests would resolve the real repo-root `data/credential.key` instead of a scratch key file.
- `package.json` — **no new dependency.** See Technology choices.

## Technology choices

- **Node built-in `crypto.scryptSync`** for password hashing — avoids adding `bcrypt`/`argon2` npm packages; the repo already has zero external services as a stated value, and Node's `crypto` module is the only crypto primitive this app has ever used (`lib/pairingToken.ts`).
- **Node built-in `crypto.randomBytes` + sha256 + `timingSafeEqual`** for session tokens — this is not a new pattern, it is the exact mechanism `lib/pairingToken.ts` already uses for phone-pairing tokens; reusing it for `tenant_sessions` keeps the codebase's one hashed-token idiom instead of introducing a second one (e.g. a JWT library).
- **Node built-in `crypto.createCipheriv('aes-256-gcm', ...)`** for credential-at-rest encryption — AEAD gives both confidentiality and tamper-detection for the one piece of genuinely sensitive data this increment introduces, with no new dependency.
- **Next.js's built-in `NextResponse.cookies`/`request.cookies`** for the session cookie — already part of the `next` dependency already in `package.json`; no separate cookie-parsing library.
- **No new npm dependency of any kind is added by this increment.**

## Risk areas

- **Master credential-encryption key custody.** `BOOKSELLER_CREDENTIAL_KEY` (or the `data/credential.key` fallback file) becomes a second "sacred" artifact alongside `data/inventory.db` — losing it makes every stored credential permanently undecryptable, and unlike the DB it isn't covered by `lib/backup.ts`'s existing WAL-safe snapshot routine. This needs its own backup discipline, which this plan does not build.
- **Retrofit surface across 11 existing routes (plus one partial case).** Every pre-existing tenant-scoped API route must gain a `requireTenant()` call and `tenant_id` filtering (`app/api/phone-session/[token]/route.ts` is deliberately excluded — see Integration points); a single missed `WHERE` clause is a silent cross-tenant leak (violates FR4/AC2) that a route-level unit test written for a different concern won't catch. Recommend a dedicated cross-tenant-isolation integration test that iterates every tenant-scoped route once the retrofit lands, not just per-route happy-path tests.
- **The migrated default tenant starts unusable for login by design** (`password_hash = 'unclaimed'`, per FR7's "assign to a default tenant" without a way to know the operator's desired password). **Pre-ship checklist item**: immediately post-deploy, the operator must run something like `UPDATE tenants SET password_hash = <real scrypt hash> WHERE id = '00000000-0000-4000-8000-000000000000'` (a direct SQL `UPDATE` with a scrypt hash produced by a small throwaway script, or equivalent) — otherwise the human operator is locked out of the browser UI for all pre-existing inventory. (The API itself would still work for the default tenant, since nothing requires login for internal test fixtures — but the actual person running the app needs this step to use the real app.) Building a self-serve "claim this account" flow is out of scope (the spec excludes password-reset flows), so this is a deliberate manual gap, not an oversight — but it's easy to forget at ship time.
- **Cross-tenant ISBN uniqueness leak, deliberately deferred.** `book_details.isbn` carries a pre-existing DB-level global `UNIQUE` constraint (`idx_books_isbn` in `001_init.sql`), not scoped per tenant. Once a second tenant exists, tenant B adding a book with an ISBN tenant A already owns gets a 409 "ISBN already exists" — leaking a weak cross-tenant signal (that *some* tenant already holds that ISBN). Fixing this properly requires a table-rebuild migration (SQLite cannot `ALTER` a `UNIQUE` constraint), which is disproportionate to and disallowed by this increment's additive-only-migrations constraint. This is a known, deliberately deferred gap — matching the corresponding "Out of scope" note in `requirements.md` — not something this plan attempts to fix.
- **`platform` is validated at the app layer, not the DB layer.** Storing it as free `TEXT` (rather than a `CHECK` enum) avoids the create-copy-drop-rename cost every time a new connector ships, but it means `lib/constants.ts::SUPPORTED_PLATFORMS` is now the only thing preventing garbage platform strings from reaching `platform_connections` — a bug or omission there is not caught by the database.
- **First real authentication in the app's history.** Cookie flags (`httpOnly`, `sameSite`, `secure`), session TTL, and logout semantics are being decided here as implementation details (the spec explicitly excludes "session management mechanics" from scope), but mistakes in this specific area have a materially higher blast radius than the rest of the app — worth a focused security pass once implemented, separate from the general code review.
