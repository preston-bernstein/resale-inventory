# Plan: Electronics Category + Swappa Connector

## Approach

Electronics (laptops only) is added as a third base+satellite category, following the exact `multi-category-inventory` precedent: one bounded `items.category` CHECK-rebuild migration (create-copy-drop-rename, same protocol as `003_multi_category.sql`) plus a brand-new, purely additive `electronics_details` satellite table, a third condition vocabulary, and a third arm on every existing category switch (`conditionsForCategory`, category picker, detail-page rendering, CSV, dashboard). The connector layer only needs a type widening (`ListingInput.category`/`.details`) plus category-specific field-mapping added to five already-shipped connectors' existing listing-content builders — no new abstraction. Swappa is a ninth platform built with the same shared primitives as Poshmark/Mercari/Grailed (`playwrightSession.ts`'s `withSession`/`buildSessionHooks`, `pacing.ts`'s `enforcePacing`, `gate.ts`'s `buildConnector`), because it has no evidence of a public API and the browser-automation tier is what every credential-tier platform in this repo already uses. This keeps the increment additive everywhere except the one CHECK constraint the codebase's own change-control protocol already has a rehearsed answer for.

Two vocabulary/config decisions the requirements left as TBD are resolved here (architect's call, not left open):
- **`ELECTRONICS_CONDITIONS`** = `['New', 'Excellent', 'Good', 'Fair', 'For Parts']` — a 5-label grading scale, matching the existing 5-value shape of `BOOK_CONDITIONS`/`CLOTHING_CONDITIONS`, chosen because it maps cleanly onto how refurbished-laptop marketplaces (including Swappa) grade devices: sealed/unused, light-wear-fully-functional, functional-with-wear, functional-with-issues, and non-functional/parts-only.
- **`SWAPPA_ACTION_INTERVAL_MS`** = `10_000` — identical to `DEPOP_ACTION_RATE_LIMIT_MS`/`MERCARI_ACTION_RATE_LIMIT_MS`/`VINTED_ACTION_RATE_LIMIT_MS`/`GRAILED_ACTION_RATE_LIMIT_MS`, since Swappa has no published rate-limit policy either — same conservative default, not a documented threshold.

## Design decisions

A few decisions implicit in the requirements are made explicit here so implementers don't have to re-derive them:

- **Category immutability re-confirmed for a 3rd category.** `items_category_immutable` (originally written for the 2-category schema) carries forward unchanged rather than being revisited — once an item is created as book/clothing/electronics, its category can never change. A 3rd category means a 3rd way to mis-click at creation time, but the accepted fix remains "delete and recreate the row," not "allow a category edit," same as the existing two categories.
- **`electronics_details` gets both tenant-matching AND category-matching triggers as day-one invariants.** A row's `tenant_id` must match its parent `items.tenant_id` (same defense-in-depth pattern as `book_details`/`clothing_details`), and its parent `items.category` must be `'electronics'` (new — no existing satellite table enforces category-linkage today; this one is built with the invariant from day one instead of needing a later retrofit).
- **`device_type` is validated at the application layer only, not a DB CHECK.** The column defaults to `'laptop'` with no value constraint, mirroring `SUPPORTED_PLATFORMS`'s existing app-layer-allowlist tradeoff (see `lib/constants.ts`'s comment on that choice) — a future second device type (phone, tablet) then needs no `items_v2`-style table rebuild, only new UI/validation.
- **Brand is a `<select>` from a small hardcoded constant list, not free text.** Laptop brands are a small, closed, well-known set (Apple, Dell, HP, Lenovo, Asus, Acer, Microsoft, Samsung, ...) — a better fit for a closed vocabulary than clothing brands were — so plain text invites fragmentation ("HP"/"Hewlett-Packard"/"hp") in dashboard/CSV views; a hardcoded `LAPTOP_BRANDS` list in `lib/constants.ts` avoids that without a new migration/table.

## Architecture

```
                          ┌─────────────────────────────┐
 /inventory/new  ────────▶│ AddElectronicsForm (new)     │
 (category picker + 3rd   │  - brand/model/specs         │──▶ POST /api/items
  tab: Book/Clothing/     │  - battery health/cycles     │     (category='electronics')
  Electronics)            │  - ConditionSelect(ELEC_COND)│
                          └─────────────────────────────┘
                                       │
                                       ▼
                     items (category CHECK widened to
                     'book'|'clothing'|'electronics')
                                       │
                                       ▼
                     electronics_details (new satellite,
                     1:1 via item_id FK, own condition CHECK)
                                       │
                     ┌─────────────────┴──────────────────┐
                     ▼                                     ▼
        /inventory/[id] detail page              GET/PATCH /api/items/[id]
        (3rd DetailRows branch,                   (3rd fetchDetails/
         category badge + emoji)                   applyDetailUpdates branch)
                     │
                     ▼
        Item-platform picker (per-category filtered
        via new platformsForCategory()) ──▶ item_platforms
                     │
                     ▼
        lib/connectors/registry.ts#getConnector(platform)
                     │
        ┌────────────┼──────────────────────────────────────────┐
        ▼            ▼              ▼            ▼          ▼   ▼
     mercari.ts  poshmark.ts    amazon.ts     ebay.ts   grailed.ts  swappa.ts (new)
     (electronics (electronics   (electronics  (electronics (electronics  (electronics-
      branch      branch         branch        branch       branch        ONLY; rejects
      added)      added)         added)        added)       added)        book/clothing)
        │            │              │            │          │             │
        └────────────┴──────────────┴────────────┴──────────┴─────────────┘
                                       │
                            gate.ts#buildConnector (unchanged) →
                            assertCanAutomate → raw.createListing →
                            itemPlatformsWrite.ts#recordListingCreated

     etsy.ts / depop.ts / vinted.ts: unchanged except a top-of-createListing
     guard that throws UnsupportedCategoryError for category:'electronics'.
```

`lib/dashboard.ts` and `app/api/export|import/route.ts` sit off to the side of this diagram, each gaining a third parallel code path (electronics alongside book/clothing) rather than a shared abstraction — matching how those files already treat book/clothing as two hand-written branches, not a loop over `CATEGORIES`.

## Data model

One new migration, `data/migrations/014_electronics_category.sql`, gated by `PRAGMA user_version = 14`, containing two independent pieces inside the same transaction (the rebuild needs its own transaction scope per resale-inventory-change-control §4; the additive `electronics_details` table can safely ride in the same file since a single migration file is already one atomic `db.transaction()` per `lib/db.ts`'s runner):

**No `IF NOT EXISTS` anywhere in this migration, by convention, not oversight.** Migration 013 (the most recent one in this repo) relies on transaction atomicity alone — a failure mid-migration rolls the whole transaction back, so a retry re-runs cleanly from a `CREATE TABLE`/`CREATE TRIGGER`/`CREATE INDEX` that never partially applied. This migration follows that same convention uniformly (table, indexes, and triggers all omit `IF NOT EXISTS`) rather than mixing it in for some statements and not others.

**1. `items.category` CHECK rebuild** (SQLite cannot ALTER a CHECK; same create-copy-drop-rename protocol as `003_multi_category.sql`, but rebuilding the table as it exists *today* — after `005_tenants.sql`/`006_tenant_scoping.sql` added `tenant_id NOT NULL REFERENCES tenants(id)` via additive `ALTER TABLE ADD COLUMN` — not the 003-era shape):

```sql
PRAGMA defer_foreign_keys = ON;  -- scoped to this transaction only

CREATE TABLE items_v2 (
  id               TEXT    PRIMARY KEY
                   CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  category         TEXT    NOT NULL
                   CHECK (category IN ('book','clothing','electronics')),
  title            TEXT    NOT NULL,
  acquisition_cost INTEGER NOT NULL CHECK (acquisition_cost >= 0),
  acquisition_date TEXT    NOT NULL CHECK (acquisition_date LIKE '____-__-__'),
  status           TEXT    NOT NULL DEFAULT 'Unlisted'
                   CHECK (status IN ('Unlisted','Listed','Sale Pending','Sold',
                                     'Removed','Donated','Discarded')),
  listing_price    INTEGER CHECK (listing_price IS NULL OR listing_price >= 0),
  sale_price       INTEGER CHECK (sale_price IS NULL OR sale_price >= 0),
  sale_platform    TEXT,
  sale_date        TEXT    CHECK (sale_date IS NULL OR sale_date LIKE '____-__-__'),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')) CHECK (created_at LIKE '____-__-__%'),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')) CHECK (updated_at LIKE '____-__-__%'),
  tenant_id        TEXT    NOT NULL REFERENCES tenants(id),
  CHECK (status NOT IN ('Listed','Sale Pending') OR listing_price IS NOT NULL),
  CHECK (status != 'Sold' OR (sale_price IS NOT NULL AND sale_date IS NOT NULL AND sale_platform IS NOT NULL))
);
-- Column order: id, category, title, acquisition_cost, acquisition_date,
-- status, listing_price, sale_price, sale_platform, sale_date, created_at,
-- updated_at, tenant_id — tenant_id is LAST here (not second) because
-- 006_tenant_scoping.sql added it via ALTER TABLE ADD COLUMN, which SQLite
-- always appends; this ordering matches the live table's actual physical
-- column order rather than the earlier (003-era) sketch, so old→new column
-- positions line up and no reordering happens silently under a `SELECT *`.
--
-- New vs 003/006's shape: the `id` column now carries the UUID-format CHECK
-- (`length(id)=36 AND substr(id,15,1)='4'`) that every migration since
-- 007_platform_connections.sql (and 011, 013) has used but `items.id` itself
-- never got — this rebuild is the one chance to backfill it before the next
-- CHECK-immutable rebuild. Every other column/CHECK is copied verbatim from
-- the current `items` schema (001+003+006's cumulative shape); the only
-- other diff vs the live table is the widened category CHECK.
--
-- IMPORTANT: this column list is representative, not copy-paste-ready.
-- Whoever writes the real migration must verify this exact list (names,
-- order, and CHECKs) against `.schema items` on the live desktop DB before
-- finalizing — do not assume this sketch is final.

INSERT INTO items_v2 (
  id, category, title, acquisition_cost, acquisition_date, status,
  listing_price, sale_price, sale_platform, sale_date, created_at,
  updated_at, tenant_id
)
SELECT
  id, category, title, acquisition_cost, acquisition_date, status,
  listing_price, sale_price, sale_platform, sale_date, created_at,
  updated_at, tenant_id
FROM items;
-- EXPLICIT column list on BOTH sides, in this exact order. A bare
-- `SELECT * FROM items` here is POSITIONAL and dangerous: if items_v2's
-- physical column order doesn't match items' real current order exactly
-- (it doesn't, pre-fix — see above), every row's data silently scrambles
-- (e.g. category's value ends up in tenant_id) while a row-count-only test
-- still passes. Never use `SELECT *` in this INSERT.

DROP TABLE items;
ALTER TABLE items_v2 RENAME TO items;
-- Table is dropped and its replacement renamed back to the SAME name
-- ('items') within one transaction — unlike 003's books→books_archived
-- rename (a NAME CHANGE, which is what broke price_history's FK
-- retargeting there), every child table's `REFERENCES items(id)` already
-- says the literal string 'items', so this rebuild needs no FK retarget
-- fix: book_details/clothing_details/item_platforms/item_photos/
-- price_history's FKs keep pointing at 'items' before and after.

CREATE TRIGGER items_category_immutable
BEFORE UPDATE ON items WHEN NEW.category != OLD.category
BEGIN SELECT RAISE(FAIL, 'category is immutable'); END;

CREATE INDEX idx_items_category         ON items(category);
CREATE INDEX idx_items_status           ON items(status);
CREATE INDEX idx_items_category_status  ON items(category, status);
CREATE INDEX idx_items_title            ON items(title COLLATE NOCASE);
CREATE INDEX idx_items_created_at       ON items(created_at);
CREATE INDEX idx_items_sale_date        ON items(sale_date) WHERE sale_date IS NOT NULL;
CREATE INDEX idx_items_tenant           ON items(tenant_id);
CREATE INDEX idx_items_tenant_status    ON items(tenant_id, status);
CREATE INDEX idx_items_tenant_category  ON items(tenant_id, category);
-- idx_items_tenant_category is new: the dashboard's per-tenant
-- per-category breakdown query needs exactly this composite shape and
-- nothing existing covers it.
-- (every index + the immutability trigger that existed on the pre-rebuild
-- `items` table is dropped along with it and must be recreated here)
```

**2. `electronics_details`** (additive, no rebuild needed — this table doesn't exist yet. No `IF NOT EXISTS` here either, per the migration-wide convention noted above — relies on transaction atomicity, matching migration 013):

```sql
CREATE TABLE electronics_details (
  item_id             TEXT    PRIMARY KEY REFERENCES items(id),
  tenant_id           TEXT    NOT NULL REFERENCES tenants(id),
  -- device_type has NO value CHECK — validated at the app layer only,
  -- same tradeoff as SUPPORTED_PLATFORMS (see lib/constants.ts's existing
  -- comment on that choice). A future second device type (phone, tablet)
  -- needs zero migration for this column — only new UI/validation. See
  -- Design decisions.
  device_type         TEXT    NOT NULL DEFAULT 'laptop',
  brand               TEXT    NOT NULL,
  model               TEXT    NOT NULL,
  processor           TEXT,                            -- e.g. "Apple M2", "Intel i7-1260P"
  ram_gb              INTEGER CHECK (ram_gb IS NULL OR ram_gb > 0),
  storage_gb          INTEGER CHECK (storage_gb IS NULL OR storage_gb > 0),
  screen_size_in      REAL    CHECK (screen_size_in IS NULL OR screen_size_in > 0),
  battery_health_pct  INTEGER CHECK (battery_health_pct IS NULL
                                      OR (battery_health_pct BETWEEN 0 AND 100)),
  battery_cycle_count INTEGER CHECK (battery_cycle_count IS NULL OR battery_cycle_count >= 0),
  condition           TEXT    NOT NULL
                      CHECK (condition IN ('New','Excellent','Good','Fair','For Parts'))
);

CREATE INDEX idx_electronics_details_tenant    ON electronics_details(tenant_id);
CREATE INDEX idx_electronics_details_condition ON electronics_details(condition);
CREATE INDEX idx_electronics_details_brand     ON electronics_details(brand COLLATE NOCASE);
CREATE INDEX idx_electronics_details_model     ON electronics_details(model COLLATE NOCASE);
-- idx_electronics_details_model is new: the API contract states search
-- matches "brand/model" symmetrically, but only brand had an index.

-- Same defense-in-depth pattern as 006_tenant_scoping.sql's *_tenant_matches_item
-- triggers, added upfront here (book_details/clothing_details only got theirs
-- retrofitted because they predate multi-tenancy; electronics_details is new,
-- so it's built with the invariant from day one):
CREATE TRIGGER electronics_details_tenant_matches_item_ins
BEFORE INSERT ON electronics_details
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN SELECT RAISE(FAIL, 'electronics_details.tenant_id must match items.tenant_id'); END;

CREATE TRIGGER electronics_details_tenant_matches_item_upd
BEFORE UPDATE ON electronics_details
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN SELECT RAISE(FAIL, 'electronics_details.tenant_id must match items.tenant_id'); END;

-- New: nothing previously stopped a row from linking to an item whose
-- category isn't 'electronics'. Same shape as the tenant-matching pair above.
CREATE TRIGGER electronics_details_category_matches_item_ins
BEFORE INSERT ON electronics_details
WHEN (SELECT category FROM items WHERE id = NEW.item_id) != 'electronics'
BEGIN SELECT RAISE(FAIL, 'electronics_details.item_id must reference an electronics item'); END;

CREATE TRIGGER electronics_details_category_matches_item_upd
BEFORE UPDATE ON electronics_details
WHEN (SELECT category FROM items WHERE id = NEW.item_id) != 'electronics'
BEGIN SELECT RAISE(FAIL, 'electronics_details.item_id must reference an electronics item'); END;
```

`lib/db.ts`'s `VERSIONED_MIGRATIONS` array gets one new entry: `{ version: 14, file: '014_electronics_category.sql' }`.

No other table changes. Swappa needs no durable pacing/session table of its own (unlike Poshmark's `poshmark_delist_events`/`poshmark_share_events`) — it self-paces via the same in-memory `enforcePacing` mechanism as Mercari/Grailed/Depop/Vinted, which needs no schema.

## API / interface contract

**`POST /api/items`** (`category: 'electronics'`) — new required fields `brand`, `model`, `condition` (from `ELECTRONICS_CONDITIONS`); optional `processor`, `ram_gb`, `storage_gb`, `screen_size_in`, `battery_health_pct` (0–100), `battery_cycle_count` (≥0). Same `{ error: 'Validation failed.', fields: [...] }` 422 shape as book/clothing; a battery field outside its valid range is a 422 at the API layer (validated in JS before the INSERT, in addition to the DB CHECK — AC3's "ideally... before reaching the DB").

**`GET /api/items/[id]`** — `details` now includes an `ElectronicsDetails`-shaped object when `category === 'electronics'`, unchanged for book/clothing.

**`PATCH /api/items/[id]`** — extends the existing allowlist with electronics-only fields `battery_health_pct`, `battery_cycle_count`, plus the existing generic `condition` (already category-scoped via `conditionsForCategory`). Same terminal-status-exclusion (409) and unknown-field-silently-ignored behavior as clothing's allowlist today.

**`GET /api/items`** (list/search) — `category=electronics` is now a valid filter value; search matches `electronics_details.brand`/`model` alongside the existing book/clothing searchable fields.

**`GET /api/dashboard`** — `by_category.electronics` and electronics rows counted into `by_condition` alongside book/clothing, via the same per-category `GROUP BY` query pattern.

**`GET /api/export`** / **`POST /api/import`** (CSV) — new columns `model`, `processor`, `ram_gb`, `storage_gb`, `screen_size_in`, `battery_health_pct`, `battery_cycle_count`, blank on book/clothing rows; the existing shared `brand`/`condition` columns are populated from `electronics_details` on electronics rows (mirroring how `condition` already merges `book_details.condition`/`clothing_details.condition` into one CSV cell today). Import validates electronics rows with the same "collect all row errors, don't abort the batch" behavior as book/clothing.

**Connector layer** — no new HTTP surface; `ListingInput`/`Connector` shapes only. `getConnector('swappa')` joins `getConnector('ebay'|'etsy'|...)` in `lib/connectors/registry.ts`. Every connector's `createListing(input)` either accepts `category: 'electronics'` (Mercari/Poshmark/Amazon/eBay/Grailed/Swappa) or throws `UnsupportedCategoryError` (Etsy/Depop/Vinted for electronics; Swappa for book/clothing) — never a silent no-op.

**Item-platform picker** (`/inventory/[id]`'s "Platforms" field) — replaces today's free-text comma-separated `<input>` with a checkbox/multi-select populated from a new `platformsForCategory(category)` helper, so an electronics item can only select {mercari, poshmark, amazon, ebay, grailed, swappa} and a book/clothing item can only select the existing 8 minus swappa.

## Integration points

- `lib/constants.ts` — add `ELECTRONICS_CONDITIONS`/`ElectronicsCondition`; widen `CATEGORIES` to include `'electronics'`; add `'electronics'` case to `conditionsForCategory`; add `'swappa'` to `SUPPORTED_PLATFORMS`; add `SWAPPA_ACTION_INTERVAL_MS`; add `LAPTOP_BRANDS` (small hardcoded constant list of well-known laptop brands, e.g. Apple/Dell/HP/Lenovo/Asus/Acer/Microsoft/Samsung, for `AddElectronicsForm`'s brand `<select>` — see Design decisions and Technology choices); add a single `PLATFORM_CATEGORY_SUPPORT: Record<SupportedPlatform, readonly Category[]>` map — the one source of truth for which platforms support which categories — plus a new `platformsForCategory(category): readonly SupportedPlatform[]` that derives its return value from `PLATFORM_CATEGORY_SUPPORT` (rather than its own separate switch) for the item-platform picker, and a shared `assertCategorySupported(platform: SupportedPlatform, category: Category): void` helper (throws `UnsupportedCategoryError`) that every connector's `createListing` calls as its first statement.
- `lib/types.ts` — add `ElectronicsDetails` interface; widen the `Item` discriminated union with the `category: 'electronics'` arm.
- `lib/electronics.ts` (new file, mirrors `lib/clothing.ts`) — `validateBatteryHealthPct`, `validateBatteryCycleCount`, `validateRamGb`/`validateStorageGb`/`validateScreenSizeIn` (each: absent is valid, present-but-invalid is rejected — same shape as `validateWeightOz`/`validateMeasurement`).
- `data/migrations/014_electronics_category.sql` (new) + `lib/db.ts` — register migration 14 as described above.
- `lib/connectors/types.ts` — widen `ListingInput.category`/`.details`; add `UnsupportedCategoryError` (platform, category) alongside the existing `ConnectorError` subclasses.
- `lib/connectors/listingContent.ts` — add an `electronics` branch to `buildListingDescription` (brand/model/processor/RAM/storage/screen size/battery health/cycle count/condition, same `.filter(Boolean).join('\n')` shape as the book/clothing branches). `buildListingDescription` is currently a plain `if (category === 'book') {...}` with an implicit `else` that casts to `ClothingDetails` — not a switch, so there's no compiler exhaustiveness guard. Restructure into a real exhaustive `switch (category)` (or an if/else-if/else chain ending in a `never`-typed final else) when adding the electronics branch, so the cast-based fallthrough bug class this shape invites doesn't recur.
- `lib/connectors/mercari.ts`, `poshmark.ts`, `amazon.ts`, `ebay.ts`, `grailed.ts` — extend each connector's category-specific field-mapping (`fillCategoryFields` for the three Playwright connectors; the SP-API/eBay Trading-API payload builders for Amazon/eBay) with an electronics branch, mapping `ElectronicsDetails` the same way each currently maps `ClothingDetails`. Each `createListing` also calls the new shared `assertCategorySupported(platform, input.category)` (see `lib/constants.ts` above) as its first statement, replacing any connector-specific guard/implicit-accept. Gating/pacing/suspension logic in each file is otherwise untouched.
- `lib/connectors/etsy.ts`, `depop.ts`, `vinted.ts` — replace the previously-planned one-off guard with a single call to the shared `assertCategorySupported(platform, input.category)` as the first statement of `createListing`, instead of a separate hand-written `if (input.category === 'electronics') throw ...` per file — one shared implementation instead of nine hand-written guards/implicit-accepts across all nine connectors.
- `lib/connectors/swappa.ts` (new) — Playwright-driven connector modeled directly on `grailed.ts` (closest sibling: no durable ban-risk table, in-memory pacing only). `createListing` calls the shared `assertCategorySupported('swappa', input.category)` as its first statement (rejecting non-electronics), before `enforcePacing`/`withSession` ever run.
- `lib/connectors/pacing.ts` — add `'swappa'` to `PacedPlatform` and `PACING_WINDOW_MS`.
- `lib/connectors/registry.ts` — import `swappaConnector`; add `swappa: buildConnector('swappa', swappaConnector)` to `CONNECTORS` (the `satisfies Record<SupportedPlatform, Connector>` check forces this the moment `'swappa'` lands in `SUPPORTED_PLATFORMS`).
- `lib/constants/platformTiers.ts` — add `swappa: 'credential'` (same tier as poshmark/depop/mercari/vinted/grailed — this is what makes it appear under `ConnectCardGrid`'s "Credential" section for account-level connect/consent, no `ConnectCardGrid.tsx` code change needed).
- `lib/constants/operabilityTiers.ts` (used by `components/connections/StatusList.tsx`) — add a `swappa` entry, same tier as the other credential-tier browser-automation platforms. This is a fourth platform-tier map (`as const satisfies Record<SupportedPlatform, ...>`, alongside `platformTiers.ts` and the connector `registry.ts`'s `CONNECTORS`) that fails to compile the instant `'swappa'` lands in `SUPPORTED_PLATFORMS` if left unhandled — easy to miss since it wasn't previously listed here.
- `app/api/items/route.ts` — add `handleElectronicsCreate` (validate → insert → fetch, mirroring `handleClothingCreate`); extend `GET`'s `fromJoin`/`mapItemRow`/search-fields/`buildItemFilters`'s condition clause with the `electronics_details` join. `POST`'s category routing is currently a non-exhaustive if/return chain (`if (cat === 'book') {...} return handleClothingCreate(...)`) with no compiler-enforced exhaustiveness, unlike `lib/types.ts`'s `Item` union or `ItemCardGrid.tsx`'s `CATEGORY_STYLES: Record<Item['category'], string>`. If the constants/types widening (adding `'electronics'`) ships before this route-handler widening — a plausible ordering given many steps are parallelizable — an electronics POST would silently fall through to `handleClothingCreate` with no error, miscategorizing the row. Restructure into an exhaustive `switch (category) { ...; default: { const _exhaustive: never = category; ... } }`, the same compiler-enforced pattern `conditionsForCategory` in `lib/constants.ts` already uses correctly, so a missed category is a TypeScript compile error, not a silent runtime miscategorization.
- `app/api/items/[id]/route.ts` — extend `fetchDetails`'s category switch (also convert to the same exhaustive `switch`/`never`-check shape described above, since it currently has the same non-exhaustive-chain risk); add `ELECTRONICS_FIELD_VALIDATORS` (battery_health_pct, battery_cycle_count) mirroring `CLOTHING_FIELD_VALIDATORS`; extend `applyDetailUpdates`'s table-name ternary into an exhaustive 3-way `switch` with a `never` check, not a plain ternary chain, for the same reason. Additionally, `PATCH`'s `platforms` field validation today checks only `Array<string>` — it never validates against `SUPPORTED_PLATFORMS` or any category-scoped list, so a raw PATCH could set e.g. `platforms: ['swappa']` on a book item with no server-side rejection. Change this validation to check each submitted platform against `PLATFORM_CATEGORY_SUPPORT[item.category]` (see `lib/constants.ts` above) and reject (422) any platform not in that list — this is what makes AC15/16 actually enforced server-side, not just true in the UI picker.
- `lib/dashboard.ts` — seed `by_condition` with `ELECTRONICS_CONDITIONS`; add the `electronics_details` per-category condition-count query; `by_category` already generalizes via `CATEGORIES.forEach`, so it picks up electronics automatically once `CATEGORIES` is widened.
- `app/api/export/route.ts` / `app/api/import/route.ts` — add `electronicsFieldsOrBlank`/electronics CSV columns; extend `conditionCell`-equivalent merge logic; extend `fetchExportRows`'s join and import's per-row validation/insert branch.
- `app/inventory/new/page.tsx` — third category tab ("Electronics") rendering a new `AddElectronicsForm`.
- `components/AddElectronicsForm.tsx` (new, mirrors `AddClothingForm.tsx`) — reuses existing shared `ConditionSelect`, `AcquisitionFields`, `SubmitButton`, `SubmitError`, `FieldError`, `useSubmitItemForm` — no new form-plumbing component needed. Brand is a `<select>` populated from the new `LAPTOP_BRANDS` constant (see Design decisions and Technology choices); model remains a plain text input (no seeded-vocabulary combobox, unlike clothing's `BrandCombobox`).
- `components/ElectronicsDetailRows.tsx` (new, mirrors `BookDetailRows`/`ClothingDetailRows`) — renders electronics-specific fields (brand, model, processor, RAM/storage/screen-size specs, battery health/cycle count, condition) in a detail-row grid layout consistent with existing category detail renderings.
- `app/inventory/[id]/page.tsx` — add `ElectronicsDetailRows` (mirrors `BookDetailRows`/`ClothingDetailRows`); `DetailsSection`'s category ternary becomes a 3-way branch; replace the free-text "Platforms" input in `EditListingForm` with a `platformsForCategory(item.category)`-filtered picker.
- `components/ItemCardGrid.tsx` — `CATEGORY_STYLES` (a `Record<Item['category'], string>`) forces a compile error until an `electronics` color entry is added; `formatCategory` and the book/clothing emoji ternary (`📖`/`👕`) both become 3-way, adding `💻`.
- Tests: `lib/connectors/__tests__/{mercari,poshmark,amazon,ebay,grailed}.test.ts` gain an electronics `createListing` case (FR18/AC8); `etsy.test.ts`/`depop.test.ts`/`vinted.test.ts` gain an electronics-rejection case (AC9); new `lib/connectors/__tests__/swappa.test.ts` covering gating, dry-run, and category-rejection (FR25/AC10–14), built the same way as `grailed.test.ts` — no static `playwright` import anywhere in `swappa.ts`, so no test-side mocking trick is even needed beyond what `playwrightSession.ts` already guarantees.

## Technology choices

- No new libraries. Swappa reuses `playwright` (already a dependency for the credential-tier connectors) rather than introducing a second automation library, per the existing constraint.
- No seeded-vocabulary *table* (`electronics_brands`) or full combobox/canonicalization system for laptop brand, unlike clothing's `clothing_brands`/`BrandCombobox` — that would be a second migration surface and a second resolver (`resolveCanonicalBrand`-equivalent) not requested by any FR. But unlike clothing brands, laptop brands genuinely are a small, closed, well-known set (Apple, Dell, HP, Lenovo, Asus, Acer, Microsoft, Samsung, ...), and free text invites fragmentation ("HP"/"Hewlett-Packard"/"hp") in dashboard/CSV views. Middle ground: a hardcoded `LAPTOP_BRANDS` constant list in `lib/constants.ts` backs `AddElectronicsForm`'s brand field as a `<select>` — an app-layer UI convenience only, no new table, no CHECK; the column stays plain `TEXT NOT NULL`, same as `book_details.author`.
- `platformsForCategory()` is a new, small function rather than reusing/overloading `conditionsForCategory` — different return shape (`SupportedPlatform[]` vs a condition-label vocabulary) and a different consumer (item-platform picker vs condition `<select>`), so collapsing them into one generic "vocabulary for category" function would blur two unrelated concerns for no reuse benefit.

## Risk areas

- **`items` rebuild is now against a live, migrated schema, not the 003-era one.** The actual migration must copy the table's *current* full column list (including `tenant_id` and every CHECK migration 006 didn't touch) verbatim — the SQL sketched above is representative, not copy-paste-ready; whoever writes the real migration must diff against a fresh `.schema items` on the deployed desktop DB (per this repo's CLAUDE.md: verify against `data/inventory.db` on the desktop, not the Mac's disposable clone) before finalizing the explicit column list used in both the `items_v2` CREATE TABLE and the `INSERT INTO items_v2 (...) SELECT (...) FROM items` above — never fall back to a bare `SELECT *`, which is positional and would silently scramble row data on any column-order mismatch.
- **Swappa's real DOM is completely unverified — and so is the underlying behavioral assumption, not just the selectors.** Like every other Playwright connector in this repo, `swappa.ts` ships with best-effort `data-testid` selectors nobody has confirmed against a live Swappa account — this is explicitly the existing convention (see `mercari.ts`/`grailed.ts`'s own top-of-file caveats), not a new risk this feature introduces, but it does mean Swappa's connector is inert-by-construction until a maintainer with a real Swappa seller account corrects the selectors. Beyond selectors: this plan models Swappa's connector directly on Grailed's shape, which assumes `createListing` returns an immediately-live external listing ID synchronously. Swappa is historically a verified electronics marketplace (device/IMEI verification, listing review) — its real submission flow may not be instant the way Grailed/Poshmark/Mercari's are. That assumption isn't resolvable without a real Swappa account; a maintainer with real account access must verify it before trusting `markSold`/`delist`'s assumptions too, which also presume a synchronously-live listing.
- **`item_platforms.platform` (and `platform_connections.platform`) are app-layer allowlists (`SUPPORTED_PLATFORMS`), not DB CHECK constraints** — per `lib/constants.ts`'s own comment explaining this was a deliberate choice specifically to avoid CHECK-rebuild pain when adding platforms. Confirmed: adding `'swappa'` therefore requires no `items_v2`-style table rebuild for `item_platforms` — only the app-layer allowlist change already planned in `lib/constants.ts`.
- **CSV column reuse (`brand`, `condition`) across three categories increases the chance of a silent cross-category leak** if a future edit to `fetchExportRows`'s SQL aliases (`cd.brand AS brand` vs `ed.brand AS elec_brand`) gets merged carelessly — the existing `conditionCell()` precedent shows this pattern already works, but it's an easy spot for a copy-paste mistake to surface a clothing brand on an electronics row or vice versa. Worth an explicit test asserting the blank-column invariant per category (AC6).
- **The item-platform picker is a bigger UI change than it looks.** Today `/inventory/[id]`'s "Platforms" field is unrestricted free text; FR26/AC15/16 require it to become a category-filtered picker. This touches an existing, already-shipped UX surface (not just adding a new one), so it needs its own Playwright/component test coverage confirming Swappa never appears for book/clothing and Etsy/Depop/Vinted never appear for electronics — regressing this silently (e.g. picker renders but isn't actually filtered) wouldn't fail any existing test.
- **`ELECTRONICS_CONDITIONS` and the exact spec-field list are this plan's own decision, not a requirement locked upstream.** If Preston's actual laptop-reselling workflow uses different grading language (e.g. matching Swappa's own published condition tiers verbatim, if those differ from what's proposed here), the CHECK constraint and vocabulary are cheap to change pre-launch but become another bounded-rebuild migration once real rows exist — worth confirming the label set against Swappa's actual listing form before, not after, shipping.
