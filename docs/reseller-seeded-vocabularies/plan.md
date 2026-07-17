# Plan: Reseller Seeded Vocabularies

## Approach
Mirror the `clothing_brands` pattern (migration-defined table, `resolveCanonicalX`/`validateXInput` helpers, `GET /api/x` endpoint, ARIA combobox) three more times for color, material, and department, plus backfill `clothing_brands` itself — no new abstractions beyond what's already proven in PR #12, except one: the three new resolve/validate helper trios are generated from a single shared factory (`lib/vocabResolver.ts`, new — see Design decisions) rather than copy-pasted three times, to avoid near-certain duplication-detector flags and multi-file bugfix coordination later. Seeding is split across two mechanisms because they solve different problems: a one-time versioned SQL migration (`012_...sql`) backfills every tenant that already exists, while a shared `seedStarterVocabulary(tenantId)` helper called from `createTenant()` seeds every tenant created from this point forward — the migration alone can never reach a tenant created after it last ran, and "seed on signup" alone can never reach tenants that already exist, so both are required, not redundant. `VocabCombobox.tsx` is a new, separate component (not a refactor of `BrandCombobox.tsx`, which stays untouched per scope) that generalizes the same filtering/ranking/keyboard logic behind four small config props.

## Architecture
```
Migration path (existing tenants, one-time):
  data/migrations/012_clothing_vocabularies.sql
    ├─ CREATE TABLE clothing_colors / clothing_materials / clothing_departments
    ├─ CREATE INDEX idx_clothing_details_tenant ON clothing_details(tenant_id)
    └─ INSERT OR IGNORE ... SELECT tenants.id × starter VALUES
         (also backfills clothing_brands for existing tenants)
    gated by PRAGMA user_version (existing lib/db.ts runner), plus its own
    INSERT OR IGNORE for defense-in-depth idempotency (FR9)

Signup path (future tenants, every time):
  app/api/auth/signup/route.ts
    → createTenant() in lib/tenantAuth.ts
        db.transaction:
          INSERT INTO tenants (...)
          seedStarterVocabulary(tenantId)   ← lib/vocabSeed.ts (new, shared)
              inserts the same starter rows into clothing_brands/colors/
              materials/departments for this one tenant

Read path (listing the vocab for a combobox):
  VocabCombobox.tsx --GET /api/{colors,materials,departments}--> requireTenant()
    --> SELECT ... WHERE tenant_id = ? ORDER BY canonical_name COLLATE NOCASE LIMIT 200

Write path (clothing item creation):
  AddClothingForm.tsx (VocabCombobox × 3)
    → POST /api/items
        → validateColorInput / validateMaterialInput / validateDepartmentInput
        → invalidFieldsResponse gate
        → resolveCanonicalColor / resolveCanonicalMaterial / resolveCanonicalDepartment
            (lib/colors.ts, lib/materials.ts, lib/departments.ts — each a thin
             instantiation of the new shared lib/vocabResolver.ts factory;
             lib/brands.ts itself is untouched, see Design decisions)
        → insertClothingRecord (unchanged)

Untouched paths (explicitly out of scope, see Design decisions):
  PATCH /api/items/[id] (app/api/items/[id]/route.ts) and POST /api/import
  (app/api/import/route.ts) keep calling the existing, unmodified
  lib/clothing.ts::validateGenderDepartment and do not call any
  resolveCanonicalX function.
```

## Data model
New tables, each an exact structural copy of `clothing_brands` (migration 011)
**except** the `id` column, which drops the UUIDv4-version-nibble `CHECK` —
see Design decisions for why — and the `canonical_name` `CHECK`, which gains
an explicit `<= 255` length cap matching the app-layer validation these
tables' data must satisfy:

```sql
CREATE TABLE clothing_colors (
  id             TEXT NOT NULL PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  canonical_name TEXT NOT NULL
                 CHECK (length(trim(canonical_name)) > 0
                        AND length(canonical_name) <= 255),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
                 CHECK (created_at LIKE '____-__-__%'),
  UNIQUE (tenant_id, canonical_name COLLATE NOCASE)
);
-- CREATE TABLE clothing_materials (... identical shape ...)
-- CREATE TABLE clothing_departments (... identical shape ...)

-- clothing_details currently has no plain tenant_id index (only composite
-- indexes that don't lead with it usefully for this query shape).
-- fetchFieldSuggestions's query (`WHERE tenant_id = ? GROUP BY {field}`) is
-- unindexed on this column today, and this feature triples that query's
-- traffic by wiring three new VocabCombobox instances into the same
-- suggestions endpoint — this is the right migration to add it in.
CREATE INDEX idx_clothing_details_tenant ON clothing_details(tenant_id);
```

Note: `clothing_brands` itself (migration 011, already shipped in PR #12) is
**not** altered by this migration — its existing `id` CHECK (version-nibble
UUIDv4 shape) and its existing `canonical_name` CHECK (no `<= 255` cap, same
gap these new tables just closed) are both left exactly as they are. Adding
the length cap there, or dropping its id CHECK, is out of scope for this
feature (see Design decisions).

Seed step (same migration file). Two different id-generation expressions are
needed within this one file, not one, because `clothing_brands`' CHECK
constraint is unchanged and still requires the version-nibble UUIDv4 shape,
while the three new tables no longer have that constraint at all:

```sql
-- clothing_colors / clothing_materials / clothing_departments: no id CHECK
-- to satisfy, so a plain 32-hex-char random id is enough. No per-row app
-- loop needed for the bulk INSERT ... SELECT.
--
-- NOTE (corrected during Task 2 implementation): SQLite's grammar does not
-- accept a column-alias list on a derived table (`(VALUES ...) AS v(name)`)
-- the way PostgreSQL does — confirmed against sqlite3 3.51.0 ("near '(':
-- syntax error"). `WITH v(name) AS (VALUES ...)` CTEs give the same named
-- column (SQLite CTEs DO accept a column-alias list) with identical values,
-- escaping, and CROSS JOIN semantics — use this CTE form everywhere below,
-- including for the clothing_brands backfill in Task 3.
WITH v(name) AS (VALUES
  ('Black'),('White'),('Gray'),('Navy'),('Red'),('Blue'),('Green'),
  ('Yellow'),('Orange'),('Purple'),('Pink'),('Brown'),('Beige'),
  ('Multicolor')
)
INSERT OR IGNORE INTO clothing_colors (id, tenant_id, canonical_name)
SELECT lower(hex(randomblob(16))), t.id, v.name
FROM tenants t
CROSS JOIN v;

WITH v(name) AS (VALUES
  ('Cotton'),('Polyester'),('Wool'),('Denim'),('Leather'),('Silk'),
  ('Linen'),('Cashmere'),('Nylon'),('Spandex'),('Rayon'),('Fleece'),
  ('Suede'),('Canvas')
)
INSERT OR IGNORE INTO clothing_materials (id, tenant_id, canonical_name)
SELECT lower(hex(randomblob(16))), t.id, v.name
FROM tenants t
CROSS JOIN v;

-- WARNING: every apostrophe in a seed literal must be doubled (SQL escaping),
-- or the migration file fails to parse / truncates the string silently.
-- 'Men''s', 'Women''s', and 'Kids''' each carry one literal apostrophe:
--   'Kids''' breaks down as: opening quote, K-i-d-s, then '' (the doubled,
--   escaped apostrophe standing for the one literal ' in "Kids'"), then the
--   closing quote — three quote characters in a row at the end, not two,
--   not four. Verify each escaped literal by counting quote characters this
--   way, not by eye.
WITH v(name) AS (VALUES
  ('Men''s'),('Women''s'),('Kids'''),('Unisex'),('Baby')
)
INSERT OR IGNORE INTO clothing_departments (id, tenant_id, canonical_name)
SELECT lower(hex(randomblob(16))), t.id, v.name
FROM tenants t
CROSS JOIN v;

-- clothing_brands: existing table, existing CHECK (length(id) = 36 AND
-- substr(id, 15, 1) = '4') is unchanged, so this backfill (unlike the three
-- above) still needs the version-nibble UUIDv4-shaped expression to satisfy
-- it. 'Levi''s' is this list's one escaped apostrophe.
WITH v(name) AS (VALUES
  ('Nike'),('Adidas'),('Levi''s'),('Zara'),('H&M'),('Gap'),('Old Navy'),
  ('Ralph Lauren'),('Tommy Hilfiger'),('Calvin Klein'),('Coach'),
  ('Michael Kors'),('Patagonia'),('The North Face'),('Lululemon'),
  ('Under Armour'),('Vans'),('Converse'),('New Balance'),('Champion'),
  ('Carhartt'),('J.Crew'),('Banana Republic'),('American Eagle'),
  ('Free People')
)
INSERT OR IGNORE INTO clothing_brands (id, tenant_id, canonical_name)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
        substr(hex(randomblob(2)), 2) || '-' ||
        substr('89ab', abs(random()) % 4 + 1, 1) ||
        substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  t.id,
  v.name
FROM tenants t
CROSS JOIN v;
```

`INSERT OR IGNORE` relies on the `UNIQUE(tenant_id, canonical_name COLLATE
NOCASE)` constraint to silently no-op a repeat row — this is the FR9
idempotency mechanism, layered on top of (not a replacement for) the existing
`PRAGMA user_version` gate that already stops the migration file from
re-executing at all in the common case.

**Reversibility note (id format):** once real tenant rows exist with
`lower(hex(randomblob(16)))`-style ids in `clothing_colors`/`materials`/
`departments`, switching to a different id format later (e.g. adding a
version-nibble CHECK retroactively, or moving to a different id shape
entirely) is not a code-only change — it needs its own forward migration to
rewrite or backfill existing rows, the same way this plan already needs one
to backfill `clothing_brands`. Choosing the simpler format now is correct for
this pass, but it is not free to undo later.

No changes to `clothing_details`'s existing columns, `items`, `tenants`, or
any size-system table (the one new index above is additive and does not
alter any column).

## API / interface contract
Three new endpoints, each an exact copy of `GET /api/brands`'s shape:

- `GET /api/colors` → `{ colors: Array<{ id: string; canonical_name: string }> }`
- `GET /api/materials` → `{ materials: Array<{ id: string; canonical_name: string }> }`
- `GET /api/departments` → `{ departments: Array<{ id: string; canonical_name: string }> }`

All three: `requireTenant(request)` first (401/redirect-equivalent on
failure, matching `/api/brands`), then `SELECT id, canonical_name FROM
{table} WHERE tenant_id = ? ORDER BY canonical_name COLLATE NOCASE LIMIT
200`, wrapped in the same try/catch → 500 on unexpected error.

`POST /api/items` (clothing branch): no new endpoint, no shape change to the
request/response contract — `color`, `material`, `gender_department` remain
optional string fields in the body. Internally, once `invalidFieldsResponse`
passes, each non-empty field is rewritten to its resolved canonical form
before insert (mirroring the existing `fields.brand = resolveCanonicalBrand(...)`
line):

```ts
fields.brand = resolveCanonicalBrand(tenantId, fields.brand);
if (fields.color) fields.color = resolveCanonicalColor(tenantId, fields.color);
if (fields.material) fields.material = resolveCanonicalMaterial(tenantId, fields.material);
if (fields.gender_department) {
  fields.gender_department = resolveCanonicalDepartment(tenantId, fields.gender_department);
}
```

Error cases: unchanged from today — a too-long or wrong-typed color/material/
department still lands in `invalidFields` and returns the existing 422
`{ error: 'Validation failed.', fields: [...] }` shape, now via
`validateColorInput`/`validateMaterialInput`/`validateDepartmentInput`
(new, in `lib/departments.ts` etc., ≤255-char cap, optional-field-safe) for
this one POST /api/items clothing-create path only. The existing
`lib/clothing.ts::validateGenderDepartment` — which has other call sites
(`app/api/items/[id]/route.ts` PATCH, `app/api/import/route.ts`) outside this
feature's scope, and which has no length cap today — is **not** modified;
`PATCH /api/items/[id]` and `POST /api/import` keep calling it exactly as it
is now. See Design decisions for why this is a deliberate boundary, not an
oversight.

`VocabCombobox.tsx` props (new component):
```ts
interface VocabComboboxProps {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  endpoint: string;         // e.g. '/api/colors'
  responseKey: string;      // e.g. 'colors' — matches the endpoint's JSON key
  suggestionField: string;  // fetchFieldSuggestions field key, e.g. 'color'
  label: string;            // e.g. 'Color'
  required?: boolean;       // default false — all three current uses are optional
  maxLength: number;        // e.g. 255
}
```

## Integration points
- `data/migrations/012_clothing_vocabularies.sql` — new migration: creates `clothing_colors`/`clothing_materials`/`clothing_departments` (no id-format CHECK, `canonical_name` capped at 255), adds `idx_clothing_details_tenant`, backfills the three new tables plus `clothing_brands` for every existing tenant (FR1–7, FR9).
- `lib/db.ts` — register the new migration in `VERSIONED_MIGRATIONS` as `{ version: 12, file: '012_clothing_vocabularies.sql' }`, following the existing version-11 entry; the migration file does nothing until this array references it (FR1).
- `tests/api/tenant-isolation.test.ts` — AC13's fresh-DB test hardcodes `expect(userVersion).toBe(11)`; bumped to 12 alongside the version-12 migration (every prior migration required the same one-line bump here).
- `lib/vocabResolver.ts` — new: `createVocabResolver(tableName: string)` factory returning `{ resolveCanonical, validateInput, selectCanonical }` closures parameterized by table name, extracted from `lib/brands.ts`'s resolve/validate/select shape. `lib/brands.ts` itself is not touched or refactored — it stays exactly as shipped in PR #12 (FR10–12, see Design decisions).
- `lib/colors.ts`, `lib/materials.ts`, `lib/departments.ts` — new: each a thin, few-line instantiation of `createVocabResolver('clothing_colors' | 'clothing_materials' | 'clothing_departments')`, re-exporting named functions (`resolveCanonicalColor`/`validateColorInput`, etc.) for call-site readability (FR10–12).
- `lib/vocabSeed.ts` — new: holds the four starter-value arrays and `seedStarterVocabulary(tenantId)`, the single seeding routine shared by future-tenant signup (this module is the JS-side source of truth; the migration's SQL literals are a separate, frozen, one-time snapshot — see Risk areas).
- `lib/tenantAuth.ts` — `createTenant()` wraps the existing `INSERT INTO tenants` and a new `seedStarterVocabulary(tenantId)` call in one `db.transaction`, so every tenant created after this ships gets the starter vocab atomically with its own creation (FR8, AC5).
- `app/api/colors/route.ts`, `app/api/materials/route.ts`, `app/api/departments/route.ts` — new: each a copy of `app/api/brands/route.ts` (FR14).
- `app/api/items/route.ts` — `validateClothingIdentityFields`/`validateClothingAttributeFields` swap inline checks for `validateColorInput`/`validateMaterialInput`/`validateDepartmentInput`; `handleClothingCreate` gains the three `resolveCanonicalX` calls after the `invalidFieldsResponse` gate (FR13).
- `app/api/items/[id]/route.ts` (PATCH) and `app/api/import/route.ts` — **not touched.** Both keep using the existing, unmodified `lib/clothing.ts::validateGenderDepartment` and do not call any new `resolveCanonicalX` function; this is pre-existing behavior, explicitly out of scope for this feature (see Design decisions).
- `components/VocabCombobox.tsx` — new: generalizes `BrandCombobox.tsx`'s filtering/ranking/keyboard logic (`rankByFrequency`, `moveHighlightIndex`, `buildComboOptions` equivalents) behind the props above; `BrandCombobox.tsx` itself is untouched (FR15, FR20).
- `components/AddClothingForm.tsx` — replaces the three `<input list="...">`/`<datalist>` blocks (color/material/department) with `<VocabCombobox>` instances; brand, size, condition, measurements, acquisition fields untouched (FR16–19).
- `tests/api/colors.test.ts`, `tests/api/materials.test.ts`, `tests/api/departments.test.ts`, `lib/__tests__/vocabResolver.test.ts`, `components/__tests__/VocabCombobox.test.tsx` — new: coverage parity with `tests/api/brands.test.ts`/`BrandCombobox.test.tsx` (NFR4, AC17). Note: `lib/brands.ts` itself has no separate lib-level test file (only `tests/api/brands.test.ts`), so `lib/__tests__/vocabResolver.test.ts` is genuinely new coverage for the shared factory, not a mirror of an existing brands test.

## Technology choices
No new libraries. Reuses `better-sqlite3` (migration SQL + prepared
statements), `uuid`'s `v4()` (already imported in `lib/brands.ts`/
`lib/tenantAuth.ts`; the new `lib/vocabResolver.ts` factory and
`lib/vocabSeed.ts` import it the same way for all JS-side inserts, including
into `clothing_brands`, whose existing CHECK it already satisfies), and the
existing hand-rolled ARIA combobox pattern. The only SQL-side id-generation
technique needed is a plain `lower(hex(randomblob(16)))` for the three new
tables' bulk `INSERT ... SELECT` (no version-nibble math); the migration's
`clothing_brands` backfill block alone keeps the more elaborate `randomblob`/
`hex`/`substr` UUIDv4-shaped expression, because it inserts into the existing
table whose id CHECK constraint is unchanged and still requires that shape.

## Design decisions
- **PATCH/import scope boundary.** `lib/clothing.ts::validateGenderDepartment` has call sites in `app/api/items/[id]/route.ts` (PATCH) and `app/api/import/route.ts` beyond this feature's scope. It is not modified — it keeps its current behavior (no 255-char cap) exactly as-is. The new `validateDepartmentInput` (255-char cap, optional-field-safe) is a separate function living only in `lib/departments.ts`, used only by the new POST /api/items clothing-create resolve path this feature adds. Relatedly, `PATCH /api/items/[id]` does not call any `resolveCanonicalX` function and does not canonicalize `color`/`material`/`gender_department` on edit (it already didn't canonicalize `brand` either) — an item edited via PATCH can end up with a non-canonical value that bypasses the vocabulary tables entirely. Both facts are pre-existing behavior, explicitly out of scope here, called out so they read as a deliberate boundary rather than something silently missed.
- **id format simplification (finding-driven).** The three new tables (`clothing_colors`/`materials`/`departments`) drop the UUIDv4 version-nibble CHECK that `clothing_brands` has, because nothing in this feature functionally needs a v4-shaped id for these lookup/dedup tables — it was copied into the original draft purely for structural symmetry with `clothing_brands`. See the Data model section's reversibility note: this is a one-way-ish choice once real rows exist.
- **`lib/vocabResolver.ts` factory, not three copy-pasted files.** `lib/colors.ts`/`materials.ts`/`departments.ts` would otherwise be near-identical copies of `lib/brands.ts`'s resolve/validate/select trio. This repo runs `fallow audit` with `minOccurrences: 2` in CI, so three copies of the same ~60-line shape would flag immediately, and any future bugfix (e.g. a race-handling tweak) would need three to four coordinated file edits. Extracting one shared factory avoids both. `lib/brands.ts` itself is intentionally left alone — it already shipped in PR #12 and this change doesn't retrofit it onto the new factory.
- **Brand-casing backfill race — accepted, not fixed.** A tenant that already has a resolved lowercase-cased brand row (e.g. "nike") from real prior usage will silently keep that casing after migration 012's `INSERT OR IGNORE` backfill runs, since `IGNORE` means the seeded "Nike" row is skipped for that tenant rather than merged or re-cased. This is accepted as a non-blocking risk: real production usage of the brand field is near-zero at this point (the feature just shipped in PR #12), so no reconciliation logic is being built for this pass.
- **Department stays an open combobox, not a closed `<select>` — accepted, deliberate.** The department field uses the same open `VocabCombobox` + auto-insert-on-miss pattern as color/material, even though it has a small taxonomic starter set (5 values). A challenger review suggested reverting to a closed `<select>` enum to prevent typo-driven duplicate departments; this was rejected because it contradicts the user's explicit product direction for uniform add-new-vocabulary UX across every clothing form field. This is a conscious tradeoff, not an oversight — it is not being reverted in this plan.
- **`clothing_brands`' pre-existing gaps stay pre-existing.** Its `id` CHECK (version-nibble UUIDv4 shape) and its `canonical_name` CHECK (no `<= 255` cap) both predate this feature (PR #12) and are both left exactly as shipped — retroactively tightening either is out of scope here, same reasoning as the PATCH/import boundary above.

## Risk areas
- **Two sources of the same 58 literal values.** The migration's hardcoded `VALUES (...)` lists and `lib/vocabSeed.ts`'s starter arrays are independent copies (migrations are frozen historical artifacts and can't import app code) — if the starter list is ever revised, only `vocabSeed.ts` should change (affecting new tenants), and the migration must never be edited after it has shipped; this is a manual-discipline risk, not a code risk.
- **Seed literal SQL-escaping mistakes.** Every apostrophe in a seed value ("Levi's", "Men's", "Women's", "Kids'") must be doubled in the migration's SQL literals or the file fails to parse. This is a one-time transcription risk confined to writing migration 012 itself; the Data model section above spells out each escaped literal explicitly and shows the doubled-quote counting method to reduce the chance of getting it wrong.
- **One CROSS JOIN block still needs UUIDv4-shaped ids.** Dropping the version-nibble CHECK removes the "does the randomblob/hex/substr expression land the `4` at exactly character 15" risk for three of the four seeded tables — but the `clothing_brands` backfill block in the same migration file still needs that exact expression, because it writes into the existing, unmodified `clothing_brands` table whose CHECK still requires it. A CHECK failure there still rolls back the whole migration transaction, so that one block (not the other three) still merits a throwaway-DB dry run before trusting it against real data.
- **Wrapping `createTenant()` in a transaction.** Today it's a bare `INSERT`; adding `db.transaction(() => { insert; seedStarterVocabulary(id); })()` changes the failure surface slightly — needs a check that `DuplicateEmailError`/`WeakPasswordError` still propagate out of the transaction wrapper unchanged (better-sqlite3 rolls back and re-throws the original error, so this should be transparent, but it's new enough to verify explicitly rather than assume).
- **Component generalization drift.** `VocabCombobox` must preserve `BrandCombobox`'s exact "commit raw value on every keystroke, dropdown is a browsing aid not a gate" contract (FR19/AC15) — an over-eager generalization that changes when `onChange` fires would silently break existing Playwright `.fill()` helpers on the color/material/department fields without touching brand's own tests, making the regression easy to miss in a partial test run.
