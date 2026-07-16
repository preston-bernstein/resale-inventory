# Plan: Marketplace Connector Tier

## Approach

One shared `Connector` TypeScript interface (5 methods) implemented by 8 platform modules under a new `lib/connectors/` subtree, wrapped by a single gating layer that re-checks `hasValidConsent`/`platform_connections.status` on every call rather than trusting connector code to remember. API-tier connectors (eBay, Etsy, Amazon) talk HTTP directly; browser-automation connectors (Poshmark, Depop, Mercari, Vinted, Grailed) share one Playwright session-persistence module so login/cookie-reuse/dry-run logic exists exactly once, not five times. Everything not backed by real credentials (Amazon, all 5 browser platforms by default) is inert-by-construction — the code path that would make a network/browser call is guarded by an explicit configuration check, not by a missing implementation — so `npm test`/`npm run build` never require a live secret.

Note up front: `docs/marketplace-connector-tier/requirements.md` says "7 platforms" in its problem statement and several FRs, but its own platform list (eBay, Etsy, Amazon + Poshmark, Depop, Mercari, Vinted, Grailed) and `lib/constants.ts`'s `SUPPORTED_PLATFORMS` both total 8. Per the requirements' own Constraints ("`SUPPORTED_PLATFORMS` ... is the sole source of valid platform identifiers"), this plan builds all 8. See Risk areas.

## Architecture

```
                         caller (future app/api/* route or script — none built this increment)
                                        │
                                        ▼
                         lib/connectors/registry.ts :: getConnector(platform)
                                        │  (runtime guard: platform ∈ SUPPORTED_PLATFORMS, FR3)
                                        ▼
                         lib/connectors/gate.ts :: buildConnector(rawMethods)
                    ┌───────────────────┼────────────────────────────┐
                    │  wraps createListing/updateListing/markSold/    │  checkConnectionHealth
                    │  delist in withGating():                        │  passes through
                    │    1. assertCanAutomate(tenantId, connectionId)│  ungated (FR6)
                    │       (lib/automationGate.ts — re-run fresh     │
                    │        every call, no caching → FR9)            │
                    │    2. on ok:false → throw ConnectorGatingError  │
                    │    3. on ok:true  → call raw method             │
                    │    4. on createListing success → write          │
                    │       item_platforms row (itemPlatformsWrite.ts)│
                    └───────────────────┬────────────────────────────┘
                                        ▼
        ┌───────────────────────────────┴────────────────────────────────┐
        │  API tier (ebay.ts / etsy.ts / amazon.ts)                       │  Browser tier (poshmark.ts /
        │    lib/connectors/apiCredential.ts :: getFreshAccessToken()     │  depop.ts / mercari.ts /
        │      → getDecryptedCredential (per-call, never cached)          │  vinted.ts / grailed.ts)
        │      → platform token endpoint if expired                      │    lib/connectors/playwrightSession.ts
        │      → rotateCredential to persist the new token                │      → dry-run short-circuit
        │    lib/connectors/envConfig.ts :: requireEnv() — app creds      │      → load/reuse persisted
        │      from process.env, throws a clear error per-call, not      │        session (via
        │      at import time (FR40: one platform's missing config       │        getDecryptedCredential)
        │      must not break another's)                                 │      → fresh login (≤1 retry)
        └───────────────────────────────┬──────────────────────┬────────┘        → persist session (via
                                        ▼                      ▼                    rotateCredential)
                          recordSuspensionSignal()   lib/connectors/pacing.ts (Depop/Mercari/Vinted/Grailed,
                          (lib/connections.ts,        in-memory) — OR poshmark.ts's own durable cooldown/
                          only on classified          share-cap tables (migration 010)
                          suspension signals)
```

`checkConnectionHealth` is ungated with respect to `assertCanAutomate` (FR6) for both tiers, but the two tiers implement it differently. API-tier connectors just make a lightweight authenticated GET. Browser-tier connectors do **not** call the same `withSession()` used by the 4 mutating methods — routing health checks through `withSession()` would let a stale persisted session trigger `withSession()`'s ≤1-retry fresh-login fallback, turning routine health-check polling into an unthrottled, bot-detectable source of repeated login attempts. Instead, the 5 browser connectors' `checkConnectionHealth` calls a distinct read-only path, `playwrightSession.ts`'s `validateSessionReadOnly()`, which checks an existing persisted session without ever attempting a fresh login (see `playwrightSession.ts` in Integration points for the validation algorithm).

Data written by a successful `createListing` lands in the existing `item_platforms` table (plus one additive column — see Data model) via a single shared write path, not a new table — satisfying the "no parallel listing-tracking table" constraint (FR38).

## Data model

Two additive migrations, following the `005`–`008` numbered-file / `PRAGMA user_version` convention. Highest existing migration is `008` (`lib/db.ts`'s `VERSIONED_MIGRATIONS`), so these are `009` and `010`.

**`data/migrations/009_item_platforms_external_id.sql`**

```sql
ALTER TABLE item_platforms ADD COLUMN external_listing_id TEXT
  CHECK (external_listing_id IS NULL OR length(trim(external_listing_id)) BETWEEN 1 AND 255);

CREATE UNIQUE INDEX idx_item_platforms_external_listing
  ON item_platforms(platform, external_listing_id)
  WHERE external_listing_id IS NOT NULL;
```

Nullable, additive `ALTER TABLE ADD COLUMN` — same operation `006_tenant_scoping.sql` already performed on this exact table (`ADD COLUMN tenant_id`), so it has direct precedent and needs no table rebuild; the CHECK constraint only references the new column itself (SQLite allows this on `ADD COLUMN`) and is satisfied by the existing NULL rows. The partial unique index prevents two different items from resolving to the same external listing on the same platform, and doubles as the lookup index future webhook resolution will need. The length/format bound guards against empty-string or absurdly long garbage ever being written to this column. **Decision on the FR38/FR39 tension**: FR38 requires `createListing` to write the platform's external listing id into the `item_platforms` row; FR39, read literally, says to do so "without modifying item_platforms' schema." Those two can't both hold literally — `item_platforms` has no field today that can carry an external id, and AC11 requires that id be "captured" and verifiable by querying the row. This plan resolves the tension in favor of FR38 + AC11 (both unambiguous, and AC11 is directly testable) and reads FR39 as being about the *shape the write path consumes* — a single plain string, not a new nested structure — rather than a literal ban on any additive column. A one-column nullable `ALTER TABLE ADD COLUMN`, matching existing precedent on this table, is the minimal change that satisfies both; introducing a second table keyed by `(item_id, platform)` to hold just this one field would be the "parallel listing-tracking table" FR38 explicitly forbids.

**`data/migrations/010_poshmark_pacing.sql`**

```sql
CREATE TABLE IF NOT EXISTS poshmark_delist_events (
  id            TEXT NOT NULL PRIMARY KEY
                CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  connection_id TEXT NOT NULL REFERENCES platform_connections(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  delisted_at   TEXT NOT NULL DEFAULT (datetime('now'))
                CHECK (delisted_at = strftime('%Y-%m-%d %H:%M:%S', delisted_at))
);
CREATE INDEX IF NOT EXISTS idx_poshmark_delist_conn_item
  ON poshmark_delist_events(connection_id, item_id, delisted_at DESC);

CREATE TABLE IF NOT EXISTS poshmark_share_events (
  id            TEXT NOT NULL PRIMARY KEY
                CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  connection_id TEXT NOT NULL REFERENCES platform_connections(id) ON DELETE CASCADE,
  shared_at     TEXT NOT NULL DEFAULT (datetime('now'))
                CHECK (shared_at = strftime('%Y-%m-%d %H:%M:%S', shared_at))
);
CREATE INDEX IF NOT EXISTS idx_poshmark_share_conn_time
  ON poshmark_share_events(connection_id, shared_at DESC);
```

Two append-only event tables (not counters) — same "log every event, derive the count/window with a query" pattern as `connection_status_events` and `price_history`, so the 60-day relist check is `SELECT MAX(delisted_at) ... WHERE item_id = ? AND connection_id = ?` and the 24h share cap is `SELECT COUNT(*) ... WHERE connection_id = ? AND shared_at >= datetime('now','-24 hours')`. `ON DELETE CASCADE` mirrors `connection_status_events`/`tenant_consents`; `poshmark_delist_events.item_id` is now explicit `ON DELETE CASCADE` too (previously unspecified, inconsistent with `connection_id`'s explicit CASCADE on the same table). `tenant_id` is added directly to both tables — defense-in-depth consistent with `006_tenant_scoping.sql`'s precedent of putting `tenant_id` directly on scoped tables rather than leaving it reachable only via a join through `connection_id`. The `delisted_at`/`shared_at` CHECK constraints are tightened from `LIKE '____-__-__%'` (which allows non-digit garbage, since SQL `_` matches any character) to `= strftime('%Y-%m-%d %H:%M:%S', col)`, guaranteeing a real, lexicographically-sortable datetime.

These two tables intentionally stay Poshmark-specific rather than becoming a generic `platform_pacing_events` table: requirements 33–35 encode Poshmark-specific, documented legal/policy thresholds (the 60-day relist window, the 3500/24h share cap) that are meaningfully different in kind from the other 4 browser platforms' generic, undocumented-threshold rate-limit defaults (FR36/`lib/rateLimit.ts`, see below). This is a deliberate scope decision, not an oversight.

Also a documented decision, no code change: `platform_connections.status`'s existing CHECK enum (`active`/`suspended`/`revoked`) is **not** extended with a new `rate_limited` value. Pacing/cooldown throttle errors (`PoshmarkCooldownError`, `ConnectorRateLimitedError`) are connector-level, per-call rejections and intentionally do not transition the connection's overall status; only kill-switch suspension signals (requirement 12, via `recordSuspensionSignal()`) do that.

`CREATE TABLE IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS` are kept as-is here, not switched to bare `CREATE TABLE`/`CREATE INDEX` — this matches this repo's established convention (see `001_init.sql`'s documented rationale in `lib/db.ts`'s comments) of using `IF NOT EXISTS` defensively given the documented history of concurrent Next.js build-worker migration races in this repo. A bare `CREATE TABLE` would be inconsistent with established precedent, not an improvement.

**Depop/Mercari/Vinted/Grailed pacing state: no table.** FR36's default (1 action per tenant+connection per 10 seconds) is a fixed-window rate limit, structurally identical to the existing in-memory limiter in `lib/rateLimit.ts` (built for auth-endpoint throttling, same "process-local, resets on restart" tradeoff already accepted there). Requirement 31/36 do not demand durability the way requirement 35 explicitly does for Poshmark, and the failure mode of losing this state on restart is bounded: worst case is one action fires without waiting out a partial 10-second window — negligible next to Poshmark's 60-day/24h windows, where forgetting state on restart could let a real policy-violating relist through. Building a durable table for a 10-second window would be the over-engineering this repo's architecture contract explicitly warns against. `lib/connectors/pacing.ts` reuses `checkRateLimit(key, limit, windowMs)` directly, keyed `${platform}:${connectionId}`.

**This reuse assumes single-instance deployment.** Like the existing `lib/rateLimit.ts` usage it borrows, this in-memory pacing state is process-local — it assumes the app runs as a single Node process, consistent with the existing single-file `better-sqlite3` deployment model. If the app is ever scaled to multiple instances, this pacing guarantee breaks silently (each instance enforces its own independent 10-second window against the same tenant+connection) and must be revisited — swap to a DB-backed limiter at that point, not before.

`lib/db.ts`'s `VERSIONED_MIGRATIONS` gains two entries: `{ version: 9, file: '009_item_platforms_external_id.sql' }`, `{ version: 10, file: '010_poshmark_pacing.sql' }`.

## API / interface contract

No HTTP surface — wiring connectors into `app/api/items` routes or a UI is explicitly out of scope this increment. The contract is the shared TypeScript interface and the registry/factory function.

**`lib/connectors/types.ts`** (new):

```ts
import type { BookDetails, ClothingDetails } from '@/lib/types'; // reused, not re-declared

export interface ListingInput {
  itemId: string;
  tenantId: string;
  connectionId: string;
  title: string;
  priceCents: number;               // caller already ran this through lib/money.ts — FR4
  category: 'book' | 'clothing';
  details: BookDetails | ClothingDetails;  // same shape the rest of the app uses for item category details
  photos: Photo[];
}

export type NotFoundResult = { ok: false; reason: 'not_found' };
export type UpdateListingResult = { ok: true } | NotFoundResult;
export type MarkSoldResult = { ok: true } | NotFoundResult;
export type DelistResult = { ok: true } | NotFoundResult;
export interface CreateListingResult { externalListingId: string; }
export interface HealthResult { healthy: boolean; detail?: string; }

export interface Connector {
  createListing(input: ListingInput): Promise<CreateListingResult>;
  updateListing(
    externalListingId: string, tenantId: string, connectionId: string,
    patch: Partial<Pick<ListingInput, 'title' | 'priceCents' | 'details'>>,
  ): Promise<UpdateListingResult>;
  markSold(externalListingId: string, tenantId: string, connectionId: string): Promise<MarkSoldResult>;
  delist(externalListingId: string, tenantId: string, connectionId: string): Promise<DelistResult>;
  checkConnectionHealth(tenantId: string, connectionId: string): Promise<HealthResult>;
}

// Shared error types (FR7, FR8, FR25) — thrown, never returned as data, so
// callers can't accidentally ignore them the way they could a result field.
// All extend a common ConnectorError base so callers can do a single
// `catch (e) { if (e instanceof ConnectorError) ... }` check.
export class ConnectorError extends Error {}

export class ConnectorGatingError extends ConnectorError {
  readonly kind: 'missing_consent' | 'connection_not_active';
  constructor(kind: 'missing_consent' | 'connection_not_active', connectionId: string) { ... }
}
export class UnsupportedPlatformError extends ConnectorError { constructor(platform: string) { ... } }
export class ConnectorNotConfiguredError extends ConnectorError {          // eBay/Etsy missing app env (FR14)
  constructor(platform: string, missingVar: string) { ... }
}
// Amazon's "not configured" gate is categorically heavier than a missing API
// key — a paid Professional Selling Plan plus a completed Developer Profile
// that only the human account owner can obtain — so it warrants its own
// subclass rather than the generic ConnectorNotConfiguredError. General
// principle for future platforms: default to ConnectorNotConfiguredError;
// only add a dedicated subclass when a platform's "not configured" state has
// a materially different meaning worth distinguishing.
export class AmazonNotConfiguredError extends ConnectorNotConfiguredError { ... }  // FR25
export class ConnectorPlatformError extends ConnectorError {               // scrubbed platform error (FR11)
  constructor(platform: string, code: string, message: string) { ... }
}
export class PoshmarkCooldownError extends ConnectorError {                // FR33/FR34
  readonly kind: 'relist_cooldown' | 'share_cap';
  constructor(kind: 'relist_cooldown' | 'share_cap', connectionId: string) { ... }
}
export class ConnectorRateLimitedError extends ConnectorError { ... }      // FR36 (Depop/Mercari/Vinted/Grailed)
```

**Error handling convention.** Gating failures (`ConnectorGatingError`), configuration errors (`ConnectorNotConfiguredError`/`AmazonNotConfiguredError`), rate-limit/cooldown blocks (`ConnectorRateLimitedError`/`PoshmarkCooldownError`), and platform errors (`ConnectorPlatformError`) are all *thrown* — each represents "the caller's request could not proceed." The one exception is `{ ok: false, reason: 'not_found' }`: the platform reporting that a listing no longer exists is a normal, expected steady-state outcome of `updateListing`/`markSold`/`delist` (e.g. a tenant deleted the listing directly on the platform), not an exceptional one, so it's a returned result rather than a thrown error. This is a documented decision, not an implicit inconsistency.

**`lib/connectors/registry.ts`** (new):

```ts
import type { SupportedPlatform } from '@/lib/constants'; // add this type export alongside SUPPORTED_PLATFORMS

const CONNECTORS = {
  ebay: ebayConnector,
  etsy: etsyConnector,
  amazon: amazonConnector,
  poshmark: poshmarkConnector,
  depop: depopConnector,
  mercari: mercariConnector,
  vinted: vintedConnector,
  grailed: grailedConnector,
} satisfies Record<SupportedPlatform, Connector>;

export function getConnector(platform: string): Connector {
  if (!SUPPORTED_PLATFORMS.includes(platform as SupportedPlatform)) {
    throw new UnsupportedPlatformError(platform);
  }
  return CONNECTORS[platform as SupportedPlatform];
}
```

Runtime guard (FR3) is the `includes` check above, covered by a test passing an arbitrary garbage string — this is for genuinely unexpected/garbage string input at the call boundary. Separately, `CONNECTORS` uses `satisfies Record<SupportedPlatform, Connector>` so a typo'd or missing map key is a *compile-time* error, not just a runtime `UnsupportedPlatformError` — a check on the internal correctness of the map itself. The runtime guard and the compile-time exhaustiveness check are two different, both-necessary safeguards, not redundant with each other.

Each `*Connector` singleton is built once per module via `lib/connectors/gate.ts`'s `buildConnector()` (see below), so `getConnector` itself does no gating — gating already happened when the module built the singleton. Connector singletons are built once at module-import time, reading `process.env` once (via `envConfig.ts`/`apiCredential.ts`) — there is no per-tenant or per-request connector configuration in this design. `tenantId`/`connectionId` are passed at call time, not baked into the closure, which is what keeps a single module-level singleton workable across every tenant; this is a documented boundary of the design, not something to be discovered later.

**`lib/connectors/gate.ts`** (new) — the single gating wrapper (requirement 4 in the brief):

```ts
type RawMethods = Omit<Connector, 'checkConnectionHealth'> & { checkConnectionHealth: Connector['checkConnectionHealth'] };

export function buildConnector(platform: SupportedPlatform, raw: RawMethods): Connector {
  const gated = <A extends [tenantId: string, connectionId: string, ...rest: any[]], R>(
    fn: (...a: A) => Promise<R>,
  ) => async (...a: A): Promise<R> => {
    const [tenantId, connectionId] = a;
    const result = assertCanAutomate(tenantId, connectionId);   // fresh DB read every call — FR9
    if (!result.ok) {
      throw new ConnectorGatingError(
        result.reason === 'consent_required' ? 'missing_consent' : 'connection_not_active',
        connectionId,
      );
    }
    return fn(...a);
  };

  return {
    createListing: async (input) => {
      const gateResult = assertCanAutomate(input.tenantId, input.connectionId);
      if (!gateResult.ok) throw new ConnectorGatingError(/* ... */);
      const result = await raw.createListing(input);
      recordListingCreated(input.tenantId, input.itemId, platform, result.externalListingId); // FR38, centralized once
      return result;
    },
    updateListing: gated(raw.updateListing),
    markSold: gated(raw.markSold),
    delist: gated(raw.delist),
    checkConnectionHealth: raw.checkConnectionHealth,   // ungated — FR6
  };
}
```

This is the "implement gating once, wrap all 8" answer: every platform module (`ebay.ts`, `poshmark.ts`, etc.) exports only its 5 *raw*, ungated methods; `registry.ts` calls `buildConnector(platform, rawMethods)` once at module load to produce the exported singleton. No platform module ever calls `assertCanAutomate`/`hasValidConsent` itself — the pattern is enforced structurally (only `gate.ts` imports `lib/automationGate.ts`), not by convention alone. `item_platforms` writes are similarly centralized in `gate.ts`'s `createListing` wrapper, not duplicated in all 8 raw implementations.

**Method signature notes**: `updateListing`/`markSold`/`delist` all take `(externalListingId, tenantId, connectionId, ...)` — `externalListingId` first because it's the thing the platform call is actually keyed on; `tenantId`/`connectionId` are what the gate needs. Every raw implementation must treat a platform "listing not found" response as `{ ok: false, reason: 'not_found' }`, never a thrown error (FR5) — API-tier connectors map the platform's 404/"resource not found" error code to this; browser connectors map "item no longer in closet/listing not on page" to this.

## Integration points

- `lib/connectors/types.ts` — new. Shared `Connector` interface, `ListingInput`/result types, all error classes.
- `lib/connectors/registry.ts` — new. `getConnector(platform)` factory + runtime `SUPPORTED_PLATFORMS` guard.
- `lib/connectors/gate.ts` — new. Single gating wrapper (`buildConnector`) + centralized `item_platforms` write-on-success.
- `lib/connectors/itemPlatformsWrite.ts` — new. `recordListingCreated(tenantId, itemId, platform, externalListingId)` — `INSERT ... ON CONFLICT(item_id, platform) DO UPDATE` upsert against the existing `UNIQUE(item_id, platform)` index, so a second `createListing` for the same item+platform updates rather than duplicates (AC11).
- `lib/connectors/envConfig.ts` — new. `requireEnv(platform, varName)` — throws `ConnectorNotConfiguredError` at first call, not import time, so one platform's missing env var can't break another's module load (FR14, FR40).
- `lib/connectors/apiCredential.ts` — new. `getFreshAccessToken(tenantId, connectionId, exchangeFn)` shared by `ebay.ts`/`etsy.ts` — decrypts the tenant's stored token via `getDecryptedCredential`, reuses a cached-in-the-credential-blob access token until near expiry, else calls `exchangeFn` and persists the result via `rotateCredential` (FR15). Adds a short-TTL (~60s) in-memory cache of the *decrypted* access token keyed by `connectionId`, invalidated immediately on any token rotation, so read-heavy paths (e.g. repeated `checkConnectionHealth` polling) don't decrypt secret material on every single call; any real mutating action still resolves through the same expiry check, so FR10's "a fresh token for any real action" guarantee holds — only the redundant *decryption* work across back-to-back reads is what's being cached, not staleness tolerance.
- `lib/connectors/apiFetch.ts` — new. Thin wrapper around global `fetch` shared by `ebay.ts`/`etsy.ts`/`amazon.ts` — centralizes request timeout, a single-retry-on-transient-error policy, and response-classification hooks (success / platform-error / retryable), so this logic isn't triplicated across the three API-tier connector modules. Does not add a new dependency — still plain `fetch`.
- `lib/connectors/playwrightSession.ts` — new. Shared by the 5 browser connectors: `isDryRunCredential()`, `withSession()` (load persisted cookies/localStorage via `getDecryptedCredential`, validate, fresh-login-once-on-failure, persist via `rotateCredential`) for the 4 mutating methods, and `validateSessionReadOnly()` for `checkConnectionHealth` — checks an existing persisted session without ever attempting a fresh login (see Architecture). **Session validation** (used by both paths): a lightweight, read-only authenticated page load — e.g. navigating to the platform's own account/closet page — checking whether the response lands on an authenticated page or gets redirected to a login page; a redirect-to-login is "session invalid," which triggers the fresh-login fallback for `withSession()`'s mutating callers, or a `healthy: false` result for `validateSessionReadOnly()`. **Per-connectionId serialization**: `withSession()` holds a per-`connectionId` async lock/queue so two concurrent mutating calls against the same tenant+connection's browser session serialize rather than race — racing risks corrupt/clobbered persisted session state and looks like concurrent-session bot-detection signals to the platform. **Cross-tenant isolation**: each call constructs a fresh, isolated browser context/cookie-jar scoped to the specific `tenantId`+`connectionId` pair being acted on for that call — never a shared/global/reused-across-tenants browser context or cookie store.
- `lib/connectors/pacing.ts` — new. Thin wrapper over `lib/rateLimit.ts`'s `checkRateLimit` for the 4 non-Poshmark browser connectors.
- `lib/connectors/poshmark.ts` — new. Raw 5-method Poshmark connector + its own durable cooldown (`poshmark_delist_events`) and share-cap (`poshmark_share_events`) checks + a Poshmark-only `sharePoshmarkListing()` method (see Risk areas — not part of the shared interface, so `poshmark.ts` itself calls `assertCanAutomate(tenantId, connectionId)` directly for that method — it doesn't go through `gate.ts`'s automatic wrapping).
- `lib/connectors/scrub.ts` — new. A single `scrubCredentialFields(...)`-style function used by every connector's error-construction and every `recordSuspensionSignal` call site to strip anything a connector marks as credential-bearing before it reaches a thrown error, a log line, or the `reason` argument.
- `lib/connectors/ebay.ts` — new. eBay Sandbox connector (Sell Inventory API, OAuth 2.0 `sell.inventory`).
- `lib/connectors/etsy.ts` — new. Etsy Open API v3 connector, PKCE, draft-only.
- `lib/connectors/amazon.ts` — new. SP-API/LWA connector, inert-by-default via `AmazonNotConfiguredError`.
- `lib/connectors/depop.ts`, `lib/connectors/mercari.ts`, `lib/connectors/vinted.ts`, `lib/connectors/grailed.ts` — new. Playwright connectors sharing `playwrightSession.ts`/`pacing.ts`.
- **Suspension-classification contract** (no new file — documented convention across all 8 connectors). Each connector must define its own explicit, named list/table of conditions "positively classified as suspension" — specific HTTP status+error-code combinations for the 3 API-tier connectors (`ebay.ts`/`etsy.ts`/`amazon.ts`), specific DOM text/banner patterns for the 5 browser-tier connectors — rather than inventing this ad hoc per connector with no shared contract for what counts. Classification is inherently platform-specific so this doesn't need shared code, but does need a stated, consistent principle: err on the side of *not* classifying as suspension when uncertain (per requirement 13's "ambiguous errors are not suspension signals").
- `lib/connectors/__tests__/*.test.ts` — new. One file per connector + `gate.test.ts`, `registry.test.ts`, `itemPlatformsWrite.test.ts`, `ebay.sandbox.test.ts` (skip-gated), mirroring the existing flat `lib/__tests__/` convention one directory deeper. `gate.test.ts` exercises `buildConnector()` against a trivial hand-written fake/mock `rawMethods` stub, not the 8 real platform connectors — this keeps it a fast, early unit test unblocked right after `gate.ts` itself is written, not gated on the entire connector layer (including the 5 Playwright ones) being done.
- `lib/constants.ts` — modify. Add `SupportedPlatform` type export (`(typeof SUPPORTED_PLATFORMS)[number]`, currently only the const array exists) and the named pacing constants: `POSHMARK_RELIST_COOLDOWN_DAYS = 60`, `POSHMARK_SHARE_CAP_PER_24H = 3500`, `DEPOP_ACTION_RATE_LIMIT_MS`/`MERCARI_ACTION_RATE_LIMIT_MS`/`VINTED_ACTION_RATE_LIMIT_MS`/`GRAILED_ACTION_RATE_LIMIT_MS = 10_000` each (FR37 — one named constant per threshold, not a single shared default, so any one can be tightened independently later).
- `lib/db.ts` — modify. Append `{ version: 9, file: '009_item_platforms_external_id.sql' }` and `{ version: 10, file: '010_poshmark_pacing.sql' }` to `VERSIONED_MIGRATIONS`.
- `data/migrations/009_item_platforms_external_id.sql`, `data/migrations/010_poshmark_pacing.sql` — new, as above.
- `package.json` — modify. Add `"playwright"` to `dependencies` (distinct from the existing `@playwright/test` devDependency). No new npm scripts needed — connector tests run under the existing `npm test` (Vitest); no new script for "run Sandbox tests only" since `describe.skipIf` makes that unnecessary.
- `.env.example` — new file (none exists today). Placeholder entries for every platform-level app credential: `EBAY_SANDBOX_CLIENT_ID`, `EBAY_SANDBOX_CLIENT_SECRET`, `EBAY_ENV` (default `sandbox`), `ETSY_API_KEY`, `ETSY_SHARED_SECRET`, `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, `AMAZON_SP_API_REFRESH_TOKEN`, `AMAZON_SP_API_ROLE_ARN` (FR14/FR17/AC15).
- `README.md` — modify. New "Marketplace Connectors" section: per-platform operability tier table (real-Sandbox-tested / live-draft-only / inert-until-credentialed / dry-run-until-credentialed), the new `playwright` production dependency callout (still "no external *services* required," per the existing framing — this is a library, not a service), a pointer to `.env.example`, and an explicit deployment step for provisioning Playwright's browser binaries (`playwright install`) on the production target — see Technology choices; this is a deployment step this plan documents now, not something left undiscovered until first real production use.
- `next.config.js`/`next.config.ts` — modify. Add `playwright` to `serverExternalPackages` (or the equivalent current Next.js 15 config key) so Next's build tracer doesn't mis-bundle it into serverless function tracing for any route that imports a browser connector. Added now, alongside the `playwright` dependency addition, even though this increment builds no API routes yet — not deferred to a future routes increment. After this change and the `playwright` production-dependency addition, `npm run build` must be run and must succeed as part of verifying this increment — the one integration point in this plan with no prior test surface anywhere else in the repo, since nothing else has ever added a native-binary-shipping production dependency.
- `lib/automationGate.ts` — existing, unmodified by this increment. `assertCanAutomate(tenantId, connectionId)` combines `hasValidConsent()` + `platform_connections.status === 'active'` into one call; `gate.ts` (and `poshmark.ts`, for `sharePoshmarkListing()`) are this increment's callers. Lives in flat `lib/`, not `lib/connectors/`, consistent with where `lib/consent.ts`/`lib/connections.ts` already live, since it's shared platform-agnostic gating logic, not connector-specific. Listed here explicitly since the architecture diagram depends on it directly.
- `.gitignore` — verify only, no change expected. Confirm `.env`/`.env.local` are already covered before `.env.example` is added — don't assume this, check it as part of doing the work. (Confirmed at plan-writing time: the repo's `.gitignore` already has a blanket `.env*` pattern under its "env files" section.)
- `vitest.config.ts` — no change needed. `BOOKSELLER_DB_PATH`/`BOOKSELLER_CREDENTIAL_KEY_PATH` scratch-DB env is already global `test.env`, so connector tests (including the eBay Sandbox integration tests, which only point their *HTTP* calls at a real external endpoint) automatically get scratch-DB isolation for all `platform_connections`/`item_platforms`/tenant rows for free.

## Technology choices

- **`playwright` (production dependency)** — required by FR27; distinct from `@playwright/test` (test-runner-only) because the 5 browser connectors need to launch and drive a browser at runtime, not just in `test:e2e`. Rationale: it's the only headless-browser automation library already vetted in this repo (via `@playwright/test`), so no new vendor evaluation is needed — just a dependency-tier change for the same library. **This is a deployment-model decision, not just a dependency bump.** It requires a persistent, adequately-provisioned server process — real memory/CPU per concurrent browser session, headless Chromium alone is ~300MB+ — and rules out serverless/edge deployment for any route that uses these connectors. It also needs browser binaries provisioned at deploy time via `playwright install`, which is **not** automatically covered by `npm install --production`: `@playwright/test`'s existing binary cache is a dev/CI-machine artifact, not something a production deploy target already has. Browser-binary provisioning is therefore an explicit deployment step this plan documents (in `README.md`, not code — see Integration points) rather than something left to be discovered at first real production use.
- **In-memory fixed-window rate limiting (`lib/rateLimit.ts`, reused)** for the 4 non-Poshmark browser platforms — already exists in the repo for a structurally identical problem (auth throttling); reusing it avoids a second rate-limiter implementation for a requirement (FR36) that doesn't ask for durability.
- **No new HTTP client library.** eBay/Etsy/Amazon connectors use the platform's runtime-global `fetch` (Node 18+/Next 15 ships it) — the repo has no existing HTTP client dependency to match, and adding one (axios, ky, got) for three OAuth-flavored REST integrations would be scope creep against "no gold-plating."
- **No mocking library beyond Vitest's built-in `vi.mock`/`vi.spyOn`** for Amazon's mocked-HTTP unit tests and the browser connectors' "no browser context created" dry-run assertions — the repo has no `msw`/`nock` today and three platforms' worth of fetch-mocking doesn't justify introducing one. For the 5 browser connectors, `npm test` must never launch a real Chromium instance — this is guaranteed by mocking the `playwright` import itself at the module level (`vi.mock('playwright', ...)`) in every browser-connector test, in addition to — not instead of — the dry-run-credential short-circuit. Relying on dry-run behavior alone would not be sufficient test isolation, since a bug in the dry-run check could otherwise let a real browser launch slip through in CI.

## Browser connector design notes

- **Selector safety.** All 5 browser connectors use value-based Playwright APIs (`fill`, `check`, role/test-id locators) rather than interpolating tenant-supplied listing text (title/description) into dynamically-built selector strings — this avoids both selector breakage and a selector-injection-shaped risk class entirely.
- **No over-scraping.** Each browser connector's methods only ever navigate to the specific listing/item page(s) needed for the requested action — never enumerate/fetch the tenant's full closet/catalog as a side effect. This constraint is directly testable: assert the mocked Playwright page object's navigation calls are limited to the expected URLs for a given action.

## Risk areas

- **Requirements doc says "7 platforms," lists/requires 8.** This plan builds against `SUPPORTED_PLATFORMS` (8 entries, the constraints' stated source of truth), but every FR that says "7" is technically unsatisfied by an 8-connector build if read hyper-literally. Worth a one-line confirmation from the requirements' owner before or during implementation; this plan does not block on it since the constraint section is explicit that `SUPPORTED_PLATFORMS` wins.
- **Browser-automation selectors will drift.** Poshmark/Depop/Mercari/Vinted/Grailed selectors are built against each platform's real current UI (FR32) with zero test accounts — there is no automated way to detect a UI change breaking a selector until a tenant supplies real credentials and a live call fails. This is inherent to the browser-automation tier, not a gap this plan can close; the mitigation is dry-run-by-default plus `checkConnectionHealth` as an early-warning signal once credentials exist, not selector self-healing.
- **Etsy has no sandbox — "tested" means "creates real draft listings."** Once real Etsy credentials are configured, every `createListing`/`updateListing` call — including any manual smoke test — creates an actual listing in the tenant's real Etsy account (draft state, not published, but real). There is no environment where Etsy connector code can be exercised end-to-end without this being true; draft-state is the entire safety boundary (FR22), and a bug that flips `state` to `active` has no sandbox to catch it first, only the unit test asserting the literal request payload (AC6).
- **eBay Sandbox is not eBay production, and known to diverge from it in undocumented ways** (inventory/offer state quirks, occasional Sandbox-only 5xx flakiness, test-user account provisioning changing without notice). The idempotent-SKU design (NFR) handles repeated test runs but not Sandbox behavior that simply doesn't match production — a passing Sandbox suite is evidence the *code path* works, not a guarantee production eBay will behave identically once real credentials land.
- **8 platforms in one increment's test suite may not stay fast.** eBay's Sandbox integration tests are real network round-trips (skipped without credentials, but real when present); Amazon's mocked-HTTP tests and the 5 browser connectors' dry-run tests add ~13 new test files on top of the existing suite. If Sandbox credentials are ever added to CI, `npm test` picks up real external-network latency/flakiness it doesn't have today — worth watching once that happens, not a reason to skip building the tests now.
- **Playwright tracing/video is off by default in this increment — explicitly, not by omission.** The NFR only requires that *if* tracing/video capture is enabled for debugging, it must be dry-run-scoped or have credential-bearing requests excluded. This plan does not wire up `context.tracing.start()`/video recording at all for the 5 browser connectors — no trace or video artifact is produced, so there is nothing that could leak a credential through that channel. If a future increment adds tracing for debugging selector failures, it must scope it to dry-run sessions or add explicit credential-request exclusion at that time; this plan deliberately defers that rather than building it now with nothing yet to debug.
- **Poshmark's "share" action has no home in the 5-method interface.** FR34 requires tracking/capping share actions, but "share a listing" isn't one of `createListing`/`updateListing`/`markSold`/`delist`/`checkConnectionHealth`, and orchestration/scheduling that would actually trigger shares is explicitly out of scope. This plan adds `sharePoshmarkListing(tenantId, connectionId, itemId)` as a Poshmark-only extra method — gated by its own explicit call to `assertCanAutomate(tenantId, connectionId)` inside `poshmark.ts` itself (since it falls outside the generic 5-method `Connector` interface, `buildConnector()`'s HOF never wraps it, so `poshmark.ts` must call the gate directly or the method would be silently ungated), tested directly per AC10 — that nothing in this increment calls — same "wired but unused by any caller yet" posture as the rest of the tier. A future orchestration increment is the natural caller.
