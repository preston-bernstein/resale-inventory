# Reseller/Crosslisting Architecture Research — Books-to-Clothing Generalization

**Purpose**: This document researches how existing crosslisting tools are built, then uses those
findings to guide a schema migration (a change to the app's database table structure) that adds
clothing to `resale-inventory`, an app that today handles only books. "Crosslisting" means posting
one item for sale across several marketplaces at once — eBay, Poshmark, Mercari, and so on — from a
single tool. This is domain research, not a decision about adopting a commercial tool: that decision
is already made. The plan is to extend the existing custom Next.js/SQLite app. Written 2026-07-11.

**Existing app baseline** (context for every recommendation below — see
`.claude/skills/resale-inventory-architecture-contract/SKILL.md` for full detail):

The app runs on Next.js 15 (a React web framework) and stores its data in a single SQLite file,
`data/inventory.db`, accessed through the `better-sqlite3` library. Every record's primary key is a
UUIDv4 — a randomly generated 36-character unique ID. Money is stored as integer cents everywhere,
never as decimal dollars. The `condition` and `status` fields are each restricted to a fixed list of
allowed values by an inline SQL `CHECK` constraint: a rule the database enforces on every write.
SQLite cannot alter an existing `CHECK` constraint, so changing the allowed values later means
rebuilding the whole table.

A `status` state machine — code in `lib/transitions.ts` that defines which status changes are
allowed — governs each item's lifecycle: `Unlisted → Listed → Sale Pending → Sold`, plus the
terminal states `Removed`, `Donated`, and `Discarded`.

Listings across multiple marketplaces are modeled with a `book_platforms` junction table (a table
that links two other tables together), with columns `book_id`, `platform`, and `listed_at`, instead
of packing platform names into one comma-separated column.

---

## 1. Existing crosslisting/reseller tools — architectural patterns worth stealing

### 1.1 The "one form, many marketplace adapters" pattern (Vendoo, Crosslist, OneShop)

Every commercial crosslisting tool uses the same shape: one master item record, filled out once,
that feeds into several platform-specific listing forms ("N" platforms — however many the seller
uses). Vendoo calls its master record the "Vendoo form." Sellers fill in common attributes once —
title, price, condition, brand, category, photos. Vendoo then carries that data into each
marketplace's own form and only asks for the fields unique to that marketplace, such as shipping
settings, category-specific taxonomy fields, or sizing quirks
([Vendoo help center](https://help.vendoo.co/en/articles/6260272-how-to-list-the-vendoo-form)).

Crosslist works the same way. A seller fills in every field needed across all target platforms once.
The app then auto-selects only what each destination requires and flags any missing required field
before posting ([Crosslist](https://crosslist.com/blog/listing-management-for-resellers/)).

**This confirms the app's existing `book_platforms` junction table is the right shape.** The industry
norm is "one core item plus a per-platform association" — not one row per platform, and not a
comma-separated list crammed into one column.

One gap remains, though. Every commercial tool treats per-platform listing state as a first-class
thing to track: whether a listing is currently live on that platform, its platform-specific price
(prices can differ by platform), and when it last synced. The current schema only tracks which
platforms an item is listed on, not that state.

Worth considering: should `book_platforms` (or its clothing-inclusive successor, e.g.
`item_platforms`) grow `platform_price_cents`, `platform_status`, and `synced_at` columns? Right now
the app assumes one global `listing_price` applies identically on every platform. That's an
intentional scope decision, not a defect — the app is single-price by design. But every
multi-platform resale tool researched disagrees with that assumption. Flag this for the migration
author.

### 1.2 A known field-fidelity failure mode: size doesn't transfer between marketplaces

Vendoo's own documentation admits: *"Oftentimes the size won't transfer between marketplaces."* It
also calls out **condition, shipping weight, and shipping dimensions** as inconsistent and often
manual across its integrations, even on paid business plans
([Vendoo help center](https://help.vendoo.co/en/articles/6260272-how-to-list-the-vendoo-form)).

This matters: even a mature commercial tool with a dedicated engineering team hasn't solved automatic
mapping of size or condition values across marketplaces. **Do not budget for a fully automatic
size/condition mapping layer.** Store the seller's own values as entered, and treat any future
platform-sync feature as inherently lossy at the edges.

### 1.3 List Perfectly — catalog-first, not listing-first

List Perfectly is built around a persistent "LP Catalog" — a record of SKU (stock-keeping unit, the
seller's own item identifier), quantity, profit calculation, and tags/groups by price, size, shipping
type, or custom category. Crosslisting is an operation performed *on* catalog rows; the catalog is
not generated *from* listings
([List Perfectly features summary via Threecolts](https://www.threecolts.com/blog/best-cross-listing-app/)).

This matches how the existing app already works: the `books` table is the source of truth, and
listings are a derived, attached concept. Keep that framing for clothing. Don't invert it.

### 1.4 No credible open-source/self-hosted crosslisting tool exists

This research searched GitHub directly — the `github.com/topics/reseller-tools` topic page, plus
keyword searches for "open source reseller crosslisting," "self-hosted marketplace listing tool," and
"open source inventory reseller dashboard." Findings:

- The `github.com/topics/reseller-tools` page surfaces only toy or personal projects: `buy-sell` (a
  PHP resale purchase/sale tracker with profit analytics, **1 star**) and `reseller-dashboard`
  ("Hyperdriveflips Inventory Dashboard – Built from Scratch," **1 star**). It also surfaces several
  scraper utilities — Mercari sold-comps scraping, Bonanza listing scraping — but those extract data;
  they don't manage listings or inventory.
- Mature general-purpose open-source inventory systems exist — **InvenTree**, ERPNext, Dolibarr — but
  they're built for warehouses and ERP (enterprise resource planning) use, not resale marketplaces.
  None has a concept of per-platform listing, condition grading, or marketplace fee modeling.
- No project found with meaningful stars, active maintenance, or marketplace-crosslisting scope.

**This is a real finding, not a failed search.** The entire reseller-crosslisting category is
commercial SaaS (software as a service) only. There is no free/open-source (FOSS) prior art to borrow
code or schema from — just the commercial products' documented behavior (above) and the general
e-commerce data-modeling literature (§5). That raises the stakes of getting the schema right the
first time: there's no open reference implementation to fall back on if the custom design has gaps.

### 1.5 Enterprise multichannel tools (Zentail, Sellbrite, ChannelAdvisor) — same pattern, bigger scale

Zentail, Sellbrite (GoDaddy), and ChannelAdvisor (Rithum) all confirm the same architecture at
enterprise scale: one master product/catalog record, mapped and translated per destination channel,
with centralized inventory sync to prevent overselling ([Zentail](https://www.zentail.com/),
summarized via
[ecommerceguide.substack.com](https://ecommerceguide.substack.com/p/the-10-best-multichannel-selling)).

This doesn't contradict §1.1 — it's the same "canonical entity plus channel adapters" shape, scaled
up to Amazon/Walmart/Target-level catalog complexity. That's useful confirmation: the pattern holds
from solo-reseller scale to enterprise scale. This isn't a toy pattern.

---

## 2. Condition grading vocabularies — real per-platform terms

The books condition field today is a fixed `CHECK` constraint with these values: `Poor, Acceptable,
Good, Very Good, Like New`. Clothing needs its own vocabulary. Platforms do **not** share one
condition vocabulary with each other:

| Platform | Condition terms (official) | Source |
|---|---|---|
| **Mercari** | New (NWT/sealed) · Like New (NWOT, lightly used, no tags) · Good (gently worn, minor flaws — pilling/stretching/fading/loose threads, still wearable) · Fair (multiple wear signs — small rips/stains/fading/heavy pilling, still wearable) · Poor (heavily worn, major flaws/damage, parts/repair only) | [Mercari Help Center](https://www.mercari.com/us/help_center/product-info/item-conditions/) |
| **eBay** (2025 pre-loved fashion update) | New with tags · New without tags · New with imperfections (brand new, unworn, has a defect) · **Pre-owned – Excellent** · **Pre-owned – Good** · **Pre-owned – Fair** | [eBay Seller Center, Jan 2025 update](https://www.ebay.com/sellercenter/resources/seller-updates/2025-january/new-item-conditions), [eBay community announcement](https://community.ebay.com/t5/Seller-Update-January-2025/Introducing-new-conditions-for-pre-loved-clothing/td-p/34908723) |
| **Vinted** | New with tags (tags/packaging intact, unused) · New without tags (unused, no tags/packaging) · Very good (worn a few times, slight imperfections clearly disclosed) · Good (worn frequently, visible wear disclosed) · Satisfactory (heavily used, defects disclosed) | [Vinted Help — Choosing item condition](https://www.vinted.com/help/50-choosing-item-condition) |
| **Poshmark** (community convention, not a fixed dropdown enum) | NWT (New With Tags — tags attached, unworn, unwashed) · NWOT (New Without Tags — tags removed/lost but unworn) · EUC (Excellent Used Condition — worn a handful of times, minimal wear, no major flaws) · VGUC (Very Good Used Condition — minor flaws: pilling, discoloration, weak zipper/buttonhole) · GUC (Good Used Condition — obvious but non-structural flaws, still wearable) | [buyitbeforeido.com acronym guide](https://www.buyitbeforeido.com/what-does-euc-nwt-nib-htf-nwot-mean/), [Poshmark Blog — describing condition](https://blog.poshmark.com/2014/06/19/posh-tip-how-to-describe-the-condition-of-your-item/) |
| **TheRealReal** (luxury consignment, 6-tier internal scale) | Pristine (identical/near-identical to new, incl. original box/dust bag/accessories) · ... · Fair (significant wear, may need minor repairs) · As-Is (extensive wear, requires repair to be functional/presentable) — full 6-tier scale not fully published, but anchors and low end confirmed | [TheRealReal — Role of Condition in Luxury Resale](https://realstyle.therealreal.com/condition-in-luxury-resale/) |
| **ThredUp** | Uses standardized internal condition ratings applied by ThredUp's own graders (centralized marketplace model — sellers don't self-grade at listing time the way they do on peer-to-peer platforms); exact tier labels not published in searchable help content as of this research pass | [ThredUp Help Center](https://help.thredup.com/en_us/what-are-the-different-item-conditions-you-sell-SJb2YZ05h) |

**Cross-platform convergence pattern** — this is the actual signal to design from. Every platform
splits condition into two tiers: **unworn** (with a tags-on/tags-off split: NWT vs. NWOT) and
**worn**. The worn tier is consistently 3 grades, best/middle/worst: "Excellent/Good/Fair," "Very
good/Good/Satisfactory," "Like New/Good/Fair."

A **5-value clothing condition enum** mirrors this convergence and stays close to the existing books
enum's size (it also has 5 values):

```
New with Tags (NWT), New without Tags (NWOT), Excellent Used (EUC), Good Used (GUC), Fair (visible wear)
```

This set covers the vocabulary sellers actually use — Poshmark/reseller-community shorthand is the
dominant convention across every secondary source found — while staying a fixed 5-value `CHECK` enum,
structurally parallel to the existing 5-value book condition enum. This is a recommendation, not the
only valid mapping. The schema author should confirm it against Preston's actual selling platforms.

---

## 3. Typical clothing item attribute set

Consistently present across the tools/platforms researched:

| Attribute | Notes |
|---|---|
| **Brand** | Free text in every tool researched. No evidence of a controlled brand vocabulary/taxonomy in any consumer reseller tool — brand is a user-entered string, sometimes autocompleted from a platform's own catalog at listing time (on the platform's side, not the crosslister's). |
| **Category / subcategory** | Hierarchical (e.g., Women's > Tops > T-Shirts). Each marketplace has its **own** category tree that a crosslister must map to. This is explicitly one of the fields missing from the Vendoo form that must be filled in per platform ([Vendoo](https://help.vendoo.co/en/articles/6260272-how-to-list-the-vendoo-form)). For a single-seller custom app — one not integrated with each marketplace's API — a simple internal category/subcategory pair is enough. Don't try to mirror any one marketplace's full taxonomy. |
| **Size** | Stored **as-is** — the brand's own size label, e.g. "8," "M," "32x34" — not normalized to a universal scale. Two things confirm this: Vendoo admits size doesn't reliably transfer between marketplace forms, and the broader sizing-tech industry (True Fit, Sizebay, etc.) treats brand-to-brand size normalization as an unsolved, AI-assisted retail problem, not something reseller tools attempt ([streetfightmag.com sizing tools survey](https://streetfightmag.com/2023/10/05/6-virtual-sizing-tools-for-fashion-retailers/)). **Recommendation: store brand plus size-as-labeled as a free-text/short string. Do not attempt a normalized numeric size scale.** No tool in this space does, and building one would be a large, likely-wrong undertaking for a single-seller app. |
| **Color** | Free text or short controlled list; every tool has it as a distinct field from title/description. |
| **Material / fabric** | Free text (e.g., "100% cotton," "polyester blend"); sourced from garment label. Listed as a standard field across measurement/listing guides ([resellgenius.com apparel measurement templates](https://resellgenius.com/genius-portal/apparel-measurements-free-templates/)). |
| **Gender / department** | Standard cut across all platforms (Women's/Men's/Kids'/Unisex) — functions as a top-level category facet more than a standalone attribute. |
| **Measurements** | Flat-lay measurements: **laid flat, not full circumference**. Reseller convention is to state units plus "laid flat, approx." explicitly, since a flat pit-to-pit measurement of 21" implies roughly 42" full chest circumference ([thetailoredco.com](https://www.thetailoredco.com/how-to-measure-clothes-for-selling/), [resellgenius.com](https://resellgenius.com/genius-portal/apparel-measurements-free-templates/)). Which fields matter depends on garment type: <br>• **Tops**: pit-to-pit (chest), length (shoulder-to-hem), sleeve length <br>• **Bottoms**: waist, rise, inseam, leg opening (this exact set is called out as "most common on Poshmark") <br>• General: hip, shoulder width. Not every listing needs every measurement. That the set depends on garment type is itself a design signal (see §5 on satellite tables). |
| **Condition + noted flaws** | Condition grade (§2) plus free-text flaw notes. Every serious reseller guide treats "condition grade + explicit flaw callouts" as one conceptual unit that sellers fill in together by convention — even though, in the schema, they're naturally two separate columns: an enum and a text field. |
| **Care instructions** | Sometimes captured (from garment tag) but is a "nice to have," not consistently required across sources. |

**Photo count per listing** (min/max), directly relevant to clothing needing more photos than a book:

| Platform | Max photos | Source |
|---|---|---|
| Poshmark | 16 | [support.poshmark.com](https://support.poshmark.com/s/article/894455911) |
| eBay | 24 (interface signals a 40 rollout as of Apr 2026 but functional cap still 24 as of this research) | [Frooition](https://www.frooition.com/blog/ebay-sellers-can-now-add-up-to-24-photos-to-their-listings/), [valueaddedresource.net](https://www.valueaddedresource.net/ebay-expands-listings-photo-limit-40/) |
| Mercari | 12 | [Mercari Help — Creating a Listing](https://www.mercari.com/us/help_center/topics/listing/guides/creating-a-listing/) |
| Depop | 4 | [isopeel.com Depop photo guide](https://isopeel.com/guides/depop-photo-requirements/) |
| Vinted | 20 (practical sweet spot cited as 4–12; 5+ photos correlated with ~40% faster sell-through) | [Vinted Help — What photos you should upload](https://www.vinted.co.uk/help/48-what-photos-you-should-upload) |

Books in this app carry, at most, one photo today — photos aren't really modeled as a feature yet.
Clothing needs a real multi-photo model. **The minimum useful floor across platforms is Depop's 4.**
**The app-side practical ceiling should be driven by the widest destination the seller actually uses
(eBay's 24), not by an arbitrary internal cap.** Store an ordered list of photo references per item,
not a fixed number of photo columns.

---

## 4. Shipping weight/dimension conventions

Books in the current schema carry no weight field — shipping cost estimation was never built into
this system. Clothing resale tooling, and USPS's own pricing structure, both treat weight as a
first-class attribute:

- **USPS Ground Advantage** is the standard reseller shipping product for lightweight apparel in poly
  mailers. It prices in **ounce tiers under 1 lb**: up to 4 oz, up to 8 oz, up to 12 oz, up to
  15.999 oz. Each tier is a ceiling, not a linear scale — a package weighing 4.2 oz is billed at the
  8 oz rate. Above 15.999 oz, packages round up to 1 lb and shift to per-pound pricing
  ([USPS Ground Advantage](https://www.usps.com/ship/ground-advantage.htm), rate breakdown via
  [goshippo.com](https://goshippo.com/blog/usps-parcel-select-ground-cost-sizes-and-how-it-works)).

  **Note a real upcoming change**: starting **2026-07-12** — tomorrow, relative to this research's
  date — USPS is **eliminating the 4-oz and 8-oz commercial tiers**. Everything under 1 lb will bill
  at the 12–15.99 oz rate regardless of actual weight. If cost-estimation logic is built against the
  current 4-tier structure, it will be stale within days. Build the shipping-cost estimator against
  **whatever the live tier table is at implementation time**, not the figures in this document.
- Vendoo explicitly flags **shipping weight and shipping dimensions** as fields that do *not*
  reliably transfer or sync across its marketplace integrations, even on paid plans. Even a mature
  tool treats this as a per-platform, mostly-manual entry — not a solved sync problem
  ([Vendoo help center](https://help.vendoo.co/en/articles/6260272-how-to-list-the-vendoo-form)).
- **Practical field set for a clothing item**: `weight_oz` — an integer, in ounces, matching USPS
  tier granularity and avoiding float weight math (consistent with this app's existing "no floats"
  money convention) — is enough for solo-reseller cost estimation. Full length x width x height
  (L×W×H) dimensions are typically only needed for oversized or bulky items (coats, boots, bundles)
  that exceed flat-rate/poly-mailer norms. Consider making dimensions optional/nullable rather than
  required on every clothing row.

---

## 5. Architectural recommendation: multi-category schema pattern

### The three options, applied to this specific codebase

**Option A — single table, nullable category-specific columns.** Add `brand`, `size`, `color`,
`material`, `weight_oz`, `measurements_json`, and so on directly onto `books` (renamed to `items`),
all nullable for non-clothing rows.

*Pro*: no joins, one `CHECK`-constraint surface, minimal migration work for the *first* new category.

*Con*: this breaks two of the app's own hard-won invariants (rules the app depends on staying true).

1. The existing conditional-NOT-NULL `CHECK` pattern already shows this codebase's `CHECK`
   constraints get complex fast — for example, `listing_price NOT NULL` when Listed,
   `sale_price`/`date`/`platform` NOT NULL when Sold (architecture-contract decision #8). Adding
   "author/publisher required if category=book, brand/size required if category=clothing" compounds
   that into a combinatorial `CHECK`-constraint nightmare. And **SQLite cannot alter a `CHECK`
   constraint** — every future third category (electronics? collectibles?) would require the full
   create-new-table/copy/drop/rename protocol, on a table that gets wider and sparser each time.
2. Web research on this exact pattern (`signals.aktagon.com`, `dolthub.com` polymorphic-data
   writeups) independently confirms it: nullable-column single-table designs "are impossible to
   constrain" cleanly, and turn every read query into `CASE`-statement sprawl once you're past two
   categories.

**Option B — EAV (Entity-Attribute-Value)**: generic `item_id, attribute_name, attribute_value` rows,
one row per attribute instead of one column per attribute.

*Pro*: infinitely extensible without schema migrations.

*Con*: the wrong tool here, decisively. Research is unanimous and blunt: EAV "makes queries
impossible to optimize and prevents meaningful constraints." One cited benchmark: unindexed EAV vs.
JSONB in PostgreSQL — JSONB was **50,000x faster**
([bytebase.com database design patterns](https://www.bytebase.com/blog/database-design-patterns/),
[dolthub.com](https://www.dolthub.com/blog/2024-06-25-polymorphic-associations/)). EAV also loses
type safety — a `TEXT` value column can't enforce that `weight_oz` is an integer — and it defeats
every one of this app's `CHECK`-constraint-based invariants outright. Reject it for a two-category
app.

**Option C — base table + per-category satellite tables.** `items` holds everything common:
title/name, condition-related fields (split per category, or kept common where truly shared), status,
acquisition_cost, acquisition_date, listing_price, sale fields, timestamps, and a category
discriminator (a column that says which category a row belongs to). Category-specific fields live in
their own tables: `book_details(item_id PK/FK, isbn, author, publisher)` and
`clothing_details(item_id PK/FK, brand, size_label, color, material, weight_oz, measurements...)`.

*Pro*: this matches the database-design literature's own recommendation for this exact scenario.
"For most use cases, using separate tables is probably better than the single table approach... the
'tagged union' approach with separate tables is the only one that can enforce every invariant without
resorting to arbitrary CHECK expressions"
([signals.aktagon.com](https://signals.aktagon.com/articles/2025/09/choosing-a-database-schema-for-polymorphic-data-2024/)).

Each satellite table gets its own clean `CHECK` constraints. Clothing's condition enum can live on
`clothing_details`, independent of the books condition enum — no more fighting over one shared enum.
Adding a third category later is *additive*: a new satellite table plus new `CHECK` constraints, not
a rebuild of an ever-widening shared table. This avoids repeating, for every future category, the
"SQLite can't alter a `CHECK` constraint, budget a rebuild" tax the architecture contract already
flags as a real cost (decision #8).

*Con*: every full item read now needs a join (`items JOIN book_details` or `items JOIN
clothing_details`, depending on category). Queries that cross categories — "all Sold items this month
regardless of category" — need a `LEFT JOIN` on both satellites, or a `UNION`. This is a real cost,
but a small one at solo-reseller data volumes (the architecture contract notes the DB holds about 1
row as of this research's baseline period). It's the same join cost every relational schema with 1:1
subtype tables pays — not a scaling trap at this app's actual scale.

### Recommendation: Option C (base table + per-category satellite tables), not A or B

**Why, concretely for this codebase**:

1. **It's additive, not destructive, for every future category.** The architecture contract's
   decision #8 already treats "enums are inline `CHECK` constraints; extending them means a full
   table rebuild" as a known, budgeted cost — but only for *adding a status or condition value within
   one category*. Option A turns that same cost into "rebuild the whole shared items table," and
   pays it again every time a new category is added. Option C confines category-specific schema
   changes to a new, independent satellite table. The `items` base table, and the existing
   `books`-era `CHECK` constraints on shared fields like status and money, never need to move.

2. **It leaves the state machine and money invariants untouched.** `status`, the
   `ALLOWED_TRANSITIONS` machine in `lib/transitions.ts`, and the integer-cents money fields
   (`acquisition_cost`, `listing_price`, `sale_price`) don't care what category an item belongs to —
   they belong on the base `items` table regardless. Option C is the only one of the three options
   that lets that base table stay narrow, with its current, already-verified `CHECK` constraints and
   `assertTransitionAllowed` logic completely unaffected by clothing's arrival. Option A would force
   those same `CHECK` constraints to coexist on a wider table, alongside brand-new
   category-conditional NOT NULL rules. That multiplies the constraint-leak risk the app's own
   failure-archaeology already tracks as a solved, hard-won problem (W1: constraint-leak HTTP 500
   cluster, fixed 2026-07-03). Reopening a fixed risk class is a real cost, not a hypothetical one.

3. **It matches the `book_platforms` junction-table precedent already in this codebase.** The
   existing design already made this call once, for platforms: don't cram varying-cardinality data
   into the parent row, model it as a related table (decision #6). That decision replaced a
   comma-separated column specifically because it made "multi-platform listing an untyped silent
   assumption." Category attributes are the same shape of problem. Option C applies the same design
   instinct consistently — it's not a new pattern to learn.

4. **Migration mechanics fit `better-sqlite3` and the existing migration-file convention.** The
   existing `data/migrations/001_init.sql` already uses an idempotent `CREATE TABLE IF NOT EXISTS` /
   `CREATE INDEX IF NOT EXISTS` style, with no migration-version table (architecture contract
   decision #2). A new `002_..._clothing.sql`-style file — adding `clothing_details`, plus a
   `category` discriminator column and backfill on `items`/`books` — continues that convention
   naturally. Option A or B would instead require touching the *existing* `books` table's `CHECK`
   constraints directly: exactly the expensive rebuild-protocol operation decision #8 flags.

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

`condition` is deliberately shown living on the satellite table, not the base `items` table. The
current single shared `CHECK (condition IN (...))` on `books` cannot serve two different
vocabularies — §2's 5-value book enum and the 5-value NWT/NWOT/EUC/GUC/Fair clothing enum — without
becoming a 10-value `CHECK` with no way to say "only these 5 are valid for books." Splitting
`condition` per satellite table is the direct schema consequence of Option C. Treat it as part of the
same decision, not a separate open question.

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
