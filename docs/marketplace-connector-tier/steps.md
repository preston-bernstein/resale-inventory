# Steps: Marketplace Connector Tier

## Prerequisites
None. The multi-tenant foundation is already in place (`lib/connections.ts`, `lib/consent.ts`, `lib/credentialCrypto.ts`), and migration `008` (`lib/db.ts`'s `VERSIONED_MIGRATIONS`) is the latest. Build in any Node.js 18+ environment with npm and SQLite. Note: eBay's Sandbox integration test (Step 11c) needs a free, self-serve eBay Developer Sandbox app registered by the operator to exercise beyond its skip-gated fallback — not a blocker for any other step.

## Implementation steps

### Step 1: Define shared connector types and error classes
**What**: Create the `Connector` interface and all error types (gating, configuration, platform-specific) that every connector implementation will conform to.
**Files**: lib/connectors/types.ts
**Test**: `npm run build && npm test -- lib/connectors/__tests__/types.test.ts` — write a test file that imports and instantiates each error class, asserting they are Error instances and have the correct properties.
**Depends on**: none
**Parallelizable**: No

### Step 2: Add SupportedPlatform type export and pacing constants
**What**: Export `SupportedPlatform` type (the union of `SUPPORTED_PLATFORMS` array values) and define named pacing constants for each platform's rate/cooldown limits.
**Files**: lib/constants.ts
**Test**: `npm run build` — verify TypeScript compilation succeeds and `SupportedPlatform` is exported alongside `SUPPORTED_PLATFORMS`. Assert the pacing constant values: `POSHMARK_RELIST_COOLDOWN_DAYS === 60`, `POSHMARK_SHARE_CAP_PER_24H === 3500`, and each of the 4 platform action-rate-limit constants equal `10_000` (ms).
**Depends on**: Step 1
**Parallelizable**: No

### Step 3: Create item_platforms and poshmark_pacing migrations; update VERSIONED_MIGRATIONS
**What**: Write migration `009_item_platforms_external_id.sql` (add nullable `external_listing_id` column, plus the partial unique index and length-bound CHECK) and migration `010_poshmark_pacing.sql` (create durable cooldown/share-event tables, with `tenant_id`, explicit `ON DELETE CASCADE`, and tightened `strftime`-based datetime CHECKs); append both to `lib/db.ts`'s `VERSIONED_MIGRATIONS` array.
**Files**: data/migrations/009_item_platforms_external_id.sql, data/migrations/010_poshmark_pacing.sql, lib/db.ts
**Test**: Verify both migrations appear in `lib/db.ts` with `version: 9` and `version: 10`; run a quick schema check like `sqlite3 :memory: ".read data/migrations/010_poshmark_pacing.sql" ".schema"` to confirm SQL is valid.
**Depends on**: Step 1
**Parallelizable**: No

### Step 4: Implement centralized item_platforms upsert
**What**: Write `recordListingCreated(tenantId, itemId, platform, externalListingId)` that upserts into `item_platforms` respecting the `UNIQUE(item_id, platform)` constraint.
**Files**: lib/connectors/itemPlatformsWrite.ts
**Test**: Write a focused unit test asserting the upsert writes exactly one row on first call, updates it on a second call for the same item+platform (no duplicate), and includes `tenant_id` scoping.
**Depends on**: Step 2, Step 3
**Parallelizable**: No

### Step 5: Implement environment variable validation for app-level credentials
**What**: Write `requireEnv(platform, varName)` that throws `ConnectorNotConfiguredError` at call time (not import time), so one platform's missing credential does not break another's module load.
**Files**: lib/connectors/envConfig.ts
**Test**: Write a test that calls `requireEnv('ebay', 'EBAY_SANDBOX_CLIENT_ID')` with the var unset and asserts `ConnectorNotConfiguredError` is thrown with a clear message; repeat with the var set and assert success. Repeat the same pattern for an Etsy env var, not only eBay/Amazon.
**Depends on**: Step 1, Step 2
**Parallelizable**: No

### Step 6: Implement shared OAuth token refresh logic for API-tier connectors
**What**: Write `getFreshAccessToken(tenantId, connectionId, exchangeFn)` that decrypts the tenant's stored credential, checks token expiry, calls `exchangeFn` to refresh if needed, persists the new token via `rotateCredential`, and applies a short-TTL (~60s) in-memory cache keyed by `connectionId` (invalidated on rotation).
**Files**: lib/connectors/apiCredential.ts
**Test**: Write a focused test that mocks `getDecryptedCredential` and `rotateCredential`, calls `getFreshAccessToken` with an expired token, asserts `exchangeFn` is called, and verifies the rotated token is persisted. Add a second test asserting a call within the cache TTL does not re-decrypt.
**Depends on**: Step 1, Step 2, Step 5
**Parallelizable**: No

### Step 7: Implement gating wrapper and centralized createListing success hook
**What**: Write `buildConnector(platform, rawMethods)` that wraps `createListing`/`updateListing`/`markSold`/`delist` to check consent/status on every call (never cache), passes `checkConnectionHealth` ungated, and calls `recordListingCreated` on successful `createListing`. Also implement `lib/automationGate.ts`'s `assertCanAutomate(tenantId, connectionId)` (combines `hasValidConsent` + `platform_connections.status === 'active'` into one call) if not already implemented by this step.
**Files**: lib/connectors/gate.ts, lib/automationGate.ts
**Test**: Write a focused test that mocks `assertCanAutomate` to return `{ ok: false, reason: 'consent_required' }`, calls a gated method, and asserts `ConnectorGatingError` is thrown before any raw method is invoked.
**Depends on**: Step 1, Step 2, Step 4
**Parallelizable**: No

### Step 8: Implement shared credential-scrubbing utility
**What**: Write `lib/connectors/scrub.ts` with a shared function that strips credential-bearing fields from any object, used by every connector's error construction and every `recordSuspensionSignal` call to ensure logs never contain secrets.
**Files**: lib/connectors/scrub.ts
**Test**: Write a focused unit test that passes a seeded fake secret string in an object through the scrub function and asserts the secret does not appear in the output (replaced with a redacted placeholder).
**Depends on**: Step 1
**Parallelizable**: Yes

### Step 9: Implement pacing/rate-limiting wrapper for Depop/Mercari/Vinted/Grailed
**What**: Write thin wrapper over `lib/rateLimit.ts`'s `checkRateLimit` that enforces per-platform action-rate caps using named constants from `lib/constants.ts` as the window duration, keyed `${platform}:${connectionId}`. Document explicitly that this assumes single-process deployment (state is lost on restart, matching the existing single-instance better-sqlite3 model).
**Files**: lib/connectors/pacing.ts
**Test**: Write a focused test asserting that after `checkRateLimit` returns false (rate-limited), the next call within the window also returns false, and a call after the window resets returns true.
**Depends on**: Step 1, Step 2
**Parallelizable**: No

### Step 10: Implement Playwright session persistence, login, dry-run handling, and read-only health-check validation; add Playwright dependency
**What**: Write `isDryRunCredential()`, `withSession(tenantId, connectionId, action)` (load persisted cookies/localStorage via a fresh, isolated per-tenant+connection browser context, validate via a lightweight authenticated page load, fresh-login-once-on-failure via one navigate+submit cycle, persist result via `rotateCredential`), `validateSessionReadOnly()` (same session check but NEVER attempts a fresh login — used only by `checkConnectionHealth` so health polling can't become an unthrottled login source), and `dryRunLog()` (logs action type + platform + item id only, never full listing payload) for browser connectors to reuse across all 5 platforms. All Playwright interactions use value-based APIs (`fill`/`check`/role or test-id locators), never text-interpolated selectors built from tenant listing data. Add `"playwright"` to `package.json` `dependencies` (not devDependencies; distinct from the existing `@playwright/test`), and add `playwright` to `next.config.ts`'s `serverExternalPackages` so Next's build tracer doesn't mis-bundle it.
**Files**: lib/connectors/playwrightSession.ts, package.json, next.config.ts
**Test**: Write a focused test that mocks `getDecryptedCredential` with a dry-run credential, calls `withSession` with a no-op action, and asserts no browser context is created and `dryRunLog()` returns a message instead. Write a second test asserting `validateSessionReadOnly()` never triggers a login attempt even when the session is invalid. Mock the `playwright` module itself at the module level (`vi.mock('playwright', ...)`) in all Playwright-related tests, not just via dry-run credentials, so `npm test` can never launch a real browser regardless of a bug elsewhere. Run `npm install` and verify `node_modules/playwright/` exists; `npm list playwright` shows the installed version. Run `npm run build` and verify it still succeeds with `playwright` as a production dependency.
**Depends on**: Step 1, Step 2
**Parallelizable**: No

### Step 11a: Implement eBay OAuth token exchange and API client setup
**What**: Implement OAuth token exchange skeleton and envConfig wiring for eBay (via `apiCredential.ts`'s `getFreshAccessToken` and, if built, a shared `lib/connectors/apiFetch.ts` HTTP wrapper), establishing the foundation for subsequent raw method implementations.
**Files**: lib/connectors/ebay.ts (partial OAuth setup), lib/connectors/apiFetch.ts
**Test**: Unit test asserting that `getFreshAccessToken` can be called with mocked credential storage, and that token exchange parameters are correctly formatted for eBay Sandbox.
**Depends on**: Step 1, Step 2, Step 5, Step 6, Step 7
**Parallelizable**: No

### Step 11b: Implement eBay raw methods (createListing, updateListing, markSold, delist, checkConnectionHealth) with mocked HTTP
**What**: Implement all 5 raw methods against eBay Sell Inventory API with focused unit tests using mocked HTTP responses. Define eBay's specific suspension-classification rules (which 401/403 + error-code combinations count as positively-classified suspension vs. ambiguous/transient).
**Files**: lib/connectors/ebay.ts, lib/connectors/__tests__/ebay.test.ts
**Test**: `npm test -- lib/connectors/__tests__/ebay.test.ts` — unit tests with mocked HTTP must pass; verify each method correctly builds requests and parses responses; verify connector throws `ConnectorNotConfiguredError` when `EBAY_ENV` is unset.
**Depends on**: Step 11a
**Parallelizable**: No

### Step 11c: Implement eBay Sandbox integration test harness (skip-gated)
**What**: Write a skip-gated Sandbox integration test that runs against real eBay Sandbox only when `EBAY_SANDBOX_CLIENT_ID` is configured.
**Files**: lib/connectors/__tests__/ebay.sandbox.test.ts
**Test**: `npm test -- lib/connectors/__tests__/ebay.sandbox.test.ts` — must skip when `EBAY_SANDBOX_CLIENT_ID` is unset, and pass with real Sandbox calls when present.
**Depends on**: Step 11b
**Parallelizable**: No

### Step 12: Implement Etsy Open API v3 connector with PKCE and draft-only listings
**What**: Implement `etsy.ts` with raw methods using Etsy Open API v3, OAuth 2.0 Authorization Code Grant with mandatory PKCE, and a strict requirement that listings are always created/updated in draft state, never active (hardcoded this increment — no toggle exists). Implement `markSold`/`delist` against draft-state listings (Etsy allows deleting/updating a draft's state without ever activating it, so both are fully testable without live activation). Define Etsy's specific suspension-classification rules.
**Files**: lib/connectors/etsy.ts, lib/connectors/__tests__/etsy.test.ts
**Test**: `npm test -- lib/connectors/__tests__/etsy.test.ts` (mocked HTTP tests); write a specific assertion in the test that the `createListing` request payload always carries `state: "draft"` and never `"active"`, and that `updateListing` never changes state to active. Add assertions that `markSold`/`delist` succeed against a draft-state listing and no-op with `{ok:false, reason:'not_found'}` against an already-terminal one.
**Depends on**: Step 1, Step 2, Step 5, Step 6, Step 7
**Parallelizable**: Yes (with other connectors)

### Step 13: Implement Amazon SP-API connector (inert-by-default via AmazonNotConfiguredError)
**What**: Implement `amazon.ts` with raw methods that throw `AmazonNotConfiguredError` (extends `ConnectorNotConfiguredError`) when required environment variables (`AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, `AMAZON_SP_API_REFRESH_TOKEN`) are unset; unit tests mock HTTP and test request-building and error-mapping logic only.
**Files**: lib/connectors/amazon.ts, lib/connectors/__tests__/amazon.test.ts
**Test**: `npm test -- lib/connectors/__tests__/amazon.test.ts`; write a test that unsets all Amazon env vars and calls each of the 5 methods, asserting `AmazonNotConfiguredError` is thrown before any HTTP call is made.
**Depends on**: Step 1, Step 2, Step 5, Step 7
**Parallelizable**: Yes (with other connectors)

### Step 14a: Implement Poshmark connector durable cooldown and share-cap persistence logic
**What**: Implement the durable cooldown/share-cap persistence logic for Poshmark, including SQL query functions for the 60-day cooldown check (`SELECT MAX(delisted_at)...`) and 24-hour share-cap enforcement (`SELECT COUNT(*)...`) against migration 009/010 tables, and the `sharePoshmarkListing(tenantId, connectionId, itemId)` method itself, explicitly gated via its own `assertCanAutomate` call since it's outside `gate.ts`'s automatic wrapping of the 5-method interface.
**Files**: lib/connectors/poshmark.ts (partial — persistence/gating logic)
**Test**: Write unit tests asserting that: (1) the cooldown SQL query correctly identifies whether 60+ days have passed since a delist, (2) the share-cap SQL query correctly counts actions in the 24-hour window, (3) `sharePoshmarkListing` throws `PoshmarkCooldownError` with the appropriate `kind` when checks fail, and is itself blocked by `assertCanAutomate` when consent/status gating fails.
**Depends on**: Step 1, Step 2, Step 3, Step 7
**Parallelizable**: No

### Step 14b: Implement Poshmark Playwright action layer (createListing, updateListing, markSold, delist, dry-run handling)
**What**: Implement the Playwright action layer for Poshmark — the 5 raw methods (createListing/updateListing/markSold/delist plus checkConnectionHealth) using `playwrightSession.ts`, dry-run-by-default handling, and session persistence. Define Poshmark's specific suspension-classification rules (DOM text/banner patterns).
**Files**: lib/connectors/poshmark.ts (continuation/completion), lib/connectors/__tests__/poshmark.test.ts
**Test**: `npm test -- lib/connectors/__tests__/poshmark.test.ts`; write assertions that: (1) attempting a relist within 60 days of delist throws `PoshmarkCooldownError` with kind `'relist_cooldown'`, while a relist at 61+ days succeeds; (2) share actions hitting the 24-hour cap throw `PoshmarkCooldownError` with kind `'share_cap'`; (3) dry-run mode never creates a browser context; (4) `checkConnectionHealth` never triggers a fresh login even against an invalid session.
**Depends on**: Step 14a, Step 10
**Parallelizable**: No

### Step 15: Implement Depop connector with Playwright and conservative pacing
**What**: Implement `depop.ts` with raw methods using Playwright, dry-run-by-default, session persistence via `playwrightSession.ts`, and `pacing.ts` enforcement of the 10-second-per-action rate limit. Define Depop's specific suspension-classification rules (conservative defaults given no documented platform policy).
**Files**: lib/connectors/depop.ts, lib/connectors/__tests__/depop.test.ts
**Test**: `npm test -- lib/connectors/__tests__/depop.test.ts`; write assertions that dry-run mode never launches a browser context and that exceeding the 10-second pacing window throws `ConnectorRateLimitedError`.
**Depends on**: Step 1, Step 7, Step 9, Step 10
**Parallelizable**: Yes (with other connectors)

### Step 16: Implement Mercari connector with Playwright and conservative pacing
**What**: Implement `mercari.ts` with raw methods using Playwright, dry-run-by-default, session persistence via `playwrightSession.ts`, and `pacing.ts` enforcement.
**Files**: lib/connectors/mercari.ts, lib/connectors/__tests__/mercari.test.ts
**Test**: `npm test -- lib/connectors/__tests__/mercari.test.ts`; write assertions mirroring Depop's (dry-run safety, pacing enforcement).
**Depends on**: Step 1, Step 7, Step 9, Step 10
**Parallelizable**: Yes (with other connectors)

### Step 17: Implement Vinted connector with Playwright and conservative pacing
**What**: Implement `vinted.ts` with raw methods using Playwright, dry-run-by-default, session persistence, and pacing enforcement.
**Files**: lib/connectors/vinted.ts, lib/connectors/__tests__/vinted.test.ts
**Test**: `npm test -- lib/connectors/__tests__/vinted.test.ts`; same dry-run and pacing assertions as Depop/Mercari.
**Depends on**: Step 1, Step 7, Step 9, Step 10
**Parallelizable**: Yes (with other connectors)

### Step 18: Implement Grailed connector with Playwright and conservative pacing
**What**: Implement `grailed.ts` with raw methods using Playwright, dry-run-by-default, session persistence, and pacing enforcement.
**Files**: lib/connectors/grailed.ts, lib/connectors/__tests__/grailed.test.ts
**Test**: `npm test -- lib/connectors/__tests__/grailed.test.ts`; same dry-run and pacing assertions.
**Depends on**: Step 1, Step 7, Step 9, Step 10
**Parallelizable**: Yes (with other connectors)

### Step 19: Implement connector registry factory with runtime platform guard
**What**: Write `registry.ts` that exports `getConnector(platform: string)`, checks `platform ∈ SUPPORTED_PLATFORMS` at runtime (throwing `UnsupportedPlatformError` if not), uses `satisfies Record<SupportedPlatform, Connector>` on its platform-to-connector map for compile-time exhaustiveness, and returns the appropriate connector singleton (each built once via `buildConnector` from `gate.ts`).
**Files**: lib/connectors/registry.ts
**Test**: Write a focused test that calls `getConnector('ebay')` and asserts the returned connector is the eBay connector; call `getConnector('invalid_platform')` and assert `UnsupportedPlatformError` is thrown.
**Depends on**: Step 1, Step 2, Step 7, Step 11c, Step 12, Step 13, Step 14b, Step 15, Step 16, Step 17, Step 18
**Parallelizable**: No

### Step 20: Write comprehensive gating integration tests
**What**: Write `lib/connectors/__tests__/gate.test.ts` with assertions covering: consent gates (missing-consent error blocks calls), connection status gates (suspended/revoked status blocks calls), re-checking on every invocation (a kill-switch mid-sequence blocks the second call), no credential leakage in errors, and `recordListingCreated` is called on successful `createListing`. Exercise `buildConnector()` against a hand-written fake/mock `rawMethods` stub, not the real connector implementations — this keeps the test fast and independent of the connector layer.
**Files**: lib/connectors/__tests__/gate.test.ts
**Test**: `npm test -- lib/connectors/__tests__/gate.test.ts` — all assertions pass; verify that a seeded secret string does not appear in any thrown error message or console output.
**Depends on**: Step 1, Step 4, Step 5, Step 7
**Parallelizable**: Yes

### Step 21: Write comprehensive itemPlatformsWrite integration tests
**What**: Write `lib/connectors/__tests__/itemPlatformsWrite.test.ts` with assertions for: upsert behavior (second `createListing` for same item+platform updates, not duplicates), `UNIQUE(item_id, platform)` constraint is respected, and `external_listing_id` is persisted.
**Files**: lib/connectors/__tests__/itemPlatformsWrite.test.ts
**Test**: `npm test -- lib/connectors/__tests__/itemPlatformsWrite.test.ts` — all assertions pass.
**Depends on**: Step 1, Step 2, Step 3, Step 4
**Parallelizable**: Yes

### Step 22: Write comprehensive registry integration tests
**What**: Write `lib/connectors/__tests__/registry.test.ts` with assertions covering: runtime platform guard (garbage string throws `UnsupportedPlatformError`), all 8 `SUPPORTED_PLATFORMS` values return the correct connector, and each connector is a gated instance (consent/status checks are active).
**Files**: lib/connectors/__tests__/registry.test.ts
**Test**: `npm test -- lib/connectors/__tests__/registry.test.ts` — all assertions pass; specifically assert that calling a gated method through a registry-returned connector without valid consent/active status throws `ConnectorGatingError`.
**Depends on**: Step 19
**Parallelizable**: Yes

### Step 23a: Write suspension signal detection tests (API-tier connectors: eBay, Etsy, Amazon)
**What**: Extend the test suites for the 3 API-tier connectors (ebay.test.ts, etsy.test.ts, amazon.test.ts) to explicitly verify AC12 and AC13: test that platform responses classified as account-suspension signals (401/403 with suspension error codes) trigger exactly one call to `recordSuspensionSignal` with a non-secret reason string, and that ambiguous/transient errors (500, timeout, 429) do not trigger `recordSuspensionSignal`. Include a case for OAuth refresh-token revocation (distinct from access-token expiry) classified per the same rules.
**Files**: lib/connectors/__tests__/ebay.test.ts, lib/connectors/__tests__/etsy.test.ts, lib/connectors/__tests__/amazon.test.ts
**Test**: `npm test -- lib/connectors/__tests__/{ebay,etsy,amazon}.test.ts`; verify each test suite includes assertions for: (1) suspension-shaped error responses trigger `recordSuspensionSignal` exactly once with a valid, scrubbed reason string, (2) transient error responses (5xx, timeout, 429) do not trigger `recordSuspensionSignal`, (3) `recordSuspensionSignal` is called with arguments that contain no credential material.
**Depends on**: Step 1, Step 11c, Step 12, Step 13
**Parallelizable**: Yes

### Step 23b: Write suspension signal detection tests (browser-tier connectors: Poshmark, Depop, Mercari, Vinted, Grailed)
**What**: Extend the test suites for the 5 browser-tier connectors (poshmark.test.ts, depop.test.ts, mercari.test.ts, vinted.test.ts, grailed.test.ts) with the same suspension signal and transient error detection assertions as Step 23a, using each platform's DOM-text-based classification rules.
**Files**: lib/connectors/__tests__/poshmark.test.ts, lib/connectors/__tests__/depop.test.ts, lib/connectors/__tests__/mercari.test.ts, lib/connectors/__tests__/vinted.test.ts, lib/connectors/__tests__/grailed.test.ts
**Test**: `npm test -- lib/connectors/__tests__/{poshmark,depop,mercari,vinted,grailed}.test.ts`; same three assertions as Step 23a, adapted to each platform's classification rules.
**Depends on**: Step 1, Step 14b, Step 15, Step 16, Step 17, Step 18
**Parallelizable**: Yes

### Step 24: Verify npm test passes without any platform credentials configured
**What**: Run the full test suite (`npm test`) with all platform-level app credentials unset in the environment (EBAY_SANDBOX_CLIENT_ID, ETSY_API_KEY, AMAZON_LWA_CLIENT_ID, etc.) and verify all tests pass, demonstrating that the system is "wired but inert until credentialed" as required by AC14. This is a verification that the cumulative effect of dry-run defaults, skip-gated Sandbox tests, and AmazonNotConfiguredError throws results in a fully passing test suite with zero live credentials configured. Also run `npm run build` to confirm the `playwright` production dependency doesn't break the build.
**Files**: none (verification only; no new files created)
**Test**: Set all platform credential environment variables to unset, run `npm test`, and assert exit code is 0 (success) with all tests either passing or being skipped due to missing credentials. Run `npm run build` and assert success. Document any tests that require credentials and verify they are properly skip-gated.
**Depends on**: Step 1, Step 2, Step 3, Step 4, Step 5, Step 6, Step 7, Step 8, Step 9, Step 10, Step 11a, Step 11b, Step 11c, Step 12, Step 13, Step 14a, Step 14b, Step 15, Step 16, Step 17, Step 18, Step 19, Step 20, Step 21, Step 22, Step 23a, Step 23b
**Parallelizable**: No

### Step 25: Create .env.example and update README.md with Marketplace Connectors section
**What**: Verify `.gitignore` already covers `.env`/`.env.local` (add coverage if missing) before writing `.env.example`. Write a new `.env.example` file documenting placeholder entries for every platform-level app credential: `EBAY_SANDBOX_CLIENT_ID`, `EBAY_SANDBOX_CLIENT_SECRET`, `EBAY_ENV` (default `sandbox`), `ETSY_API_KEY`, `ETSY_SHARED_SECRET`, `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, `AMAZON_SP_API_REFRESH_TOKEN`, `AMAZON_SP_API_ROLE_ARN`. Additionally, add a new "Marketplace Connectors" section to `README.md` with: a table listing operability tier for each of the 8 platforms (real-Sandbox-tested, live-draft-only, inert-until-credentialed, dry-run-until-credentialed), a note that `playwright` is now a production dependency requiring a persistent server process (not serverless/edge-friendly) and browser-binary provisioning (`playwright install`) at deploy time, a pointer to `.env.example` for app-credential configuration, and brief usage notes (e.g. "Etsy has no sandbox; draft listings are created on real account").
**Files**: .env.example, README.md, .gitignore
**Test**: Verify `.env.example` is readable and contains all 9 entries; verify it follows the `KEY=value # comment` format and notes which variables are sandbox vs. live. Verify README section exists, contains all 8 platforms with their operability tier and the deployment-model note, and the `.env.example` reference is correct. Verify `.gitignore` contains an `.env` (or `.env*`) pattern.
**Depends on**: Step 11c, Step 12, Step 13, Step 14b
**Parallelizable**: No

## Rollback plan

All steps are reversible via `git`:
- Steps 1–25 modify or create files under `lib/connectors/`, `lib/automationGate.ts`, `data/migrations/`, or config files (`.env.example`, `README.md`, `package.json`, `next.config.ts`). None delete or destructively rewrite existing tables or core logic.
- The two migrations (Step 3) are `ADD COLUMN` and `CREATE TABLE IF NOT EXISTS`, both idempotent; rolling back means decrementing `PRAGMA user_version` in `lib/db.ts` and deleting the migration files — the tables will persist but unused (safe). **IMPORTANT:** Rolling back Step 3 (the two migrations) must happen **LAST**, after every step that depends on `item_platforms.external_listing_id` or the Poshmark pacing tables (Steps 4, 14a/14b, 19–24) has already been rolled back — rolling back Step 3 in isolation while those dependent steps' code still exists will break them immediately (missing column/tables) on any fresh DB (CI, new deploy, `:memory:` test run).
- Rolling back the Poshmark connector logic (Steps 14a/14b implementing poshmark.ts) **AFTER real Poshmark browser-automation has already run against a real tenant account** (i.e., after `poshmark_delist_events`/`poshmark_share_events` already hold real historical rows) is **NOT safe to do casually**. The durable tracking DATA persists through a code rollback, but the ENFORCEMENT (the cooldown/cap check logic) goes away with the code, silently reopening the exact ban-risk window those tables exist to prevent. A rollback in that situation must first confirm no real Poshmark automation has run, or must keep the enforcement logic in place even while rolling back other changes.
- If a live deployment is made before discovering a bug, running `git reset --hard HEAD~N` (for N steps) will revert all changes; the app will continue to function with the `SUPPORTED_PLATFORMS` it had before this increment (connectors simply won't be wired into API routes until a follow-on step does so).
