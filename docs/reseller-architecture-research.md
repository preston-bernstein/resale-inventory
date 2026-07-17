# Reseller/Crosslisting Architecture Research — Books-to-Clothing Generalization

**Purpose**: informs a schema migration that extends `resale-inventory` (currently books-only) to also
handle clothing resale. This is domain research, not a product-adoption decision — the decision to
extend the existing custom Next.js/SQLite app is already made. Written 2026-07-11.

**Existing app baseline** (for context on every recommendation below — see
`.claude/skills/resale-inventory-architecture-contract/SKILL.md` for full detail):
Next.js 15 App Router + a single-file `better-sqlite3` DB (`data/inventory.db`), UUIDv4 primary
keys, money as integer cents everywhere, inline SQLite `CHECK` constraints for `condition` and
`status` enums (no ALTER-CHECK in SQLite — changing these needs a full table rebuild), a `status`
state machine (`Unlisted → Listed → Sale Pending → Sold`, plus terminal `Removed/Donated/Discarded`)
centralized in `lib/transitions.ts`, and multi-platform listings modeled as a `book_platforms`
junction table (`book_id`, `platform`, `listed_at`) rather than a comma-separated column.

---

## 1. Existing crosslisting/reseller tools — architectural patterns worth stealing

### 1.1 The "one form, many marketplace adapters" pattern (Vendoo, Crosslist, OneShop)

Every commercial crosslister converges on the same shape: **one canonical item record**, filled out
once, that maps into **N platform-specific listing forms**. Vendoo calls this the "Vendoo form" —
sellers fill common attributes once (title, price, condition, brand, category, photos), then Vendoo
carries that data into each marketplace's own form and only prompts for the fields that marketplace
uniquely requires (shipping settings, category-specific taxonomy fields, sizing quirks)
([Vendoo help center](https://help.vendoo.co/en/articles/6260272-how-to-list-the-vendoo-form)).
Crosslist frames it the same way: fill all fields (for all target platforms combined) once, and the
app auto-selects only what's required per destination, flagging missing required fields before
posting ([Crosslist](https://crosslist.com/blog/listing-management-for-resellers/)).

**This directly validates the existing `book_platforms` junction-table pattern.** The industry norm
is exactly "one core item + a per-platform association," not one row per platform or a
comma-separated/denormalized platform field. The one gap the current schema doesn't yet cover that
every commercial tool treats as first-class: **per-platform listing state** — these tools track,
per platform-instance, whether it's currently live, its platform-specific price (prices can differ
by platform), and last-synced timestamp, not just "which platforms is this listed on." Worth
considering whether `book_platforms` (or its clothing-inclusive successor, e.g. `item_platforms`)
should grow `platform_price_cents`, `platform_status`, and `synced_at` columns rather than assuming
one global `listing_price` applies identically everywhere. That's an intentional scope decision, not
a defect — the current app is single-price by design — but multi-platform resale tools uniformly
disagree with the single-global-price assumption. Flag for the migration author.

### 1.2 A known field-fidelity failure mode: size doesn't transfer between marketplaces

Vendoo's own documentation admits: *"Oftentimes the size won't transfer between marketplaces"* and
that certain attributes — **condition, shipping weight, shipping dimensions** — are explicitly
called out as inconsistent/manual across their business-plan integrations
([Vendoo help center](https://help.vendoo.co/en/articles/6260272-how-to-list-the-vendoo-form)).
This is a tell: even mature commercial tools with dedicated engineering teams haven't solved
"one normalized value maps cleanly to every marketplace's taxonomy" for size or condition. **Do not
budget for a fully automatic size/condition mapping layer** — store the seller's own normalized
values and treat any future platform-sync feature as inherently lossy at the edges.

### 1.3 List Perfectly — catalog-first, not listing-first

List Perfectly frames itself around a persistent "LP Catalog" — SKU, quantity, profit calculation,
tags/groups by price/size/shipping-type/custom category — with crosslisting as an operation *on*
catalog rows rather than the catalog being generated *from* listings
([List Perfectly features summary via Threecolts](https://www.threecolts.com/blog/best-cross-listing-app/)).
This matches the existing app's `books` table as source of truth with listings as a derived/attached
concept — good, reuse that framing for clothing rather than inverting it.

### 1.4 No credible open-source/self-hosted crosslisting tool exists

Searched GitHub directly (`github.com/topics/reseller-tools` and keyword searches for "open source
reseller crosslisting," "self-hosted marketplace listing tool," "open source inventory reseller
dashboard"). Findings, concretely:

- `github.com/topics/reseller-tools` surfaces only toy/personal projects: `buy-sell` (PHP, resale
  purchase/sale tracking with profit analytics, **1 star**), `reseller-dashboard` ("Hyperdriveflips
  Inventory Dashboard – Built from Scratch," **1 star**), plus several scraper utilities (Mercari
  sold-comps scraping, Bonanza listing scraping) that are data-extraction tools, not
  listing/inventory systems.
- General open-source inventory systems exist and are mature (**InvenTree**, ERPNext, Dolibarr) but
  are warehouse/ERP-shaped, not reseller/marketplace-shaped — no concept of per-platform listing,
  condition grading, or marketplace fee modeling.
- No project found with meaningful stars, active maintenance, or marketplace-crosslisting scope.

**This is a real, useful finding, not a search failure**: the entire reseller-crosslisting category
is commercial-SaaS-only. There is no FOSS prior art to borrow code or schema from — only the
commercial products' documented behavior (above) and the general e-commerce data-modeling literature
(§5). This slightly raises the value of getting the schema right the first time, since there's no
open reference implementation to fall back on if the custom design has gaps.

### 1.5 Enterprise multichannel tools (Zentail, Sellbrite, ChannelAdvisor) — same pattern, bigger scale

All three (Zentail, Sellbrite/GoDaddy, ChannelAdvisor/Rithum) confirm the identical architecture at
enterprise scale: **one master product/catalog record**, category-mapped and field-translated per
destination channel, with centralized inventory sync to prevent overselling
([Zentail](https://www.zentail.com/), summarized via
[ecommerceguide.substack.com](https://ecommerceguide.substack.com/p/the-10-best-multichannel-selling)).
Nothing here contradicts §1.1 — it's the same "canonical entity + channel adapters" shape scaled to
Amazon/Walmart/Target-level catalog complexity. Useful confirmation that the pattern holds from
solo-reseller scale up to enterprise scale — you're not choosing a toy pattern.

---

## 2. Condition grading vocabularies — real per-platform terms

Books enum today (fixed CHECK constraint): `Poor, Acceptable, Good, Very Good, Like New`. Clothing
needs its own vocabulary — platforms do **not** share one:

| Platform | Condition terms (official) | Source |
|---|---|---|
| **Mercari** | New (NWT/sealed) · Like New (NWOT, lightly used, no tags) · Good (gently worn, minor flaws — pilling/stretching/fading/loose threads, still wearable) · Fair (multiple wear signs — small rips/stains/fading/heavy pilling, still wearable) · Poor (heavily worn, major flaws/damage, parts/repair only) | [Mercari Help Center](https://www.mercari.com/us/help_center/product-info/item-conditions/) |
| **eBay** (2025 pre-loved fashion update) | New with tags · New without tags · New with imperfections (brand new, unworn, has a defect) · **Pre-owned – Excellent** · **Pre-owned – Good** · **Pre-owned – Fair** | [eBay Seller Center, Jan 2025 update](https://www.ebay.com/sellercenter/resources/seller-updates/2025-january/new-item-conditions), [eBay community announcement](https://community.ebay.com/t5/Seller-Update-January-2025/Introducing-new-conditions-for-pre-loved-clothing/td-p/34908723) |
| **Vinted** | New with tags (tags/packaging intact, unused) · New without tags (unused, no tags/packaging) · Very good (worn a few times, slight imperfections clearly disclosed) · Good (worn frequently, visible wear disclosed) · Satisfactory (heavily used, defects disclosed) | [Vinted Help — Choosing item condition](https://www.vinted.com/help/50-choosing-item-condition) |
| **Poshmark** (community convention, not a fixed dropdown enum) | NWT (New With Tags — tags attached, unworn, unwashed) · NWOT (New Without Tags — tags removed/lost but unworn) · EUC (Excellent Used Condition — worn a handful of times, minimal wear, no major flaws) · VGUC (Very Good Used Condition — minor flaws: pilling, discoloration, weak zipper/buttonhole) · GUC (Good Used Condition — obvious but non-structural flaws, still wearable) | [buyitbeforeido.com acronym guide](https://www.buyitbeforeido.com/what-does-euc-nwt-nib-htf-nwot-mean/), [Poshmark Blog — describing condition](https://blog.poshmark.com/2014/06/19/posh-tip-how-to-describe-the-condition-of-your-item/) |
| **TheRealReal** (luxury consignment, 6-tier internal scale) | Pristine (identical/near-identical to new, incl. original box/dust bag/accessories) · ... · Fair (significant wear, may need minor repairs) · As-Is (extensive wear, requires repair to be functional/presentable) — full 6-tier scale not fully published, but anchors and low end confirmed | [TheRealReal — Role of Condition in Luxury Resale](https://realstyle.therealreal.com/condition-in-luxury-resale/) |
| **ThredUp** | Uses standardized internal condition ratings applied by ThredUp's own graders (centralized marketplace model — sellers don't self-grade at listing time the way they do on peer-to-peer platforms); exact tier labels not published in searchable help content as of this research pass | [ThredUp Help Center](https://help.thredup.com/en_us/what-are-the-different-item-conditions-you-sell-SJb2YZ05h) |

**Cross-platform convergence pattern** (the actual signal to design from): every platform splits into
two tiers — **unworn** (tags-on / tags-off split: NWT vs NWOT) and **worn**, and the worn tier is
consistently 3 grades (best/middle/worst — "Excellent/Good/Fair", "Very good/Good/Satisfactory",
"Like New/Good/Fair"). A **5-value clothing condition enum** that mirrors this convergence and stays
close to the existing books enum's cardinality:

```
New with Tags (NWT), New without Tags (NWOT), Excellent Used (EUC), Good Used (GUC), Fair (visible wear)
```

covers the real vocabulary sellers actually use (Poshmark/reseller-community shorthand is the
dominant convention cited across every secondary source found) while staying a fixed 5-value CHECK
enum, structurally parallel to the existing 5-value book condition enum. This is a recommendation,
not the only valid mapping — the schema author should confirm against Preston's actual selling
platforms.

---

## 3. Typical clothing item attribute set

Consistently present across the tools/platforms researched:

| Attribute | Notes |
|---|---|
| **Brand** | Free text in every tool researched; no evidence of a controlled brand vocabulary/taxonomy in any consumer reseller tool — brand is user-entered string, sometimes autocompleted from a platform's own catalog at listing time (platform-side, not crosslister-side). |
| **Category / subcategory** | Hierarchical (e.g., Women's > Tops > T-Shirts). Each marketplace has its **own** category tree that a crosslister must map to — this is explicitly one of the "attributes missing in the Vendoo form" that must be filled per-platform ([Vendoo](https://help.vendoo.co/en/articles/6260272-how-to-list-the-vendoo-form)). For a single-seller custom app (not multi-marketplace-API-integrated), a simple internal category/subcategory pair is sufficient; do not attempt to mirror any one marketplace's full taxonomy. |
| **Size** | Stored **as-is** (brand's own size, e.g. "8," "M," "32x34"), not normalized to a universal scale — confirmed both by Vendoo's own admission that size doesn't reliably transfer between marketplace forms, and by the broader sizing-tech industry (True Fit, Sizebay, etc.) treating brand-to-brand size normalization as an unsolved, AI-assisted problem for retail, not something reseller tools attempt ([streetfightmag.com sizing tools survey](https://streetfightmag.com/2023/10/05/6-virtual-sizing-tools-for-fashion-retailers/)). **Recommendation: store brand + size-as-labeled as free text/short string, do not attempt a normalized numeric size scale** — no tool in this space does, and it would be a large, likely-wrong undertaking for a single-seller app. |
| **Color** | Free text or short controlled list; every tool has it as a distinct field from title/description. |
| **Material / fabric** | Free text (e.g., "100% cotton," "polyester blend"); sourced from garment label. Listed as a standard field across measurement/listing guides ([resellgenius.com apparel measurement templates](https://resellgenius.com/genius-portal/apparel-measurements-free-templates/)). |
| **Gender / department** | Standard cut across all platforms (Women's/Men's/Kids'/Unisex) — functions as a top-level category facet more than a standalone attribute. |
| **Measurements** | Flat-lay measurements, **laid flat, not full circumference** (reseller convention: state units + "laid flat, approx." explicitly, since a flat pit-to-pit of 21" implies ~42" full chest circumference) ([thetailoredco.com](https://www.thetailoredco.com/how-to-measure-clothes-for-selling/), [resellgenius.com](https://resellgenius.com/genius-portal/apparel-measurements-free-templates/)). Field set by garment type: <br>• **Tops**: pit-to-pit (chest), length (shoulder-to-hem), sleeve length <br>• **Bottoms**: waist, rise, inseam, leg opening (this exact set is called out as "most common on Poshmark") <br>• General: hip, shoulder width. Not every listing needs every measurement — the set is garment-type-dependent, which is itself a design signal (see §5 on satellite tables). |
| **Condition + noted flaws** | Condition grade (§2) plus free-text flaw notes — every serious reseller guide treats "condition grade + explicit flaw callouts" as a single conceptual unit, not two independent fields sellers fill separately by convention (though schema-wise they're naturally separate columns: enum + text). |
| **Care instructions** | Sometimes captured (from garment tag) but is a "nice to have," not consistently required across sources. |

**Photo count per listing** (min/max), directly relevant to clothing needing more photos than a book:

| Platform | Max photos | Source |
|---|---|---|
| Poshmark | 16 | [support.poshmark.com](https://support.poshmark.com/s/article/894455911) |
| eBay | 24 (interface signals a 40 rollout as of Apr 2026 but functional cap still 24 as of this research) | [Frooition](https://www.frooition.com/blog/ebay-sellers-can-now-add-up-to-24-photos-to-their-listings/), [valueaddedresource.net](https://www.valueaddedresource.net/ebay-expands-listings-photo-limit-40/) |
| Mercari | 12 | [Mercari Help — Creating a Listing](https://www.mercari.com/us/help_center/topics/listing/guides/creating-a-listing/) |
| Depop | 4 | [isopeel.com Depop photo guide](https://isopeel.com/guides/depop-photo-requirements/) |
| Vinted | 20 (practical sweet spot cited as 4–12; 5+ photos correlated with ~40% faster sell-through) | [Vinted Help — What photos you should upload](https://www.vinted.co.uk/help/48-what-photos-you-should-upload) |

Books in this app carry effectively 0–1 photo concern today (not currently modeled). Clothing needs
a real multi-photo model: **minimum useful floor across platforms is Depop's 4**; **the app-side
practical ceiling should be driven by the widest destination the seller actually uses (eBay's 24),
not by an arbitrary internal cap** — store an ordered list of photo references per item, not a fixed
number of photo columns.

---

## 4. Shipping weight/dimension conventions

Books in the current schema carry no weight field (out of scope for a system where cost estimation
wasn't sized around shipping). Clothing resale tooling and USPS pricing structure both treat weight
as first-class:

- **USPS Ground Advantage** (the standard reseller shipping product for lightweight apparel in poly
  mailers) prices in **ounce tiers under 1 lb**: up to 4 oz, up to 8 oz, up to 12 oz, up to 15.999 oz
  — a package weighing 4.2 oz is billed at the 8 oz rate (each tier is a ceiling, not a linear
  scale). Above 15.999 oz, packages round up to 1 lb and shift to per-pound pricing
  ([USPS Ground Advantage](https://www.usps.com/ship/ground-advantage.htm), rate breakdown via
  [goshippo.com](https://goshippo.com/blog/usps-parcel-select-ground-cost-sizes-and-how-it-works)).
  **Note a real upcoming break**: starting **2026-07-12** (i.e., tomorrow relative to this research
  date), USPS is **eliminating the 4-oz and 8-oz commercial tiers** — everything under 1 lb bills at
  the 12–15.99 oz rate regardless of actual weight. If cost-estimation logic is built against the
  current 4-tier structure, it will be stale within days; build the shipping-cost estimator against
  **whatever the live tier table is at implementation time**, not the figures in this document.
- Vendoo explicitly flags **shipping weight and shipping dimensions** as fields that do *not*
  reliably transfer/sync across its marketplace integrations even on paid plans — i.e., even mature
  tools treat this as a per-platform, mostly-manual entry, not a solved sync problem
  ([Vendoo help center](https://help.vendoo.co/en/articles/6260272-how-to-list-the-vendoo-form)).
- **Practical field set for a clothing item**: `weight_oz` (integer, ounces — matches USPS tier
  granularity and avoids float weight math, consistent with this app's existing "no floats" money
  convention) is sufficient for solo-reseller cost estimation; full L×W×H dimensions are typically
  only needed for oversized/bulky items (coats, boots, bundles) that exceed flat-rate/poly-mailer
  norms — consider making dimensions optional/nullable rather than required on every clothing row.

---

## 5. Architectural recommendation: multi-category schema pattern

### The three options, applied to this specific codebase

**Option A — Single table, nullable category-specific columns** (add `brand`, `size`, `color`,
`material`, `weight_oz`, `measurements_json`, ... directly onto `books`, renamed to `items`, all
nullable for non-clothing rows).
- Pro: no joins, one CHECK-constraint surface, minimal migration ceremony for the *first* new
  category.
  Con: **breaks two of this app's own hard-won invariants.** (1) The existing conditional-NOT-NULL
  CHECK pattern (`listing_price NOT NULL` when Listed, `sale_price/date/platform NOT NULL` when Sold
  — architecture-contract decision #8) already shows this codebase's CHECK constraints get complex
  fast; adding "author/publisher required if category=book, brand/size required if
  category=clothing" compounds that into a combinatorial CHECK-constraint nightmare, and
  **SQLite cannot ALTER a CHECK constraint** — every future 3rd category (electronics? collectibles?)
  requires the full create-new-table/copy/drop/rename protocol on an ever-wider, ever-sparser table.
  (2) Web research on this exact pattern (`signals.aktagon.com`, `dolthub.com` polymorphic-data
  writeups) independently confirms: nullable-column single-table designs "are impossible to
  constrain" cleanly and turn every read query into CASE-statement sprawl once you're past two
  categories.

**Option B — EAV (Entity-Attribute-Value)**: generic `item_id, attribute_name, attribute_value` rows.
- Pro: infinitely extensible without schema migrations.
  Con: **wrong tool here, decisively.** Research is unanimous and blunt: EAV "makes queries
  impossible to optimize and prevents meaningful constraints"; cited benchmark: unindexed EAV vs
  JSONB in PostgreSQL, JSONB **50,000x faster**
  ([bytebase.com database design patterns](https://www.bytebase.com/blog/database-design-patterns/),
  [dolthub.com](https://www.dolthub.com/blog/2024-06-25-polymorphic-associations/)). Also loses type
  safety (a `TEXT` value column can't enforce `weight_oz` is an integer) and defeats every one of
  this app's CHECK-constraint-based invariants outright. Reject for a two-category app.

**Option C — Base table + per-category satellite tables** (`items` holds everything common —
title/name, condition-ish fields split per category or kept common where truly shared, status,
acquisition_cost, acquisition_date, listing_price, sale fields, timestamps, category discriminator —
plus `book_details(item_id PK/FK, isbn, author, publisher)` and
`clothing_details(item_id PK/FK, brand, size_label, color, material, weight_oz, measurements...)`).
- Pro: matches the database-design literature's own recommendation for this exact scenario — "for
  most use cases, using separate tables is probably better than the single table approach... the
  'tagged union' approach with separate tables is the only one that can enforce every invariant
  without resorting to arbitrary CHECK expressions"
  ([signals.aktagon.com](https://signals.aktagon.com/articles/2025/09/choosing-a-database-schema-for-polymorphic-data-2024/)).
  Each satellite table gets its own clean CHECK constraints (clothing's condition enum lives on
  `clothing_details` or as a category-scoped CHECK, independent of books' condition enum — no more
  fighting over one shared enum). Adding a 3rd category later is *additive* (new satellite table +
  new CHECK constraints), not a rebuild of an ever-widening shared table — this directly avoids
  repeating the "SQLite can't ALTER CHECK, budget a rebuild" tax the architecture-contract already
  flags as a real cost (decision #8) on every future category addition instead of just once now.
  Con: every full item read is now a join (`items JOIN book_details` or `items JOIN
  clothing_details` depending on category); category-crossing queries (e.g., "all Sold items this
  month regardless of category") need `LEFT JOIN` both satellites or a `UNION`. This is a real but
  small cost at solo-reseller data volumes (the architecture contract already notes the DB has ~1
  row in it as of this research's baseline period) and is the same join cost every relational schema
  with 1:1 subtype tables pays — not a scaling trap at this app's actual scale.

### Recommendation: Option C (base table + per-category satellite tables), not A or B

**Why, concretely for this codebase**:

1. **It's additive, not destructive, on every future category.** The existing architecture
   contract's decision #8 already treats "enums are inline CHECK constraints, extending them means a
   full table rebuild" as a known, budgeted cost for *adding a status or condition value within one
   category*. Option A turns that same cost into "full rebuild of the shared items table" every time
   a new category is added, compounding forever. Option C confines category-specific schema
   evolution to a new, independent satellite table — the `items` base table and existing `books`-
   era CHECK constraints on shared fields (status, money) never need to move.

2. **It preserves the state machine and money invariants untouched.** `status`, the
   `ALLOWED_TRANSITIONS` machine in `lib/transitions.ts`, and the integer-cents money fields
   (`acquisition_cost`, `listing_price`, `sale_price`) are category-agnostic by nature — they belong
   on the base `items` table regardless of category, and Option C is the only one of the three that
   lets that base table stay narrow and keep its current, already-verified CHECK constraints and
   `assertTransitionAllowed` machinery completely unaffected by clothing's arrival. Option A would
   force those same CHECK constraints to coexist on a wider table alongside brand-new
   category-conditional NOT NULL rules, multiplying the constraint-leak risk the app's own
   failure-archaeology already tracks as a solved-but-hard-won problem (W1, constraint-leak HTTP 500
   cluster, FIXED 2026-07-03) — reopening a fixed risk class is a real cost, not a hypothetical one.

3. **It matches the `book_platforms` junction-table precedent already in this codebase.** The
   existing design already made the "don't cram varying-cardinality data into the parent row, model
   it as a related table" call once (platforms, decision #6, replacing a comma-separated column
   specifically because it made "multi-platform listing an untyped silent assumption"). Category
   attributes are the same shape of problem — Option C is the same design instinct applied
   consistently, not a new pattern to learn.

4. **Migration mechanics fit `better-sqlite3` + the existing migration file convention.** The
   existing `data/migrations/001_init.sql` already uses `CREATE TABLE IF NOT EXISTS` /
   `CREATE INDEX IF NOT EXISTS` idempotent style with no migration-version table (architecture
   contract decision #2). A new `002_..._clothing.sql`-style file adding `clothing_details` (and a
   `category` discriminator column + backfill on `items`/`books`) is a natural continuation of that
   convention; Option A or B would instead require touching the *existing* `books` table's CHECK
   constraints directly, which is exactly the operation flagged as expensive (rebuild protocol) in
   decision #8.

**Concrete shape to hand to the schema-migration session**:

```
items (
  id, category TEXT CHECK (category IN ('book','clothing')),
  title/name, condition ... [either kept per-category or a shared free-text + category-scoped CHECK],
  acquisition_cost, acquisition_date, status, listing_price,
  sale_price, sale_date, sale_platform, created_at, updated_at
  -- all existing CHECKs for status/money/dates stay here, unchanged
)
book_details (item_id PK/FK -> items.id, isbn, author, publisher)
clothing_details (
  item_id PK/FK -> items.id,
  brand, size_label, color, material,
  gender_department, weight_oz,
  pit_to_pit_in, length_in, sleeve_length_in, waist_in, rise_in, inseam_in, leg_opening_in, hip_in,
  condition TEXT CHECK (condition IN ('NWT','NWOT','EUC','GUC','Fair'))  -- clothing's own enum, independent of book condition
)
item_photos (id, item_id FK, url/path, sort_order)   -- new, per §3's photo-count finding
item_platforms (id, item_id FK, platform, listed_at)  -- rename of book_platforms, same shape, now category-agnostic
```

`condition` is deliberately shown living on the satellite table, not the base `items` table — the
current single shared `CHECK (condition IN (...))` on `books` is exactly the constraint that can't
serve two different vocabularies (§2's 5-value book enum vs. the 5-value NWT/NWOT/EUC/GUC/Fair
clothing enum) without becoming a 10-value CHECK with no way to say "only these 5 are valid for
books." Splitting it per-satellite-table is the direct schema consequence of Option C and should be
treated as part of the same decision, not a separate open question.

---

## Source list (all fetched/searched 2026-07-11)

- Vendoo listing form mechanics: https://help.vendoo.co/en/articles/6260272-how-to-list-the-vendoo-form
- Crosslist field-gathering behavior: https://crosslist.com/blog/listing-management-for-resellers/
- Crosslist supported marketplaces: https://crosslist.com/
- List Perfectly catalog features: https://www.threecolts.com/blog/best-cross-listing-app/
- OneShop auto-delist/relist behavior: https://tools.oneshop.com/blog/crosslisting-app
- GitHub reseller-tools topic (no credible FOSS crosslister found): https://github.com/topics/reseller-tools
- Mercari condition definitions: https://www.mercari.com/us/help_center/product-info/item-conditions/
- eBay pre-loved fashion condition update (2025): https://www.ebay.com/sellercenter/resources/seller-updates/2025-january/new-item-conditions
- Vinted condition definitions: https://www.vinted.com/help/50-choosing-item-condition
- Poshmark/reseller condition acronyms (NWT/NWOT/EUC/VGUC/GUC): https://www.buyitbeforeido.com/what-does-euc-nwt-nib-htf-nwot-mean/
- Poshmark official condition guidance: https://blog.poshmark.com/2014/06/19/posh-tip-how-to-describe-the-condition-of-your-item/
- TheRealReal condition scale: https://realstyle.therealreal.com/condition-in-luxury-resale/
- ThredUp condition ratings: https://help.thredup.com/en_us/what-are-the-different-item-conditions-you-sell-SJb2YZ05h
- Apparel measurement conventions (flat-lay, pit-to-pit, waist/rise/inseam): https://resellgenius.com/genius-portal/apparel-measurements-free-templates/, https://www.thetailoredco.com/how-to-measure-clothes-for-selling/
- Size normalization is unsolved industry-wide: https://streetfightmag.com/2023/10/05/6-virtual-sizing-tools-for-fashion-retailers/
- Poshmark photo limit (16): https://support.poshmark.com/s/article/894455911
- eBay photo limit (24, 40 rollout in progress): https://www.frooition.com/blog/ebay-sellers-can-now-add-up-to-24-photos-to-their-listings/, https://www.valueaddedresource.net/ebay-expands-listings-photo-limit-40/
- Mercari photo limit (12): https://www.mercari.com/us/help_center/topics/listing/guides/creating-a-listing/
- Depop photo limit (4): https://isopeel.com/guides/depop-photo-requirements/
- Vinted photo limit (20, practical range 4–12): https://www.vinted.co.uk/help/48-what-photos-you-should-upload
- USPS Ground Advantage weight tiers and 2026-07-12 tier elimination: https://www.usps.com/ship/ground-advantage.htm, https://goshippo.com/blog/usps-parcel-select-ground-cost-sizes-and-how-it-works
- Polymorphic schema design tradeoffs (satellite tables recommended over single-table/EAV): https://signals.aktagon.com/articles/2025/09/choosing-a-database-schema-for-polymorphic-data-2024/, https://www.dolthub.com/blog/2024-06-25-polymorphic-associations/, https://www.bytebase.com/blog/database-design-patterns/
- Zentail/Sellbrite/ChannelAdvisor centralized-catalog-with-channel-mapping architecture: https://www.zentail.com/, https://ecommerceguide.substack.com/p/the-10-best-multichannel-selling
