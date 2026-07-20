# Requirements: Electronics Category + Swappa Connector

## Problem statement

`resale-inventory` today supports exactly two categories — book and clothing — each with its own satellite detail table (`book_details`, `clothing_details`), condition vocabulary, and a shared marketplace-connector interface wired to eight platforms (eBay, Etsy, Amazon, Poshmark, Depop, Mercari, Vinted, Grailed). The operator now also resells electronics, starting with laptops, which need attributes that don't exist on either satellite table and aren't expressible in the current schema: hardware specs, a device-condition grade distinct from the book/clothing vocabularies, and battery health/cycle count. Without this feature there is no structured record for an electronics item at all — `items.category` is a two-value CHECK constraint and `ListingInput.category`/`Item` are hardcoded `'book' | 'clothing'` unions, so an electronics row cannot be created or passed through the connector layer today. Separately, none of the eight existing connectors target Swappa, a marketplace the operator has identified as the strongest channel specifically for laptops; that gap needs a ninth connector. This increment adds the electronics category (laptops only, per the `multi-category-inventory` precedent that a new category is additive except for one bounded `items.category` CHECK rebuild) and wires it through five of the eight existing connectors plus one new Swappa connector.

## Users / stakeholders

- **Operator/seller (Preston)**: adds electronics inventory, lists it across supported platforms, and needs battery health/cycle count and condition grade visible wherever book/clothing condition is visible today (grid, detail page, CSV).
- **Existing `items`/satellite-table schema**: the system this feature extends — must preserve every existing book/clothing row, status, price-history entry, and platform listing unchanged through the migration that widens `items.category`.
- **Connector layer (`lib/connectors/*`, `lib/connections.ts` kill-switch, consent/credential system)**: the shared interface, registry, and gating (`hasValidConsent`, `getDecryptedCredential`, `recordSuspensionSignal`, scrub utility) that every connector — including the new Swappa one — must integrate with identically to the existing eight.
- **Mercari, Poshmark, Amazon, eBay, Grailed connector code**: the five specific connectors this feature extends to handle `category: 'electronics'` items, per the feature description's explicit list.
- **Etsy, Depop, Vinted connector code**: explicitly not extended in this increment (see Out of scope) — continue to support only book/clothing.
- **Future Swappa tenant accounts**: the credential/session holders the new connector authenticates as, subject to the same per-tenant credential isolation as the other seven browser/API connectors.

## Functional requirements

### Data model

1. The system shall add `'electronics'` as a third value to the `Category` union (`lib/constants.ts`) and to the `items.category` CHECK constraint, via the same bounded table-rebuild migration protocol used for the two-category CHECK today (SQLite cannot ALTER a CHECK constraint), preserving every existing `items` row's data, id, status, and foreign-key relationships unchanged.
2. The system shall add an `electronics_details` satellite table (following the `book_details`/`clothing_details` pattern: `item_id` FK to `items.id`, category-specific columns, category-specific CHECK constraints), added additively via `CREATE TABLE IF NOT EXISTS` under `data/migrations/`, gated by an incremented `PRAGMA user_version` — this table's addition shall require no change to `items`, `book_details`, or `clothing_details`.
3. The `electronics_details` table shall store, at minimum: `device_type` (fixed to `'laptop'` for this increment — see Out of scope), `brand`, `model`, spec fields sufficient to describe a laptop (e.g. processor, RAM, storage capacity, screen size — exact column list and types to be finalized against the UI form, not invented here), `battery_health_pct` (nullable integer, 0–100 inclusive, enforced by CHECK), `battery_cycle_count` (nullable non-negative integer, enforced by CHECK), and `condition` (see FR4).
4. The system shall define an `ElectronicsCondition` vocabulary (`lib/constants.ts`, alongside `BOOK_CONDITIONS`/`CLOTHING_CONDITIONS`) distinct from the book and clothing vocabularies, enforced via CHECK constraint on `electronics_details.condition` — exact grade labels are `[condition vocabulary TBD — not specified in provided context; e.g. a small fixed set of grading labels used for refurbished/used electronics]`.
5. The system shall extend `conditionsForCategory(category)` (`lib/constants.ts`) to return `ELECTRONICS_CONDITIONS` for `category === 'electronics'`, preserving its existing exhaustive-switch shape (compile error if a category is left unhandled).
6. The system shall add an `ElectronicsDetails` TypeScript interface (`lib/types.ts`) mirroring `BookDetails`/`ClothingDetails`'s shape, and extend the `Item` discriminated union with `(ItemBase & { category: 'electronics'; details: ElectronicsDetails })`.
7. `battery_health_pct` and `battery_cycle_count` shall both be nullable — not every laptop's battery health/cycle count is knowable or reportable at intake — and the UI/API shall accept an electronics item with either or both fields absent.

### Application surface (mirrors existing book/clothing UX, no new pattern)

8. The system shall add `electronics` as a selectable category in the category picker on `/inventory/new`, rendering an electronics-specific sub-form (specs, battery health, cycle count, condition grade) in place of the book/clothing sub-forms, when selected.
9. The system shall render `electronics_details` on the item detail page (`/inventory/[id]`) using the same layout convention as `book_details`/`clothing_details` rendering (labeled rows), and shall extend the item's existing category badge/placeholder styling — including the condition-tinted placeholder used in the inventory grid for items without photos — to electronics items, matching the pattern already used for book/clothing. No new condition-specific detail-page badge mechanic is introduced by this requirement.
10. The system shall include `electronics_details` columns in CSV export, with book/clothing columns left blank on electronics rows and vice versa, consistent with the existing multi-category CSV convention (FR21 of `docs/multi-category-inventory/requirements.md`).
11. The system shall accept CSV import rows with `category=electronics`, applying electronics-appropriate required-field validation, and shall report per-row errors without aborting the batch — consistent with existing book/clothing import behavior.
12. The system shall include electronics in the dashboard's combined totals and per-category breakdown (`/api/dashboard`) without altering the existing book/clothing breakdown values.
13. The system shall preserve `PATCH /api/items/[id]`'s existing allowlist-and-terminal-status-exclusion behavior for electronics items. The PATCH allowlist for electronics items shall include all `electronics_details` fields — `brand`, `model`, `processor`, `ram_gb`, `storage_gb`, `screen_size_in`, `condition`, `battery_health_pct`, and `battery_cycle_count` — as patchable while the item is not in a terminal status, scoped the same way book/clothing fields are scoped today. This is not limited to condition/battery fields: spec and identification typos (brand, model, and other spec fields) are a realistic correction need for this category.

### Connector-layer type widening

14. The system shall widen `ListingInput.category` (`lib/connectors/types.ts`) from `'book' | 'clothing'` to `'book' | 'clothing' | 'electronics'`, and widen `ListingInput.details` to `BookDetails | ClothingDetails | ElectronicsDetails`, without changing the existing `Connector` interface's method signatures.
15. Any connector not extended for electronics in this increment (Etsy, Depop, Vinted — see FR16–17 and Out of scope) shall, when passed a `ListingInput` with `category: 'electronics'`, throw a typed `UnsupportedCategoryError` (or equivalent) rather than silently mishandling or ignoring the electronics-specific fields — this is a compile-time-or-guarded-runtime rejection, not a documentation-only restriction.

### Wiring electronics through the five named connectors (Mercari, Poshmark, Amazon, eBay, Grailed)

16. The system shall extend the Mercari, Poshmark, Amazon, eBay, and Grailed connectors' `createListing`/`updateListing` implementations to accept `ListingInput` items with `category: 'electronics'`, mapping `ElectronicsDetails` fields (specs, condition grade, battery health/cycle count) into each platform's existing listing-content construction path (`lib/connectors/listingContent.ts` or platform-specific equivalent) the same way `BookDetails`/`ClothingDetails` are mapped today.
17. The system shall leave each of these five connectors' existing gating (consent/status/credential checks, requirements 7–15 of `docs/marketplace-connector-tier/requirements.md`), pacing, and suspension-signal logic completely unchanged by this extension — the only new code path is category-specific listing-content mapping, not a parallel gating or pacing implementation.
18. The system shall have test coverage, for each of the five named connectors, exercising `createListing` with a representative electronics/laptop `ListingInput` and asserting the resulting listing-content payload includes the electronics-specific fields (specs, condition grade, battery health/cycle count where present).

### New Swappa connector

19. The system shall add `'swappa'` to `SUPPORTED_PLATFORMS` (`lib/constants.ts`) and implement a `swappaConnector` (`lib/connectors/swappa.ts`) satisfying the same `Connector` interface (`createListing`, `updateListing`, `markSold`, `delist`, `checkConnectionHealth`) as the existing eight connectors, registered in `lib/connectors/registry.ts` via `buildConnector('swappa', swappaConnector)` so `getConnector('swappa')` returns a fully gated instance.
20. `[Connector tier TBD]` — no evidence in provided project context establishes whether Swappa exposes an official public listing API; absent that evidence, the Swappa connector shall follow the browser-automation tier's conventions (Playwright-driven, dry-run-until-credentialed per the existing `credential_status: 'placeholder'` sentinel convention, persisted-session reuse, conservative action pacing) consistent with Poshmark/Mercari/Grailed rather than the official-API tier — this decision shall be revisited if an official Swappa API is confirmed during implementation.
21. The Swappa connector shall pass through the same gating requirements applied to all eight existing connectors: pre-call `hasValidConsent`/active-status checks on every method except `checkConnectionHealth` (re-checked per invocation, not cached), credential retrieval exclusively via `getDecryptedCredential`, error/log/suspension-reason scrubbing via the shared `scrub.ts` utility, and `recordSuspensionSignal` called synchronously on any positively-classified suspension/ban response.
22. The Swappa connector's `createListing` shall reject (typed error, e.g. `UnsupportedCategoryError`, not a silent no-op) any `ListingInput` whose `category` is not `'electronics'`, since Swappa's listing flow is built around device-spec fields that book/clothing details do not carry.
23. The system shall, on a successful Swappa `createListing`, write the returned external listing identifier to `item_platforms` via the existing write path (`itemPlatformsWrite.ts`), following the existing `UNIQUE(item_id, platform)` constraint — no parallel listing-tracking table.
24. The system shall apply the same browser-automation-tier constraints already codified for Depop/Mercari/Vinted/Grailed (no automatic retry beyond one attempt per method call, session reuse over repeated logins, fresh-login-only-when-needed, value-based Playwright locators rather than interpolated selector strings, per-tenant+connection-scoped browser context) to the Swappa connector, with its own named pacing constant in `lib/constants.ts` (`SWAPPA_ACTION_RATE_LIMIT_MS`) set to `10000` (10 seconds), matching the existing `DEPOP_ACTION_RATE_LIMIT_MS`/`MERCARI_ACTION_RATE_LIMIT_MS`/`VINTED_ACTION_RATE_LIMIT_MS`/`GRAILED_ACTION_RATE_LIMIT_MS` convention (all currently 10 seconds), in the absence of a published Swappa rate-limit policy.
25. The system shall have unit tests for the Swappa connector's gating, dry-run behavior, and category-rejection logic (FR22) that run with no live Swappa account and never launch a real Playwright browser instance, consistent with the existing browser-automation test convention.

### Item-platform selection surface

26. The system shall restrict which platforms are offered/selectable for an item in the platform-connection UI based on category: electronics items shall only offer the six platforms wired for electronics (Mercari, Poshmark, Amazon, eBay, Grailed, Swappa); book/clothing items shall continue to offer the existing eight-platform set unchanged, minus Swappa (Swappa is electronics-only per FR22).

## Non-functional requirements

- All new tables (`electronics_details`, any Swappa-specific pacing/session-tracking table) must be added via additive `CREATE TABLE IF NOT EXISTS` migrations under `data/migrations/`, gated by an incremented `PRAGMA user_version`, consistent with existing migration history.
- No credential (session cookie, token) may appear in plaintext in a log line, thrown error, or Playwright trace/video artifact from the Swappa connector — identical to the existing scrubbing requirement applied to all eight connectors.
- Automated tests (`npm test`) must never launch a real Playwright browser instance for the Swappa connector — dry-run mode and/or module-level mocking of the `playwright` import must guarantee this deterministically.
- The `items.category` CHECK-widening migration must run inside a single transaction and must not lose or alter any existing book/clothing row — this is a data-integrity constraint, not a performance target.
- An item's `category` shall remain immutable after creation: once an `items` row is inserted with a given `category` (book, clothing, or electronics), no subsequent update may change that row's `category` value. This is a data-integrity guarantee, consistent with existing system behavior — the trigger enforcing this already exists in the current schema for book/clothing and must continue to hold, unmodified, once electronics is added.
- No new numeric performance threshold (latency, throughput) is introduced by this feature beyond what already applies to the connector tier it extends (see `docs/marketplace-connector-tier/requirements.md`'s NFRs) — none is specified in project context to add here.

## Constraints

- Must integrate with the existing base+satellite schema pattern (`items` + per-category detail tables) established in `docs/multi-category-inventory/` — no EAV or nullable-shared-column alternative.
- Must integrate with the existing shared `Connector` interface, registry (`lib/connectors/registry.ts`), and gating wrapper (`lib/connectors/gate.ts`) — no parallel connector abstraction for Swappa or for electronics-specific listing logic.
- Must integrate with the existing multi-tenant consent/credential/kill-switch system (`hasValidConsent`, `getDecryptedCredential`, `rotateCredential`, `recordSuspensionSignal`) — per-tenant marketplace credentials remain stored via the existing encrypted credential table, never environment variables, for Swappa as for the other seven browser/API connectors.
- Must integrate with the existing `item_platforms` table and its `UNIQUE(item_id, platform)` convention — no new listing-tracking table.
- SQLite cannot ALTER a CHECK constraint: widening `items.category` requires the same create-new-table/copy/drop/rename rebuild protocol already used in `data/migrations/003_multi_category.sql`, following `resale-inventory-change-control` §4.
- `playwright` is already a production dependency (browser-automation connectors); the Swappa connector reuses it rather than introducing a second browser-automation library.
- Condition vocabularies remain per-category, independent CHECK-enforced enums (`BOOK_CONDITIONS`, `CLOTHING_CONDITIONS`, and the new `ELECTRONICS_CONDITIONS`) — no shared cross-category condition scale.
- Deploy/data-canonical constraint (per repo `CLAUDE.md`): schema/migration changes must be verified against the desktop deployment's `data/inventory.db`, not the Mac checkout's disposable clone.

## Out of scope

- Any electronics device type other than laptops (phones, tablets, cameras, desktops, monitors, accessories) — `device_type` is fixed to `'laptop'` this increment; a second device type is a future increment's schema/UI work, not built here.
- Real electronics support in the Etsy, Depop, or Vinted connectors — i.e., mapping `ElectronicsDetails` fields into an actual, functioning Etsy/Depop/Vinted listing. Those three connectors continue to support only book/clothing listings after this feature ships; extending them to actually list electronics is a future increment. This out-of-scope item does NOT exempt these three files from this increment's work: per FR15, all three connectors must still be edited to add the typed `UnsupportedCategoryError` rejection guard for `category: 'electronics'` — that guard is required, in-scope work.
- A Swappa-specific extra action analogous to Poshmark's `sharePoshmarkListing` (no evidence in context that Swappa has an equivalent share/promote mechanic) — not built unless a future increment identifies one.
- Automated verification of manufacturer specs, serial number, or warranty status against any external database — the system stores what the seller enters; it does not validate or look up device authenticity.
- Any battery-health measurement or diagnostic tooling — the system stores a `battery_health_pct`/`battery_cycle_count` value the seller supplies; it does not read these from the device.
- Shipping-cost estimation or label purchase for electronics items.
- A generic N-category plugin/framework system — only the one new category (electronics) is built, structured so a further category remains additive per the existing precedent.
- Live Swappa credential provisioning or account setup — this feature wires the connector to be dry-run/inert until a real credential is supplied, consistent with the existing dry-run-until-credentialed posture of the other browser-automation connectors.

## Acceptance criteria

1. An electronics item (laptop) can be created via `/inventory/new` and via the items API, with `electronics_details` fields (specs, condition grade, battery health, cycle count) persisted and retrievable via `GET /api/items/[id]`.
2. Creating an electronics item with `battery_health_pct` or `battery_cycle_count` omitted succeeds (both fields are nullable).
3. Creating an electronics item with `battery_health_pct` outside 0–100 or `battery_cycle_count` negative is rejected by the database CHECK constraint (and, ideally, by API-level validation before reaching the DB).
4. Every pre-existing book and clothing row's data, status, price history, and platform listings are byte-identical before and after the `items.category` CHECK-widening migration runs.
5. `conditionsForCategory('electronics')` returns the new `ELECTRONICS_CONDITIONS` vocabulary; `conditionsForCategory('book')` and `conditionsForCategory('clothing')` are unchanged.
6. CSV export of a mixed-category inventory (book + clothing + electronics rows) produces one file where each row's off-category columns are blank; CSV import of that same file round-trips without data loss.
7. `getConnector('swappa')` returns a `Connector`-shaped object wrapped by the same gating layer (`buildConnector`) as the other eight platforms.
8. Calling any of Mercari/Poshmark/Amazon/eBay/Grailed's `createListing` with an electronics `ListingInput` succeeds and produces listing content containing the item's specs, condition grade, and battery health/cycle count (where present).
9. Calling Etsy, Depop, or Vinted's `createListing` with an electronics `ListingInput` throws a typed `UnsupportedCategoryError` rather than creating a malformed or partial listing.
10. Calling Swappa's `createListing` with a book or clothing `ListingInput` throws a typed `UnsupportedCategoryError`.
11. Calling any Swappa connector method without a valid consent record, or with a non-`active` connection status, throws/returns the same typed gating error as the existing eight connectors, with zero network/browser calls made.
12. With no real Swappa credential configured (or the `credential_status: 'placeholder'` sentinel set), Swappa connector calls run in dry-run mode: they construct and log the intended action without any real browser navigation.
13. `npm test` runs to completion without ever launching a real Playwright browser for the Swappa connector, regardless of local environment credential state.
14. No credential value appears in any thrown error message, log line, or `recordSuspensionSignal` `reason` string produced by the Swappa connector, verified by test coverage mirroring the existing `scrub.ts` test suite's assertions for the other seven connectors.
15. The platform-selection UI for an electronics item offers exactly Mercari, Poshmark, Amazon, eBay, Grailed, and Swappa; it does not offer Etsy, Depop, or Vinted for that item.
16. The platform-selection UI for a book or clothing item does not offer Swappa.
