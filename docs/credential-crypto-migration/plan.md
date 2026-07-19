# Plan: Credential Crypto Migration

## Approach

Swap the two AEAD call sites inside `lib/credentialCrypto.ts` from `node:crypto`'s
AES-256-GCM (`createCipheriv`/`createDecipheriv`) to `@preston-bernstein/credential-crypto`'s
`encryptBytes`/`decryptBytes` (XChaCha20-Poly1305), leaving `loadMasterKey()` and the
exported `encryptCredential`/`decryptCredential` signatures byte-for-byte unchanged — this is
a library-internals substitution, not a redesign. The manual `< 28 bytes` pre-check in
`decryptCredential` is deleted rather than reimplemented at 40 bytes, since `decryptBytes`
already performs the identical structural-minimum check and throws a clear message —
duplicating it would be gold-plating. Alongside that, `data/migrations/013_credential_column_floor.sql`
rebuilds `platform_connections` via the same create-copy-drop-rename protocol
`003_multi_category.sql` used for `price_history` (same-name rebuild, not an archive-and-replace),
tightening the `encrypted_credential` CHECK floor from 29 to 41 bytes while the table holds
zero rows.

## Architecture

Before:

```
connector auth flows
      |
      v
encryptCredential()/decryptCredential()  (lib/credentialCrypto.ts)
      |                     |
      v                     v
loadMasterKey()      node:crypto AES-256-GCM
(env / key-file /          |
 module cache,             v
 unchanged)          Buffer: iv(12B) || authTag(16B) || ciphertext
                            |
                            v
                platform_connections.encrypted_credential (BLOB, CHECK >= 29)
```

After:

```
connector auth flows                    (zero changes — same import, same signatures)
      |
      v
encryptCredential()/decryptCredential()  (lib/credentialCrypto.ts)
      |                     |
      v                     v
loadMasterKey()      @preston-bernstein/credential-crypto
(unchanged)            encryptBytes()/decryptBytes()
      |                     |  (XChaCha20-Poly1305, @noble/ciphers)
      |                     v
      |             Buffer: nonce(24B) || ciphertext+tag
      |                     |
      +---------------------+
                            v
                platform_connections.encrypted_credential (BLOB, CHECK >= 41, migration 013)
```

`loadMasterKey()` still hands a raw 32-byte `Buffer` key to the AEAD calls — `encryptBytes`/
`decryptBytes` accept `Uint8Array`, and `Buffer` is a `Uint8Array` subclass, so no conversion
is needed at the call sites. No new module sits between the caller and `credentialCrypto.ts`;
the swap is confined to the two function bodies.

## Data model

Migration `data/migrations/013_credential_column_floor.sql`, registered as
`{ version: 13, file: '013_credential_column_floor.sql' }`, gated by `PRAGMA user_version < 13`,
run inside a single `db.transaction()` exactly like every other entry in
`lib/db.ts`'s `VERSIONED_MIGRATIONS` loop:

```sql
-- 013_credential_column_floor.sql
-- Rebuild-in-place, same final table name (platform_connections) — the
-- price_history pattern from 003_multi_category.sql, not the books/
-- book_platforms archive-and-replace pattern. Because the final name is
-- IDENTICAL to the original, connection_status_events.connection_id,
-- tenant_consents.connection_id, poshmark_delist_events.connection_id, and
-- poshmark_share_events.connection_id — none of which are touched by this
-- migration — continue to resolve their `REFERENCES platform_connections(id)`
-- declarations correctly after the rename, with zero edits to those tables.
-- (Verified empirically: SQLite permits DROP TABLE on an FK-referenced
-- parent even with foreign_keys=ON, and a same-named table created
-- afterward is immediately a valid FK target again for new rows.)

PRAGMA defer_foreign_keys = ON;

CREATE TABLE platform_connections_v2 (
  id                   TEXT PRIMARY KEY
                       CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  platform             TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','suspended','revoked')),
  encrypted_credential BLOB NOT NULL             -- XChaCha20-Poly1305: nonce(24B)||ciphertext+tag
                       CHECK (length(encrypted_credential) >= 41),
                                                  -- nonce 24B + tag 16B + >=1B ciphertext = >=41B
  last_verified_at     TEXT
                       CHECK (last_verified_at IS NULL OR last_verified_at LIKE '____-__-__%'),
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
                       CHECK (created_at LIKE '____-__-__%'),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
                       CHECK (updated_at LIKE '____-__-__%'),
  UNIQUE (tenant_id, platform)
);

-- Copy forward any existing rows (0 today, per requirements — written
-- generally so this migration is correct even if that fact changes before
-- it ships).
INSERT INTO platform_connections_v2
  (id, tenant_id, platform, status, encrypted_credential, last_verified_at, created_at, updated_at)
  SELECT id, tenant_id, platform, status, encrypted_credential, last_verified_at, created_at, updated_at
  FROM platform_connections;

DROP TABLE platform_connections;
ALTER TABLE platform_connections_v2 RENAME TO platform_connections;

CREATE INDEX idx_platform_connections_tenant ON platform_connections(tenant_id);
```

Every column, the `status` CHECK, both date-format CHECKs, the `id` CHECK, and
`UNIQUE (tenant_id, platform)` are carried forward verbatim — only the
`encrypted_credential` CHECK floor changes (29 → 41). `data/migrations/007_platform_connections.sql`
itself is left untouched, per requirement #17. No changes to `connection_status_events`
(defined in `007_platform_connections.sql`), `tenant_consents` (`008_consent_capture.sql`), or
`poshmark_delist_events`/`poshmark_share_events` (`010_poshmark_pacing.sql`) — their
`ON DELETE CASCADE` FKs, indexes, and triggers are untouched by this migration and verified
functional post-migration via `PRAGMA index_list('platform_connections')`,
`EXPLAIN QUERY PLAN` on a tenant-filtered query, and an insert+cascade-delete smoke test
against each dependent table (acceptance criteria 14–15).

## API / interface contract

None. `encryptCredential(plaintext: string | object): Buffer` and
`decryptCredential(encrypted: Buffer): string` keep their exact signatures, return types, and
throw semantics (throws on tamper, wrong key, or too-short buffer; never returns partial
plaintext). No route, CLI flag, or UI surface changes.

## Integration points

- `lib/credentialCrypto.ts` — replace `crypto.createCipheriv('aes-256-gcm', ...)` /
  `crypto.createDecipheriv('aes-256-gcm', ...)` with `encryptBytes`/`decryptBytes` from
  `@preston-bernstein/credential-crypto`; drop the local `IV_BYTES`/`AUTH_TAG_BYTES`/`ALGORITHM`
  constants and the manual too-short pre-check in `decryptCredential` (delegated to
  `decryptBytes`); `loadMasterKey()` and its `KEY_BYTES = 32` constant are untouched; update the
  top-of-file comment referencing the old `iv(12B)||authTag(16B)||ciphertext` layout and the
  `>= 29` CHECK to describe the new `nonce(24B)||ciphertext+tag` layout and `>= 41` CHECK.
- `lib/__tests__/credentialCrypto.test.ts` — replace every old-format boundary assertion:
  `12 + 16 + 1` → `24 + <ct+tag len>`, the `28`-byte boundary tests → `40`-byte boundary,
  the `< 28`/`27`/`5`-byte too-short tests → equivalents below 40, tamper-offset tests
  (byte 0 = IV, byte 15 = tag) → offsets valid for a 24-byte nonce (e.g. byte 0) and its
  trailing tag region (bytes 24–39), and the "too short" message regex → whatever
  `decryptBytes` actually throws (`/too short/` per its message text, confirmed against
  `credential-crypto/src/primitives.ts`). All four key-loading-branch `describe` blocks
  (env wins, env wrong-length, key-file branch, module-scope cache) are left assertion-for-assertion
  unchanged, since `loadMasterKey()` doesn't change.
- `package.json` — add `"@preston-bernstein/credential-crypto": "git+ssh://nas-agent/volume1/homes/agent/git/credential-crypto.git"`
  to `dependencies`.
- `package-lock.json` — regenerated by `npm install` after the `package.json` edit; commit the
  resulting lockfile diff (no format drift — this repo has no `pnpm-lock.yaml`).
- `data/migrations/013_credential_column_floor.sql` — new file, per the Data model section above.
- `lib/db.ts` — append `{ version: 13, file: '013_credential_column_floor.sql' }` as the next
  entry in `VERSIONED_MIGRATIONS`, immediately after `{ version: 12, file: '012_clothing_vocabularies.sql' }`
  (line 61).

## Technology choices

- `@preston-bernstein/credential-crypto` (git dependency) — already-built, already-tested
  (37 passing tests) shared XChaCha20-Poly1305 implementation; this migration's entire purpose
  is to stop duplicating that primitive locally, so no alternative library is considered.

No other new libraries or patterns — this is a like-for-like internals swap plus one migration
using the repo's existing create-copy-drop-rename convention.

## Risk areas

- **`dist/` is gitignored in `credential-crypto` and there is no `prepare`/`prepack` build
  script in its `package.json`.** A plain `npm install` against the `git+ssh://` URL clones
  the TypeScript source but has no hook that compiles it to `./dist/index.js` (the package's
  declared `main`). Unless this is already resolved as part of the sibling "build
  credential-crypto package" task, `npm install` in this repo will succeed but the import will
  fail at runtime/build with a missing-file error. This should be verified against the actual
  state of the `credential-crypto` repo before merging, not assumed fixed.
- **SSH reachability to `nas-agent`.** `npm install` needs working SSH access
  (`~/.ssh/agent_ed25519`) to `nas-agent` from every environment that will run it — dev
  machines, CI (if any runs `npm install` here), and the desktop deploy path. A dev laptop
  having the key configured doesn't guarantee the deploy environment does.
- **ESM-only package (`"type": "module"`) consumed by a repo with no `"type"` field.**
  `tsconfig.json`'s `moduleResolution: "bundler"` and Next's own bundler should resolve this
  transparently for app code, but `vitest.config.ts`/Node's own module loader for anything run
  outside the Next build (e.g. a raw `ts-node` script, if one exists) could hit ESM/CJS
  interop friction not present with the old zero-dependency `node:crypto` implementation.
- **Stryker mutation thresholds (85/80/85/85).** Deleting the manual too-short pre-check and
  thinning `encryptCredential`/`decryptCredential` down to thin delegations reduces the number
  of local branches Stryker can mutate in this file; existing tests should still kill mutants
  in `decryptBytes`'s own logic only indirectly (it's an external package, not instrumented by
  this repo's Stryker config), so coverage math for `credentialCrypto.ts` specifically should
  be re-checked once the rewrite lands, not assumed to carry over from the old implementation's
  numbers.
- **Test-message coupling to `credential-crypto`'s exact error strings.** Requirement #21 allows
  the too-short test to assert whatever message `decryptBytes` throws; that message
  (`"ciphertext too short (...)"`) lives in an external package's source and could change
  under a future `credential-crypto` version bump without this repo's control — worth a loose
  regex (`/too short/`) rather than an exact string match, to avoid brittle coupling.
