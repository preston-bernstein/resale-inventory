# Requirements: Multi-Tenant Foundation for Reseller/Cross-Listing Integration

## Problem statement

`resale-inventory` (formerly `book-seller`) is currently a single-user, local-first app with zero authentication — anyone who can reach the bound network interface can view and mutate all inventory data, and there is no concept of a `user_id` or tenant anywhere in the schema. The planned cross-listing initiative will add automation that logs into third-party marketplace accounts (via official APIs and, later, browser automation) on a seller's behalf. That automation cannot be built safely on top of a schema with no tenant boundary: credentials for different sellers' marketplace accounts must never mix, no automation may touch a marketplace account until its owner has knowingly accepted the risk that automating that account can get it suspended or banned, and if a marketplace revokes access mid-flight the system must stop acting on that seller's behalf immediately, not eventually. This increment builds that foundation — tenant identity, credential isolation, consent capture, and an automatic kill-switch — before any connector code (eBay API client, Poshmark browser bot, etc.) is written against it.

## Users / stakeholders

- **Tenant (seller)**: an individual using the app to track and, in later increments, automate resale listings across one or more marketplace accounts they own. Each tenant is isolated from every other tenant's data, credentials, and consent records.
- **Operator/owner**: the person(s) running the app instance (today: the single existing user, Preston). Under multi-tenancy, the operator may also be a tenant, or may administer tenants without being one — this spec does not assume which.
- **System/kill-switch process**: the automated component (existing app code or a new background process, per architecture decision made during implementation) that observes suspension signals and acts on them without human involvement.
- **Future connector code** (out of scope for this increment, but a direct consumer of everything this increment builds): the eBay/Etsy/Amazon SP-API tier and the Poshmark/Depop/Mercari/Vinted/Grailed browser-automation tier. Every table and access path this increment defines is load-bearing for that later code.

## Functional requirements

### Tenant identity

1. The system shall provide a `tenants` entity with a stable, unique, non-reusable identifier (UUIDv4, consistent with the existing `items.id` convention) that all tenant-scoped data references by foreign key.
2. The system shall require every authenticated request to resolve to exactly one tenant identity before any tenant-scoped data (items, credentials, consent records, connections) is read or written.
3. The system shall reject any request for tenant-scoped data that cannot resolve to a tenant identity, returning 401 Unauthorized.
4. The system shall reject any request where the resolved tenant identity does not match the tenant that owns the requested resource, returning 404 Not Found (not 403 — do not confirm the resource's existence to a non-owning tenant).
5. The system shall support creating a new tenant record with, at minimum: unique login identifier (e.g. email), credential for authenticating as that tenant, and creation timestamp.
6. The system shall associate every existing `items` row (and its satellites: `book_details`, `clothing_details`, `item_platforms`, `item_photos`, `price_history`) with a tenant via a `tenant_id` foreign key, added additively to the existing schema without restructuring existing tables.
7. The system shall provide a migration path that assigns all pre-existing (pre-multi-tenant) inventory rows to a single default tenant, so the current single-user dataset is not orphaned or lost when multi-tenancy is introduced.

### Per-tenant credential isolation

8. The system shall store marketplace-connection credentials (tokens, API keys, session state — exact shape deferred to the connector-tier specs) in a table keyed by both `tenant_id` and `platform`, such that no query path can return one tenant's credential row when scoped to another tenant's identity.
9. The system shall enforce credential isolation at the data-access layer (every credential read/write function requires an explicit `tenant_id` parameter and includes it in the `WHERE` clause) in addition to any database-level constraint — isolation must not depend solely on application code remembering to filter.
10. The system shall never expose a stored credential value (token, secret, session cookie) in any API response body, log line, or error message — only non-secret metadata (platform name, connection status, created/updated timestamps, last-verified timestamp) shall be readable via the API.
11. The system shall reject any credential write request whose resolved tenant identity does not match the `tenant_id` the request is attempting to write under.
12. The system shall store credential secret material at rest using reversible encryption (e.g. encrypted with a per-tenant or application-level key, consistent with a "sacred DB" file that is otherwise readable via the existing read-only `sqlite3` inspection convention), such that the application can retrieve a usable plaintext credential when needed — one-way hashing is explicitly disallowed for this data, since future connector code must authenticate against marketplace platforms using the actual credential, not a hash of it. Exact encryption mechanism is an implementation decision, not specified here, but plaintext storage of secrets is explicitly disallowed.

### Per-tenant consent capture

13. The system shall define a versioned ToS/ban-risk disclosure document (a version identifier plus disclosure text/content) whose content the system shall store in its own database, that a tenant must be shown before connecting any marketplace account to automation.

*Clarification: the disclosure document itself is not tenant-scoped — it is a single global document with one current version shared by all tenants. Only consent records (which tenant consented, when, and to which disclosure version) are tenant-scoped, per tenant+platform connection.*

14. The system shall require an explicit, recorded consent action (not a pre-checked or default-accepted state) from a tenant before any automation runs against a specific tenant+platform connection.
15. The system shall record, for each consent action: which tenant consented, which disclosure version they consented to, and the timestamp of consent.
16. The system shall re-require consent whenever the disclosure document version changes — a tenant's prior consent to an older version shall not authorize automation under a newer version.
17. The system shall re-require consent whenever a tenant establishes a new platform connection, even if that tenant has already consented for a different platform — consent is scoped per tenant+platform connection, not tenant-global.
18. The system shall provide a way to query, for a given tenant+platform connection, whether current, valid consent (matching the current disclosure version) exists.
19. The system shall block any code path that would initiate automation for a tenant+platform connection lacking current valid consent, returning an error that identifies consent as the blocking condition (not a generic 403).
20. The system shall allow a tenant to revoke previously given consent for a specific platform connection, which shall immediately invalidate that connection for automation purposes (equivalent in effect to lacking consent).

### Automatic kill-switch

21. The system shall define a `connection_status` state on each tenant+platform connection with at minimum: active, suspended, and revoked states.
22. The system shall provide a callable, function-level entry point that connector code invokes to report a suspension/ban signal for a given tenant+platform connection (e.g. a `reportSuspensionSignal(tenantId, platform, reason)`-shaped function) — the exact signal source that causes connector code to call it (webhook, polled API response, HTTP error code from a connector call) is deferred to the connector-tier specs, but this increment requires that a concrete, callable function-level contract exists for receiving the signal, not merely an abstract "mechanism."
23. The system shall, upon receiving a suspension/ban signal for a tenant+platform connection, transition that connection's `connection_status` to suspended (or revoked, if the signal indicates permanent loss of access) within the same transaction or synchronous call path that processes the signal — not via a delayed or best-effort background job as the sole mechanism.
24. The system shall block all further automation for a tenant+platform connection immediately upon its `connection_status` leaving the active state, with no code path that can initiate automation against a non-active connection.
25. The system shall enforce the connection-status check at the point automation is about to act (not only at connection-setup time), so that a suspension detected mid-session halts subsequent actions on that connection.
26. The system shall persist, for each kill-switch activation, a durable and queryable record — not a log file — of: the tenant+platform connection affected, the detected signal or reason, and the timestamp of suspension; these records shall be retrievable via a query or API without requiring an operator to inspect raw logs.
27. The system shall make a suspended or revoked connection's status visible to the owning tenant (e.g. via an API/UI surface) without requiring the tenant to inspect logs or the database directly.
28. The system shall require an explicit, separate re-activation action (not automatic) to move a connection from suspended back to active — the kill-switch must fail closed, never auto-heal.

### Authentication UI

29. The system shall provide a minimal functional (not necessarily visually designed) signup/login page reachable in the browser, so that a tenant — including the migrated default tenant, once claimed — can authenticate through the app's UI, not only via direct API calls.

## Non-functional requirements

- Credential secret values must never appear in application logs, error responses, or stack traces at any log level.
- Kill-switch suspension (requirement 23) must complete synchronously with signal receipt — no queuing or polling delay is acceptable as the only enforcement path, since a delayed suspension is the exact failure mode this requirement exists to prevent.
- All new tenant/credential/consent/connection tables must be added via additive migrations (new `CREATE TABLE IF NOT EXISTS` files, following the existing `data/migrations/NNN_description.sql` + `PRAGMA user_version` gating convention) — no destructive rewrite of `items` or its existing satellite tables.
- New tables must use UUIDv4 primary keys with the same `CHECK (length(id) = 36 AND substr(id, 15, 1) = '4')` validation pattern already used in `data/migrations/004_phone_pairing_tokens.sql`.
- New enum-like columns (`connection_status`, disclosure/consent state, etc.) must use inline SQLite `CHECK` constraints consistent with existing convention — acknowledge in the implementation plan that extending these later requires the existing create-new-table/copy/drop/rename protocol (no `ALTER ... CHECK` in SQLite).
- Tenant-scoping must not introduce floating-point or new money-representation logic; existing integer-cents convention on `items` is unaffected by this increment.
- This increment introduces the app's first real authentication; it must integrate with (not bypass) the existing CSRF middleware (`middleware.ts`, Origin-header check on `/api/:path*` for mutating methods), which is orthogonal to and must remain active alongside tenant auth.
- Tenant signup passwords must meet a minimum strength bar — at minimum, a minimum length requirement.
- Authentication endpoints (signup, login) must apply basic rate limiting / failed-attempt throttling per IP or per email, to prevent brute-force credential guessing and to prevent CPU-exhaustion abuse (the planned password-hashing scheme is deliberately CPU/memory-expensive by design, making an unthrottled endpoint a self-inflicted DoS vector).
- The session cookie must be set with secure defaults (at minimum `httpOnly`) appropriate to the deployment context, and this must be verified by an automated test asserting the cookie's flags — not left as a fully-deferred implementation detail with no test coverage.
- Password-hashing cost parameters must meet OWASP baseline minimums for the chosen KDF (e.g. if scrypt: N≥16384, r=8, p≥1), verifiable via a code-level test asserting the constants used meet this floor.

## Constraints

- Must build on the existing satellite-table pattern (`docs/reseller-architecture-research.md`, `data/migrations/003_multi_category.sql`) — new tenant/credential/consent/kill-switch tables are additive satellites, not a restructuring of `items`, `book_details`, `clothing_details`, or `item_platforms`.
- Must follow the existing migration file convention: numbered files under `data/migrations/`, applied in order and gated by `PRAGMA user_version` in `lib/db.ts` (see `VERSIONED_MIGRATIONS` array).
- Must preserve all existing invariants documented in `.claude/skills/resale-inventory-architecture-contract/SKILL.md`: integer-cents money, UUIDv4 PKs, inline CHECK constraints, the `status` state machine centralized in `lib/transitions.ts`, `category` immutability, and the "sacred DB" rules (never delete/recreate `data/inventory.db`, WAL-aware backup only, owner-only restore).
- Must not break the existing scratch-DB test isolation (`BOOKSELLER_DB_PATH` env var honored by `vitest.config.ts`/`playwright.config.ts`) — new tables and auth logic must be exercised against scratch DBs the same way existing code is.
- Must not assume or introduce a specific third-party auth provider, identity service, or secrets-management product — this app currently has zero external service dependencies and the existing README frames that as a feature ("no external services required to run it"); if an external dependency becomes unavoidable for secure credential storage, flag it as a decision for the implementation plan, not assume it here.
- Must not design the eBay/Etsy/Amazon SP-API connector or the Poshmark/Depop/Mercari/Vinted/Grailed Playwright-based connector — those are explicitly later increments that will consume this foundation's tables and access patterns.
- The app is local-first, single-machine, SQLite-backed via a synchronous `better-sqlite3` connection (`lib/db.ts`) — multi-tenancy here means logical tenant isolation within one database file, not multi-database or multi-instance deployment.

## Out of scope

- Any actual marketplace API client (eBay, Etsy, Amazon SP-API) or browser-automation bot (Poshmark, Depop, Mercari, Vinted, Grailed).
- Playwright browser-context isolation, proxy configuration, or any browser-automation infrastructure.
- The specific mechanism by which a platform's suspension signal is produced (webhook payload shape, polling schedule, specific HTTP error codes) — this spec defines only the system's obligation to react once a signal arrives, not how any specific platform's signal is captured.
- Visual design/polish for the consent-disclosure screen, tenant signup/login flows, or connection-management dashboard (functional behavior is specified, including a minimal functional signup/login page per requirement 29; visual design and UX polish are not) — this does not mean no page exists: a bare functional signup/login page is required for the app to remain usable post-deploy.
- Billing, subscription tiers, or any monetization of multi-tenancy.
- Password-reset flows, multi-factor authentication, session management mechanics, or other general-purpose auth features beyond "resolve a request to exactly one tenant identity" (requirement 2) — treat baseline auth mechanics as an implementation detail of satisfying that requirement, not a separately specified feature set here.
- Data export/deletion tooling for tenant offboarding (GDPR-style "delete my data") — not requested in the source feature description.
- Rate limiting, abuse prevention, or multi-tenant resource-quota enforcement beyond what's needed for credential/consent/kill-switch correctness.
- Migrating or re-platforming the existing single-file SQLite architecture to a multi-database or cloud-hosted database — tenancy is logical, not physical, per the Constraints section.
- The pre-existing, global (non-tenant-scoped) UNIQUE constraint on the book-inventory ISBN field is not fixed by this increment — a duplicate-ISBN check will still leak a weak cross-tenant signal (one tenant can learn "this ISBN exists somewhere," via a 409 vs. 201 response) to other tenants after this increment ships. Fixing it requires a table-rebuild migration disproportionate to this increment's additive-only scope; it is explicitly deferred to a follow-on increment.

## Acceptance criteria

1. A request to any tenant-scoped API route with no resolvable tenant identity returns 401.
2. A request to a tenant-scoped resource owned by a different tenant returns 404, not the resource's data and not 403.
3. Querying credentials for tenant A, when authenticated as tenant B, returns zero rows — verified by a test that seeds credentials for two tenants and asserts cross-tenant reads return empty.
4. No API response, log line, or error message emitted during normal operation or error handling contains a raw credential/token/secret value — verified by a test that triggers credential read/write/error paths and asserts the response/log body does not contain the seeded secret string.
5. Reading the raw SQLite file's credential table directly (bypassing the app) does not yield a plaintext secret value — verified by an automated test that inserts a credential, reads the raw stored value directly from the database (bypassing the app layer), and asserts it does not equal the plaintext secret.
6. Attempting to initiate automation for a tenant+platform connection with no consent record returns an error identifying the missing-consent condition, and no automation action is attempted.
7. Attempting to initiate automation for a tenant+platform connection whose recorded consent references an older disclosure version than the current one returns the same missing-consent error as (6).
8. Recording consent for tenant A's connection to platform X does not satisfy the consent check for tenant A's connection to platform Y, nor for tenant B's connection to platform X — verified by a test asserting per-tenant-per-platform consent scoping.
9. Revoking consent for an active tenant+platform connection immediately causes the next automation-eligibility check for that connection to fail, without requiring any other state change.
10. Simulating a suspension signal for a tenant+platform connection transitions that connection's status out of active within the same call/transaction that processes the signal, verified by asserting the new status is readable immediately after the signal-processing call returns (no polling wait required in the test).
11. After a connection's status leaves active, any subsequent attempt to initiate or continue automation on that connection is blocked, verified by a test that suspends a connection mid-simulated-session and asserts the next action attempt is rejected.
12. A suspended connection does not automatically return to active state absent an explicit reactivation action — verified by a test that asserts status remains suspended across a time delay or process restart with no reactivation call made.
13. All new tables are created via `CREATE TABLE IF NOT EXISTS` migrations under `data/migrations/`, gated by an incremented `PRAGMA user_version`, and running the full existing test suite (`npm test`) against a fresh scratch DB triggers them with no errors.
14. Running the existing test suite (`npm test`, `npm run test:e2e`) after this increment lands still passes against the pre-existing (single-tenant-equivalent) inventory flows, with all pre-existing inventory rows attributed to the default migrated tenant.
15. The existing CSRF middleware (`middleware.ts`) continues to reject cross-origin mutating requests after tenant auth is added, verified by a test that sends a mismatched-Origin mutating request and asserts 403 regardless of tenant-auth state.
