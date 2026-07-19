# Requirements: Credential Crypto Migration

## Problem statement
`resale-inventory` currently implements its own AES-256-GCM encryption inline in `lib/credentialCrypto.ts` to protect per-tenant marketplace credentials (eBay, Etsy, Amazon, Poshmark, Depop, Mercari, Vinted, Grailed logins) at rest in `platform_connections.encrypted_credential`. A shared, already-built-and-tested package (`@preston-bernstein/credential-crypto`, XChaCha20-Poly1305, 37 passing tests) now exists to centralize this primitive across repos, so this repo's copy should stop maintaining its own AEAD call site and delegate to the shared implementation. This matters now because the shared package is done and any repo still rolling its own cipher call is duplicated surface area to keep correct. The DB-level minimum-length CHECK constraint on the credential column was sized for the old AES-256-GCM format and is now too permissive for the new format's larger nonce, and must be corrected while the table holds zero live rows (a one-time safe window).

## Users / stakeholders
- Tenants of `resale-inventory` whose marketplace credentials are stored via `platform_connections.encrypted_credential` (confidentiality/integrity of their login secrets).
- Developers/operators of `resale-inventory` maintaining `lib/credentialCrypto.ts` and its callers.
- The `resale-inventory.service` systemd deployment on the desktop machine (the only environment with real, if currently zero, data).
- Downstream code that calls `encryptCredential`/`decryptCredential` (connector auth flows) — must be unaffected by this change.
- Maintainer of `@preston-bernstein/credential-crypto` (out of scope to modify, but its public API is a hard dependency here).

## Functional requirements
1. The system shall call `encryptBytes` from `@preston-bernstein/credential-crypto` inside `encryptCredential()` instead of `node:crypto`'s `createCipheriv('aes-256-gcm', ...)`.
2. The system shall call `decryptBytes` from `@preston-bernstein/credential-crypto` inside `decryptCredential()` instead of `node:crypto`'s `createDecipheriv('aes-256-gcm', ...)`.
3. The system shall preserve the exported signature `encryptCredential(plaintext: string | object): Buffer` unchanged, including JSON-serialization of non-string input before encryption.
4. The system shall preserve the exported signature `decryptCredential(encrypted: Buffer): string` unchanged, including UTF-8 decoding of the recovered plaintext.
5. The system shall produce ciphertext buffers laid out as `nonce(24B) || ciphertext+tag`, matching `@preston-bernstein/credential-crypto`'s packing format, replacing the old `iv(12B) || authTag(16B) || ciphertext` layout.
6. The system shall keep `loadMasterKey()` — its env-var branch (`BOOKSELLER_CREDENTIAL_KEY`, hex, exactly 32 bytes, wins outright), its key-file branch (`BOOKSELLER_CREDENTIAL_KEY_PATH`, mode 0600, auto-generated on first use if absent), and its module-scope caching (`cachedKey`) — byte-for-byte unchanged in behavior; only the two AEAD call sites (encrypt/decrypt) change.
7. The system shall throw when `decryptCredential` is given a buffer shorter than the new cipher's structural minimum (nonce 24B + tag 16B = 40B), surfacing whatever error `decryptBytes` raises (directly, or wrapped without losing the original error detail).
8. The system shall throw (via `decryptBytes`) when the ciphertext, tag, or nonce bytes of an encrypted buffer have been tampered with at any offset, and shall never return a partially-decrypted or garbage plaintext string in that case.
9. The system shall throw when `decryptCredential` is called with a buffer encrypted under a different 32-byte key than the one `loadMasterKey()` currently resolves.
10. The system shall add `"@preston-bernstein/credential-crypto": "git+ssh://nas-agent/volume1/homes/agent/git/credential-crypto.git"` to `package.json` `dependencies`, installable via `npm install`, with `package-lock.json` updated to match.
11. The system shall update `data/migrations/013_credential_column_floor.sql` (registered in `lib/db.ts`'s `VERSIONED_MIGRATIONS` as `{ version: 13, file: '013_credential_column_floor.sql' }`) to rebuild `platform_connections` via the create-copy-drop-rename protocol (per `data/migrations/003_multi_category.sql` precedent), replacing `CHECK (length(encrypted_credential) >= 29)` with `CHECK (length(encrypted_credential) >= 41)`.
12. The migration shall preserve, on the rebuilt `platform_connections` table, every column, the `status` CHECK, the `last_verified_at`/`created_at`/`updated_at` date-format CHECKs, the `UNIQUE (tenant_id, platform)` constraint, and the `id` CHECK — unchanged except for the `encrypted_credential` floor.
13. The migration shall recreate `idx_platform_connections_tenant` on the rebuilt table.
14. The migration shall leave `connection_status_events`, `tenant_consents`, and the Poshmark pacing tables (`poshmark_delist_queue`/`poshmark_share_queue` or equivalent from `010_poshmark_pacing.sql`) functioning against the rebuilt table — their `connection_id` foreign keys (all `ON DELETE CASCADE`) must resolve to the new `platform_connections` table by the same name after rename, and their own indexes/triggers must remain intact and unmodified.
15. The migration shall run inside a single `db.transaction()`, consistent with `lib/db.ts`'s existing per-migration transaction pattern, and shall only apply when `PRAGMA user_version < 13`.
16. The system shall update `lib/__tests__/credentialCrypto.test.ts` so every existing assertion about buffer layout/length (e.g. `12 + 16 + 1`, `< 28`, tamper offsets at bytes 0/15/last) is replaced with the XChaCha20-Poly1305 equivalents (`24 + <ciphertext+tag length>`, `< 40`, tamper offsets valid for a 24B nonce and its associated tag/ciphertext region).
17. The system shall keep all four key-loading branch test groups (env var wins, env var wrong-length throws with byte count in the message, key-file branch generates/persists/mode-0600/caches, module-scope cache avoids re-reading the file) passing with no change to their assertions, since `loadMasterKey()` itself is unchanged.
18. The system shall retain round-trip tests for both string and object plaintexts, asserting the object case parses back via `JSON.parse` to a deep-equal value.
19. The system shall retain a test asserting two encryptions of the same plaintext produce different ciphertext (fresh random nonce per call).
20. The system shall retain tamper-detection tests covering at least: a byte inside the nonce, a byte inside the tag, and the last byte of the ciphertext — each expected to throw on decrypt.
21. The system shall retain a too-short-buffer rejection test at the new 40-byte structural boundary (39 bytes throws with a "too short"-equivalent message if `credentialCrypto.ts` still performs its own pre-check before calling `decryptBytes`; otherwise the test asserts whatever throw `decryptBytes` itself performs at that boundary).
22. The system shall retain a wrong-key rejection test: a buffer encrypted under one key must throw on decrypt when `loadMasterKey()` resolves to a different key.

## Non-functional requirements
- Key material handling (env var / key file mode 0600 / module-scope cache / hex decode validation) must remain identical in behavior and error messages to today's implementation — this is a constraint carried over from the existing code, not a new target.
- The migration must be zero-data-loss and reversible in spirit (create-copy-drop-rename leaves the pre-migration table recoverable under an `_archived` or intermediate name until the copy is verified, per the `003_multi_category.sql` precedent), even though there are zero live rows to lose today.
- No behavior change is permitted for any caller of `encryptCredential`/`decryptCredential` outside `lib/credentialCrypto.ts` — this is an internals-only substitution.
- The new dependency is installed via `npm install` against `package-lock.json` (this repo does not use pnpm) — no lockfile format drift.

## Constraints
- Must integrate with the existing `lib/db.ts` migration runner (`VERSIONED_MIGRATIONS` array, `PRAGMA user_version` gating, per-migration `db.transaction().immediate()`).
- Must use `@preston-bernstein/credential-crypto`'s `encryptBytes`/`decryptBytes` exactly as published — the package itself is fixed and out of scope to modify.
- Must follow the create-copy-drop-rename protocol already established for CHECK-constraint changes on this schema (`data/migrations/003_multi_category.sql`), not an in-place `ALTER TABLE` (SQLite cannot alter a CHECK constraint).
- Must not change `loadMasterKey()`'s external contract: `BOOKSELLER_CREDENTIAL_KEY` env var (hex, 32 bytes, wins outright), `BOOKSELLER_CREDENTIAL_KEY_PATH` key file (0600, auto-generated), module-scope caching.
- Must not change the public API surface (`encryptCredential`, `decryptCredential` signatures and return/throw semantics as documented above).
- Dependency is fetched via `git+ssh://nas-agent/volume1/homes/agent/git/credential-crypto.git` — requires the deploy/dev environment to have SSH access to `nas-agent` configured (per existing `~/.ssh/agent_ed25519` home-lab access) for `npm install` to succeed.
- Migration number is fixed at 013 (next available slot after `012_clothing_vocabularies.sql`).
- No live production `encrypted_credential` rows exist today (count=0, re-verified against the production desktop DB) — this is the specific fact that makes the format-breaking cipher change and the CHECK-constraint rebuild safe to ship without a data-preserving re-encryption step.

## Out of scope
- Any change to the `@preston-bernstein/credential-crypto` package's own source, tests, or repo.
- Key rotation or multi-key-version support (explicitly out of scope in the original implementation and unchanged here).
- Re-encrypting or migrating any existing ciphertext from the old AES-256-GCM format to the new XChaCha20-Poly1305 format — there is none to migrate.
- Any change to the `fashion-monitor` repo or its migrations.
- Any UI/UX surface, API route, or connector-auth flow change.
- Dropping (vs. renaming) any superseded intermediate table created during the migration's create-copy-drop-rename steps, beyond what the precedent pattern itself performs.
- Changing the `platform`, `status`, `last_verified_at`, `created_at`, or `updated_at` column definitions on `platform_connections` beyond carrying them forward verbatim.

## Acceptance criteria
1. `encryptCredential('some-string')` followed by `decryptCredential(...)` on the result returns the exact original string.
2. `encryptCredential({ apiKey: 'x', secret: 'y' })` followed by `decryptCredential(...)` and `JSON.parse(...)` returns a deep-equal object.
3. Two calls to `encryptCredential` with the same plaintext produce byte-different output (fresh nonce each call).
4. Every buffer returned by `encryptCredential` is laid out as 24-byte nonce followed by ciphertext+tag, per `@preston-bernstein/credential-crypto`'s packing format.
5. `decryptCredential` throws when given a buffer below the new format's 40-byte structural minimum.
6. `decryptCredential` throws when any byte in the nonce, tag, or ciphertext region of a valid encrypted buffer is flipped, and never returns a decrypted string in that case.
7. `decryptCredential` throws when the buffer was encrypted under a key other than the one `loadMasterKey()` currently resolves to.
8. All pre-existing key-loading branch tests (env-var-wins, env-var-wrong-length-throws, key-file-generates-on-first-use, key-file-wrong-length-throws, mode-0600-on-generated-file, module-scope-cache-avoids-re-read) pass unmodified in assertion intent.
9. `npm install` succeeds and resolves `@preston-bernstein/credential-crypto` from the `git+ssh://nas-agent/...` URL, with `package.json` and `package-lock.json` both reflecting the new dependency.
10. `npm run typecheck` (`tsc --noEmit`) passes with no errors in `lib/credentialCrypto.ts` or its test file after the migration.
11. `npm run test` passes for `lib/__tests__/credentialCrypto.test.ts` with zero old-format assumptions remaining (no reference to 12/16/28/29-byte boundaries).
12. Running the app against a fresh (`user_version < 13`) database applies migration 013 and leaves `PRAGMA user_version` at 13.
13. After migration 013, inserting a `platform_connections` row with `encrypted_credential` shorter than 41 bytes fails the CHECK constraint; a row with exactly 41 bytes or more succeeds (given valid values for all other NOT NULL columns).
14. After migration 013, `idx_platform_connections_tenant` exists and functions identically (verifiable via `PRAGMA index_list('platform_connections')` and `EXPLAIN QUERY PLAN` on a tenant-filtered query).
15. After migration 013, `connection_status_events`, `tenant_consents`, and the Poshmark pacing tables can still insert rows referencing `platform_connections.id` and still cascade-delete correctly when a `platform_connections` row is deleted.
16. No caller of `encryptCredential`/`decryptCredential` outside `lib/credentialCrypto.ts` requires a code change (verified by `npm run lint` and `npm run typecheck` passing repo-wide with no edits to those call sites).
17. `data/migrations/007_platform_connections.sql` itself is left unmodified — the corrective floor is applied only via new migration 013, not a retroactive edit to 007.
