# Plan: Constrained Brand, Size, and ISBN Fields on Add-Item Forms

## Approach
Add pure-arithmetic ISBN-10/13 checksum validation to `lib/isbn.ts` and gate both the client's lookup call and the server's `/api/items` insert on it — running strictly before `normalizeISBN` is ever called — so a bad check digit never reaches the network or the DB, and never gets silently "corrected" into something structurally valid. Add a small tenant-scoped canonical-brand table (`clothing_brands`, canonical name only — no alias table) that both a new custom combobox and the `POST /api/items` insert path resolve against, so brand values collapse to one canonical spelling regardless of which form path wrote them; `COLLATE NOCASE` matching on `canonical_name` already solves the actual "Nike"/"nike"/"NIKE" casing problem from the requirements, and alias support (e.g. "TNF"→"The North Face") is explicitly deferred per requirements.md's Out-of-scope section, since nothing in this pass ever writes an alias row. The concurrent-insert race on brand creation is a required implementation behavior (catch-and-re-lookup on `SQLITE_CONSTRAINT_UNIQUE`), not just an acknowledged risk. Add one new nullable `clothing_details.size_system` column (plain `TEXT`, no DB-level CHECK — validated app-side only, since SQLite can't alter a CHECK constraint without a full table rebuild), populated only by an explicit operator choice on the form (not inferred from any existing field, since none identifies garment type today) — when set to `letter` or `shoe`, the size field becomes a closed-vocabulary `<select>`; when set to `numeric_waist_inseam`, it becomes two number inputs (waist, inseam) combined client-side into a `"WWxII"` string, since a `<select>` can't reasonably enumerate every combination; when unset (the default, matching every existing row), it stays exactly the free-text-with-brand-scoped-suggestions field it is today. Everything is built with the existing hand-rolled Tailwind + `FieldError` convention — no new dependency — because the combobox's data set (one operator's own brand list, capped at `LIMIT 200`) is small enough that a ~120-line ARIA combobox is simpler than wiring and theming a library.

## Architecture
```
AddBookForm.tsx
  isbn input (onChange/onBlur)
    → strip hyphens/spaces → validateIsbnChecksum(lib/isbn.ts)  [sync, client, no
      network; runs BEFORE normalizeISBN is ever called — see Integration points]
        shape invalid    → local isbnChecksumError state → FieldError "Invalid
                            ISBN format." (clears any existing isbnLookupMsg)
        checksum invalid → local isbnChecksumError state → FieldError "ISBN
                            checksum doesn't match — check the last digit."
                            (clears any existing isbnLookupMsg)
        valid            → existing lookupIsbn() → normalizeISBN → GET
                            /api/isbn/[isbn]  (unchanged)

AddClothingForm.tsx
  BrandCombobox (new component; owns its own data fetching)
    ← GET /api/brands              (canonical names only, tenant-scoped, LIMIT 200)
    ← fetchFieldSuggestions('brand') (existing frequency data, ranking signal
      only — GET /api/brands and this suggestions endpoint serve different
      purposes: canonical list vs. historical-frequency ranking; both are
      intentionally consulted, not redundant)
    → typed text commits to brand form state on every change/blur (so the
      existing Playwright `.fill()` e2e helper keeps working unchanged),
      independent of any explicit listbox selection
    → "Add '<value>' as a new brand" option sets an explicit confirmed_new
      flag alongside the already-typed value — a visual affordance for
      explicit intent, not the only path by which typed text becomes the
      field value
    → onChange(rawText) → brand state (resolution to canonical happens
      authoritatively server-side at submit, not just client-side)

  SizeSystemPicker (new, small) → sets size_system ('letter'|'shoe'|
    'numeric_waist_inseam'|null)
    null                   → existing free-text input + fetchFieldSuggestions('size_label',{brand}) (unchanged)
    'letter' | 'shoe'      → closed-vocabulary <select> sourced from lib/clothing.ts SIZE_SYSTEMS
    'numeric_waist_inseam' → two number inputs (waist, inseam), combined
                             client-side into the "WWxII" string before
                             submission — not a <select> (enumerating every
                             waist×inseam combination isn't viable UI)

  submit → POST /api/items { brand, size_label, size_system, ... }

app/api/items/route.ts (POST, clothing branch)
  validateClothingIdentityFields
    → brand length/non-empty validation (max 255 chars, reject empty-after-trim) [new]
    → resolveCanonicalBrand(db, tenantId, brand)   [new, simplified: canonical_name only]
        match on clothing_brands.canonical_name (case-insensitive, whole-value
        equality — not substring/prose matching; COLLATE NOCASE handles
        "Nike"/"nike"/"NIKE"; alias support e.g. "TNF"→"The North Face" is
        deferred, see requirements.md Out-of-scope)
        found     → substitute canonical_name
        not found → INSERT new clothing_brands row for this tenant; on
                    SQLITE_CONSTRAINT_UNIQUE (concurrent insert of the same
                    canonical name from another request), re-SELECT and use
                    the now-existing row instead of raising a 500 — this is
                    a required implementation behavior, not just a noted risk
    → validateSizeSystem + validateSizeAgainstSystem (when size_system set)
```

## Data model
One migration, `data/migrations/011_clothing_brand_and_size_system.sql`, gated on `PRAGMA user_version` per the existing `lib/db.ts` runner (registered as `{ version: 11, file: '011_clothing_brand_and_size_system.sql' }`).

```sql
-- Canonical brand list, scoped per-tenant like every other satellite table
-- (idx_items_tenant precedent) — no cross-tenant sharing concept exists
-- per requirements' out-of-scope note, so per-tenant storage is the
-- correct model, not a compromise.
--
-- Alias support (e.g. "TNF" -> "The North Face") is explicitly deferred
-- per requirements.md's updated Out-of-scope section — nothing in this
-- pass ever writes an alias row, so a clothing_brand_aliases table would
-- be schema for a feature that isn't wired up. COLLATE NOCASE canonical
-- matching already solves the actual casing problem from the requirements
-- ("Nike"/"nike"/"NIKE" collapse to one row); it does not solve synonym
-- matching, which is out of scope here.
CREATE TABLE clothing_brands (
  id             TEXT NOT NULL PRIMARY KEY
                 CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  canonical_name TEXT NOT NULL
                 CHECK (length(trim(canonical_name)) > 0),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
                 CHECK (created_at LIKE '____-__-__%'),
  UNIQUE (tenant_id, canonical_name COLLATE NOCASE)
);
-- No separate idx_clothing_brands_tenant index: the UNIQUE constraint above
-- already creates a tenant_id-leading index that serves the same queries.

-- Additive, nullable, no DEFAULT needed (NULL means "no closed vocabulary
-- selected" — the exact behavior every pre-existing row already has).
-- ADD COLUMN with no DEFAULT + no NOT NULL does not rebuild the table
-- (same reasoning as 006's tenant_id ADD COLUMNs).
--
-- No DB-level CHECK constraint on the allowed values: SQLite can't ALTER a
-- CHECK constraint in place (it requires a full table rebuild), and the
-- plan already treats the size vocabulary itself as "cheap to widen later"
-- via a plain array/regex in lib/clothing.ts rather than a migration-locked
-- enum — a DB CHECK here would be inconsistent with that same reasoning.
-- Validation is app-layer only, via validateSizeSystem in lib/clothing.ts.
ALTER TABLE clothing_details ADD COLUMN size_system TEXT;
```

Migrations in this codebase are forward-only by established convention — no down-migration exists for any of `001`–`010` either. The rollback-plan caveat about migration irreversibility (in steps.md) is consistent with existing project practice, not a new gap introduced by this feature.

No changes to `book_details`, `items`, or any other existing table. No backfill of existing `clothing_details.brand`/`size_label` values (explicitly out of scope) — the canonical table starts empty per tenant and grows only from "add new brand" confirmations going forward.

## API / interface contract

**`GET /api/brands`** (new route, `app/api/brands/route.ts`)
- Auth: `requireTenant`, same as every other route.
- Response `200`: `{ brands: [{ id, canonical_name }] }` (no `aliases` — alias support is deferred, see Data model), tenant-scoped, ordered by `canonical_name COLLATE NOCASE`, capped at `LIMIT 200` defensively. The accepted typo-autocreation tradeoff (see Risk areas) means the brand list isn't guaranteed to stay small, so the cap is a deliberate defense even without full pagination.
- No `POST /api/brands` — brand creation is folded into `POST /api/items` (see below) rather than a separate pre-registration call, so there is no orphan-canonical-row case (a brand only gets created when an item actually uses it) and no two-round-trip "create then select" UX to build.

**`POST /api/items` (clothing branch)** — request shape unchanged (`brand`, `size_label` as today) plus one new optional field:
- `size_system?: 'letter' | 'shoe' | 'numeric_waist_inseam'` — omitted/null behaves exactly as today (free text, brand-scoped suggestions only).
- Brand bounds (new): reject brand values over 255 chars, and reject empty-after-trim, both client-side (`BrandCombobox`) and server-side (this route) — the two checks must agree.
- Brand resolution (new, server-side, unconditional): trim input, look up case-insensitively against `clothing_brands.canonical_name` only for this tenant (`COLLATE NOCASE`). Match → persist the canonical name. No match → insert a new `clothing_brands` row with the trimmed input as `canonical_name` (this realizes the "add new brand" path — see Integration points) and persist that. **Required implementation behavior, not just a risk note**: the insert-on-no-match path must catch `SQLITE_CONSTRAINT_UNIQUE` (two concurrent submits of the same new brand racing each other) and, on catch, re-SELECT and use the now-existing row rather than surfacing a 500. Either way `clothing_details.brand` always ends up canonical; submission is never blocked on brand (FR13/AC7). All brand lookup/insert queries are parameterized (`?` placeholders via better-sqlite3's `.prepare()`) — no string-concatenated SQL, matching this codebase's existing exclusive convention.
- New validation error: when `size_system` is present but not one of the three enum values → `422 { error: 'Validation failed.', fields: ['size_system'] }`, same shape every other field already uses.
- New validation error: when `size_system` is present and `size_label` doesn't belong to that system's vocabulary (array membership for `letter`/`shoe`; `^\d{1,3}x\d{1,3}$` shape check for `numeric_waist_inseam` — loosened from a stricter 2-digit-only pattern so legitimate single/triple-digit sizes, e.g. petite/kids waist "6x28", aren't rejected) → `422 { fields: ['size_label'] }`. This is defense-in-depth against a request that bypasses the picker UI, not a new client-visible flow.

**`GET /api/isbn/[isbn]`** — unchanged route contract. The checksum gate sits entirely upstream of it (client) and upstream of `lookupISBN()` in the `/api/items` POST book branch (server) — this route itself still only ever sees shape-valid input in practice, same as before.

**`POST /api/items` (book branch)** — one new failure mode: `validateIsbnChecksum` must run on the raw (hyphen/space-stripped) input before any call to `lookupIsbnForBook`/`normalizeISBN` — see Integration points for why the ordering matters. When it fails, branch on the returned `reason`: `reason: 'shape'` → keep the existing `422 { error: 'Invalid ISBN format.' }` response, unchanged; `reason: 'checksum'` → new `422 { error: 'ISBN checksum invalid.', fields: ['isbn'] }`. Don't hardcode one message for both cases.

## Integration points
- `lib/isbn.ts` — add `computeIsbn10CheckDigit` (new), `computeIsbn13CheckDigit` (extracted from the existing inline math in `normalizeISBN`), and `validateIsbnChecksum(isbn: string): { valid: true } | { valid: false; reason: 'shape' | 'checksum' }`.
  - `computeIsbn10CheckDigit` is **new code, not an extraction** — no ISBN-10 check-digit math exists anywhere in this file today (only the ISBN-13/EAN-13 mod-10 math used inside `normalizeISBN`). It implements the distinct ISBN-10 algorithm: weights 10 down to 2 across the first 9 digits, sum the weighted digits, remainder = `11 - (sum mod 11)` reduced mod 11, where a remainder of 10 is represented as the character `'X'`. Do not adapt the existing ISBN-13 mod-10 math by analogy — this was independently flagged by two reviewers as the single most likely implementation mistake.
  - `validateIsbnChecksum` performs its own hyphen/space stripping (matching `normalizeISBN`'s existing stripping behavior) and imports/reuses the existing `ISBN_PATTERN` constant for its shape check rather than re-declaring shape-checking logic a third time in the file.
  - **Ordering requirement**: `validateIsbnChecksum` must run on the raw stripped user input BEFORE any call to `normalizeISBN`, in both `AddBookForm.tsx` and `app/api/items/route.ts`. Reason: `normalizeISBN`'s existing ISBN-10 handling takes `stripped.slice(0, 9)` — it discards the user's actual 10th check character and computes a brand-new ISBN-13 check digit from the 9-digit prefix, never validating the original check digit. If `normalizeISBN` runs first, bad input gets silently "corrected" into something structurally valid and the checksum gate becomes moot. A test must assert this ordering (e.g. `normalizeISBN` is never reached with an unvalidated string).
  - Pure functions, no new imports — safe to import directly from a client component (file already has zero Node-only dependencies).
- `components/AddBookForm.tsx` — call `validateIsbnChecksum` synchronously (and on blur) before the `fetch` to `/api/isbn/[isbn]`, before `normalizeISBN`/`lookupIsbn()` ever run (FR3/FR6). The checksum result does **not** flow through `fieldErrors` from `useSubmitItemForm()` — that state is hook/server-response-driven, not something this component can push into directly. Instead, add local component state (e.g. `isbnChecksumError`) rendered through the same `FieldError` component as a parallel path. A checksum failure must clear/replace the existing `isbnLookupMsg` state so the old "Not found"/"Lookup failed" message and the new checksum message never render simultaneously.
- `app/api/items/route.ts` — `lookupIsbnForBook` gains a `validateIsbnChecksum` call before `normalizeISBN`/`lookupISBN` (same ordering requirement as above), branching the 422 response on `reason` per the API contract. `validateClothingIdentityFields` gains brand length/non-empty checks, a call to a new `resolveCanonicalBrand(tenantId, brand)` helper (new file, see below) in place of using raw `brand` directly, and gains `size_system`/`size_label`-vs-vocabulary validation (loosened `numeric_waist_inseam` regex).
- `lib/clothing.ts` — add `SIZE_SYSTEMS` (the three closed vocabularies) and `validateSizeSystem`/`validateSizeAgainstSystem` (using the loosened `^\d{1,3}x\d{1,3}$` shape check for `numeric_waist_inseam`), alongside the existing `validateWeightOz`/`validateMeasurement`/`validateGenderDepartment` pattern.
- `lib/brands.ts` (new) — `resolveCanonicalBrand(tenantId, rawBrand): string` — simplified to canonical-name-only match-or-create (no alias table/JOIN); catches `SQLITE_CONSTRAINT_UNIQUE` on insert and re-SELECTs rather than throwing, per the API contract's required concurrency behavior. All queries parameterized via `.prepare()`. Kept out of `app/api/items/route.ts` to stay consistent with that file's existing "small helper per concern" decomposition.
- `app/api/brands/route.ts` (new) — `GET` handler per the API contract above (`{ brands: [{ id, canonical_name }] }`, `LIMIT 200`), following the exact `requireTenant` + `db.prepare` shape of `app/api/items/suggestions/route.ts`.
- `components/BrandCombobox.tsx` (new) — replaces the bare `<input list="brand-options">` + `<datalist>` block in `AddClothingForm.tsx`. Hand-rolled ARIA combobox (`role="combobox"`, `aria-expanded`, `aria-controls`, a `role="listbox"` popup of `role="option"` items), filtering the `GET /api/brands` result client-side by substring match against canonical name, ranked by the existing `fetchFieldSuggestions('brand')` frequency data (FR14 — additive ranking input, not a replacement for the canonical list; these two brand data sources serve different purposes — the canonical list constrains/validates selection, the suggestions endpoint is a ranking signal only — and are both intentionally consulted, not redundant). Owns its own `fetchFieldSuggestions('brand')` data-fetching internally (moved out of `AddClothingForm.tsx`'s `useEffect`), now that it also fetches `GET /api/brands`. Commits the raw typed value to form state on blur/change even without an explicit listbox selection — required so the existing Playwright `.fill()`-based e2e helper (`inputByLabel(page, 'Brand *').fill(item.brand)`) keeps working unchanged. Renders an explicit "Add '<value>' as a new brand" option, visually distinct from a normal match, when nothing matches — this is a visual affordance for *explicit* intent (it sets a `confirmed_new` flag alongside the already-typed value), not the only way typed text becomes the field's value. Enforces the same 255-char max / reject-empty-after-trim bounds as the server, client-side.
- `components/SizeSystemPicker.tsx` (new, small) — a `<select>` of "Free text" / "Letter (XS–XXL)" / "Shoe size" / "Numeric (waist × inseam)" that toggles how `AddClothingForm.tsx` renders the size field. `letter` and `shoe` render a closed-vocabulary `<select>` sourced from `SIZE_SYSTEMS`; `numeric_waist_inseam` renders two number inputs (waist, inseam) combined client-side into the `"WWxII"` string before submission — a `<select>` enumerating every waist×inseam combination isn't a viable UI. Defaults to "Free text" so the existing UX (FR16, the "sizes aren't standardized" copy) is what every operator sees unless they opt in.
- `components/AddClothingForm.tsx` — swap the brand `<input list>` block for `<BrandCombobox>` (which now owns its own suggestion-fetching, so the existing brand `useEffect` calling `fetchFieldSuggestions('brand')` is removed from this file); add `<SizeSystemPicker>` above the size field and branch the size field's rendering on its value (free text / closed `<select>` / two number inputs); both new pieces plug into the existing `fieldErrors`/`FieldError` plumbing already threaded through this form.
- `data/migrations/011_clothing_brand_and_size_system.sql` (new) — schema above (`clothing_brands` only; no alias table, no tenant-matches-parent triggers, no CHECK on `size_system`).
- `lib/db.ts` — add `{ version: 11, file: '011_clothing_brand_and_size_system.sql' }` to `VERSIONED_MIGRATIONS`.
- `tests/api/isbn.test.ts` — extend with checksum cases (valid X check char, invalid digit, shape-vs-checksum distinction, and an ordering test asserting `normalizeISBN` is never reached with an unvalidated string).
- `tests/api/suggestions.test.ts` / new `tests/api/brands.test.ts` — canonical matching, case-insensitivity, add-new-brand-on-submit, concurrent-insert-races-to-existing-row, brand length/empty bounds.
- `tests/e2e/clothing-flow.spec.ts` — extend for the combobox interaction (including the `.fill()`-only path with no explicit listbox selection) and size-system picker (including the two-number-input path); confirm book flow (`AddBookForm`) never renders a size field (FR19).

## Technology choices
- No new npm dependency. The combobox and size picker are hand-rolled React + Tailwind, matching `ConditionSelect.tsx`'s existing convention exactly — the operator-scale data volume (their own brand list, capped at 200 via `GET /api/brands`, plus ≤50 ranked suggestions) doesn't need a virtualized/library-grade combobox, and every other field-level component in this repo is already hand-rolled, so introducing Radix/cmdk/shadcn here would be the only dependency of its kind in the codebase for a marginal win.
- `size_system` as an explicit, operator-chosen, optional field (not inferred). There is no existing garment-type/sub-category column on `clothing_details` to key inference off of, and inventing one just to drive inference would mean guessing a size system from free-text `title`/`gender_department` — exactly the kind of guess FR18 says not to force. An explicit opt-in selector makes "unambiguous" true by construction (the operator confirmed it) rather than by pattern-matching, and defaults to today's free-text behavior for every operator who doesn't touch it, so FR15/FR16 (no universal conversion table, free text stays the fallback) hold with zero behavior change for existing rows.

## Risk areas
- **Brand auto-creation on every unmatched submit** means a typo an operator doesn't catch becomes a new permanent canonical entry (e.g. "Nikee") rather than surfacing for review — FR13 explicitly forbids blocking submission on it, so the only mitigations available are combobox-side (fuzzy-match suggestions, a visually distinct "new brand" affordance) rather than a hard gate. Accepted tradeoff per the requirements' own wording ("no such concept" as flagged-for-review is out of scope). This is also why `GET /api/brands` needs its defensive `LIMIT 200` — the brand list isn't guaranteed to stay small.
- **`resolveCanonicalBrand` concurrent-insert handling is now a committed implementation requirement, not just a noted risk**: two rapid submits of a genuinely-new brand from the same tenant (double-click, or two browser tabs) could both miss the canonical-lookup and both attempt an insert; the `UNIQUE (tenant_id, canonical_name COLLATE NOCASE)` constraint turns the loser into a `SQLITE_CONSTRAINT_UNIQUE` that **must** be caught and turned into a re-lookup-then-use-existing, not a 500 — same care `insertBookRecord`'s duplicate-ISBN catch already shows. See API contract and Integration points.
- **Size vocabulary bounds are a judgment call, not a standard**: the shoe-size range and the `numeric_waist_inseam` shape regex (`^\d{1,3}x\d{1,3}$`) are invented for this plan (no external sizing standard is cited in requirements or constraints) — they'll likely need adjustment once real inventory is entered against them, and the plan deliberately keeps them a plain array/regex in `lib/clothing.ts` (not a migration-locked enum, and — per the same reasoning — not a DB-level CHECK constraint either) so they're cheap to widen later.
- **Client-side checksum validation drifts from server-side validation** if `computeIsbn10CheckDigit`/`computeIsbn13CheckDigit` aren't actually the single shared implementation both `AddBookForm.tsx` and `app/api/items/route.ts` import — must verify both call sites import from `lib/isbn.ts` rather than either re-implementing the mod-11/mod-10 math inline, or the two checks can silently disagree.
- **Existing `AddBookForm.tsx` non-ok handling collapses 400/404/503 into one "Not found" message today** — the new `isbnChecksumError` local state is a parallel path to (not a replacement for) that handling, and must actively clear/replace `isbnLookupMsg` so a genuine "not found" from Open Library is never confusable with the new checksum message once both exist side by side.
- **`canonical_name` is stored using whichever casing the first submitter happens to type** — `COLLATE NOCASE` only affects matching, not storage. There is no forced normalization (e.g. title-casing) of the stored value. Accepted tradeoff, documented here rather than left as a silent surprise.
- **`garment_type` is deferred, not avoided** — `size_system`'s current always-manual-choice design may need to become garment-type-derived (with manual override) once/if a garment-type column is ever added to `clothing_details`. Flagged now so it isn't rediscovered as a surprise later.
