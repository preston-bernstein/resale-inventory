---
name: resale-inventory-research-frontier
description: Open problems where resale-inventory (formerly resale-inventory) could grow beyond maintenance - pricing intelligence, sale-event ingestion, search at scale (durability automation shipped 2026-07-03 - see item 3 for what remains) - each with why current practice fails, the repo's specific asset, first three steps, and a falsifiable done-milestone. Includes the external-positioning brief (what is and is not novel). Use when asked "what next", "roadmap", "pricing feature", "new capability", "is this novel/publishable", or before proposing a feature direction.
---

# Book-Seller — Research Frontier

## Positioning first (external-positioning brief, merged)

This skill also serves as the project's external-positioning statement; the repo is too thin to justify a standalone positioning skill — that is a deliberate merge, stated here so nobody goes looking for a sibling.

**What is genuinely here:** a spec-first, money-safe (integer cents, computed-never-stored derivations), state-machine-disciplined multi-category (books + clothing) inventory core with a complete audit trail: every price change (`price_history`), every sale outcome (`sale_price/sale_platform/sale_date` locked at Sold), acquisition cost and condition per item, photo-forward UI, dark mode, and a hardened test/QA posture (Vitest + Playwright E2E + Stryker mutation testing + strict coverage thresholds). None of that expands the frontier below — it's execution quality on the existing scope, not a new asset.

**What is NOT novel and must never be claimed as such:** CRUD on SQLite, CSV import/export, ISBN lookup, a Next.js dashboard, multi-category support, a photo grid, dark mode. Nothing in this repo advances any state of the art today.

**What may become an asset:** the accumulating local dataset linking *acquisition cost + condition + listing-price trajectory + platform + realized sale outcome* per item. Marketplaces show sellers competitor asks; they do not hand back your own cost-conditioned realized-outcome history in analyzable form. A sole seller who records faithfully ends up with a private comps dataset. That is a data asset, not an algorithmic one — and it is EMPTY today (see the sufficiency measurement below; still true — the real DB holds exactly one "Test Book" fixture row, no real sales recorded yet).

**Claim discipline:** nothing below may be stated as delivered or superior until its falsifiable milestone is met and reproducible (seeded scratch DB + scripted scenario). Everything below is CANDIDATE/OPEN — except item 3, which shipped (see item 3).

## Frontier item 1 — Pricing intelligence (CANDIDATE)

Explicitly deferred by the spec: requirements.md Out of scope — "Book valuation / market price recommendations (a separate pricing feature)."

**Why current practice fails:** commercial repricers optimize against competitor list prices; they are blind to *your* acquisition cost, *your* condition mix, and *your* realized sell-through velocity. Pricing to undercut the lowest ask can be strictly worse than pricing against your own cost-conditioned outcome history.

**This repo's asset:** `price_history` + Sold rows already capture exactly the variables a cost-aware policy needs. Gross-profit-per-day-held is computable from existing columns (sale_price, acquisition_cost, acquisition_date, sale_date).

**First three steps in this repo:**
1. *Data sufficiency instrument* (read-only, runnable today; updated for the multi-category schema — `books` → `items` joined to `book_details`, `book_id` → `item_id`):
```bash
sqlite3 "file:data/inventory.db?mode=ro" "SELECT COUNT(*) FROM items i JOIN book_details b ON b.item_id = i.id WHERE i.status='Sold' AND i.sale_price IS NOT NULL AND i.acquisition_cost IS NOT NULL AND b.condition IS NOT NULL AND i.sale_date IS NOT NULL; SELECT COUNT(DISTINCT item_id) FROM price_history;"
```
Still `0` and `0` as of this refresh (2026-07-12) — the real DB holds only the one "Test Book" fixture, never sold. That IS the current finding — the instrument exists before the data. Re-run monthly; nothing downstream starts before ~30 sold rows.
2. *Sold-comps export* (spec-gated proposal via `resale-inventory-change-control`): a view/route exporting per-sold-item: condition, acquisition_cost, first/last listing price, days held, sale_price, platform, gross profit — now applicable to clothing via `clothing_details` too, not just books.
3. *Offline baseline heuristic*, evaluated by backtest on a scratch copy — e.g., "price at median of own past sale prices for the same condition, floor at cost + margin." No production code until the milestone.

**You have a result when:** on ≥30 recorded sales, the heuristic's backtested gross-profit-per-day-held beats the naive baseline (median own-history listing price, condition-blind) by a pre-registered margin (predict the number before running — `resale-inventory-analysis-and-methodology`). **Blocked by:** real data accumulation; honest sale recording requires the two-step Sale Pending→Sold flow to be ergonomic (AC3 dispute SR-6, still OWNER-DECISION-PENDING). The import-trustworthiness blocker (D2) is RESOLVED — the constraint-leak campaign fixed it 2026-07-03 — so that part of the blocker list is clear; AC3/SR-6 remains open.

## Frontier item 2 — Sale-event ingestion from platform reports (CANDIDATE)

Spec posture: requirements.md Out of scope — "Automated ingestion of sale events from platform APIs." — but Constraints allow "either via manual operator entry or an import mechanism". Report-file ingestion (CSV the operator downloads from the platform) threads that needle without API integration.

**Why manual entry fails at scale:** each sale needs status transition + three sale fields; at tens of sales/month, operators batch and forget, and the outcome data that item 1 depends on rots.

**First three steps:** (1) obtain one real platform report sample (OWNER DEPENDENCY — formats are account-specific; do not guess the schema); (2) spec a mapping from report rows to the status API respecting the state machine — rows arriving as "sold" for an item in `Listed` must route Listed→Sale Pending→Sold or trigger the owner's AC3 decision (SR-6) — this feature is likely what forces that decision; (3) build it as an import-style adapter with per-row errors (FR22 pattern). D2 (the blocker that made import untrustworthy) is now FIXED — that prerequisite is clear; this item is no longer blocked on import trustworthiness, only on obtaining a real report sample and the AC3/SR-6 decision.

**You have a result when:** one genuine platform report imports on a scratch copy with per-row error reporting, zero invalid transitions, and dashboard/export totals reconciling with the report's own totals.

## Frontier item 3 — Durability automation (SHIPPED — 2026-07-03; no longer open)

plan.md Risk 6 specified a startup backup routine (copy to `data/backups/`, keep last 7). This was the "do this first" item and it has been done: `lib/backup.ts` implements `runStartupBackup`, called from `lib/db.ts` on every boot, using better-sqlite3's online-backup API (`db.backup()` — WAL-safe, unlike a naive file copy, per the finding recorded in `docs/research-durability-automation.md`), writing `data/backups/inventory-YYYYMMDD.db`, deduplicated to one snapshot per calendar day, pruned to the newest 7. It also correctly no-ops during `next build` (checks `NEXT_PHASE`) so build workers don't race on the destination file, and it swallows its own errors so a backup failure never blocks server boot. DR-2 (the failure-archaeology entry tracking this gap) is closed.

Restore procedure is documented as an OWNER-ONLY action in `resale-inventory-run-and-operate` (its "## Restore" section). Do not re-propose implementing the backup routine — it's done.

**Original done-milestone (met):** 7 dated backups rotate automatically across restarts. ✓ Verified by reading `lib/backup.ts`'s `RETENTION = 7` and `prune()` logic.

## Frontier item 4 — Search at scale (FENCED: measure first; query-quality layer SHIPPED 2026-07-12)

plan.md (data-model SQL comment) originally noted: "full-text search handled by LIKE queries; upgrade to FTS5 if needed at scale". The shipped migrations still carry no FTS5 objects — `data/migrations/003_multi_category.sql` carries the current NOCASE indexes: `idx_items_title` on `items(title COLLATE NOCASE)` and `idx_clothing_details_brand` on `clothing_details(brand COLLATE NOCASE)` (books no longer have a separate author index at this layer — `book_details` has no NOCASE index on `author` as of migration 003; worth a quick check before relying on that specifically).

**Fence still applies to the storage/indexing layer:** LIKE + NOCASE indexes are almost certainly fine for a sole seller's thousands of rows. Do not build FTS5 on vibes.

**What shipped 2026-07-12 (query-quality, not scale):** `q` search was ported from the estate-scraper project's `lib/thesaurus.ts` pattern — `lib/searchExpand.ts` provides `expandQuery()` (curated synonym-group expansion, e.g. "coat" ↔ "jacket" ↔ "blazer"; multi-word entries matched via adjacent-term bigrams) and `escapeLike()` (escapes `%`/`_`/`\` so a literal wildcard char in a query can't act as one). `app/api/items/route.ts`'s `GET` handler tokenizes `q`, expands each token, and OR-matches every expanded term against `i.title`, `bd.author`, `bd.publisher`, `bd.isbn`, `cd.brand`, `cd.color`, `cd.material`, `cd.gender_department`, `cd.size_label` — closing the prior gap where clothing items matched on title only (author/brand/etc. were silently unsearched). No embeddings/semantic layer was ported — estate-scraper's Phase 2 hybrid search ranks *image* embeddings against a text query embedding (SigLIP), which has no analog here (this app has no vision-classified corpus to rank against); only the lexical Phase 1 pattern (thesaurus + escaping + multi-field) was portable. Still no relevance ranking — results stay ordered by `created_at DESC`; that would be the next increment if ever needed. Tests: `lib/__tests__/searchExpand.test.ts` (expansion/escaping unit tests) + `tests/api/items.test.ts` (multi-field, synonym, multi-term, and escaping integration tests).

**Remaining scale question (still fenced):** (1) benchmark proposal: seed a SCRATCH-COPY DB (never the real one) with 10k synthetic rows across both categories, measure `GET /api/items?q=...` p95 now that the WHERE clause is wider (more OR branches per query term); (2) only if p95 exceeds a pre-registered threshold (e.g., 200 ms locally) does an FTS5 spec go to change-control (it is a schema change — table-rebuild rules apply).

**You have a result when:** measured p95 at a realistic row count crosses the pre-registered threshold — that is the license to build FTS5, not the build itself.

## Priority guidance

Original order was: 3 (durability) → unblock 1&2's prerequisites (D2 fix via the campaign; AC3 owner decision) → 2 (starts the data flywheel) → 1 (needs the data) → 4 (only if measurement demands). **Item 3 has shipped** and D2 is fixed, so the current state is: remaining prerequisite is the AC3/SR-6 owner decision (still open) → 2 (starts the data flywheel, needs a real platform report sample — OWNER DEPENDENCY) → 1 (needs the data item 2 would generate) → 4 (only if measurement demands, still fenced — real row count is still 1).

## When NOT to use this skill

- Fixing live defects → `resale-inventory-constraint-leak-campaign` / `resale-inventory-debugging-playbook`.
- Whether/how to gate a new feature → `resale-inventory-change-control`.
- Experiment discipline (pre-registered predictions, refutation) → `resale-inventory-analysis-and-methodology`.
- What the domain terms mean → `bookselling-domain-reference`.

## Provenance and maintenance

Authored 2026-07-02, content-refreshed 2026-07-12 to reflect: item 3 (durability automation) SHIPPED 2026-07-03; the constraint-leak campaign (D1-D4) fully FIXED, clearing D2 as a blocker on item 2; the schema/routes migrated from `books`/`app/api/books/**` to `items`+`book_details`+`clothing_details`/`app/api/items/**`; item 4's query-quality layer (synonym expansion + LIKE-escaping + multi-field match) SHIPPED same day, ported from the estate-scraper project's thesaurus pattern. Verified this pass: sufficiency query output (still 0/0) against the current schema; out-of-scope quotes now at requirements.md lines 56 and 60 (line numbers drift — always re-grep, don't trust cached line numbers); FTS5 comment status in plan.md vs. the shipped migrations (still absent from shipped SQL); NOCASE indexes in `data/migrations/003_multi_category.sql` (the live index set, not `001_init.sql` which is now dead/archived-table code); `lib/searchExpand.ts` exists and is wired into `app/api/items/route.ts`'s GET handler (read both files directly to re-verify, don't trust this note past its date).

Re-verify:
- Sufficiency counts (the flywheel gauge): the sqlite one-liner in item 1 (uses `items`/`book_details`, not `books`).
- Out-of-scope stance unchanged: `grep -n "valuation\|Automated ingestion" docs/book-inventory-management/requirements.md` (re-check the line numbers each time, they've already drifted once).
- Backup routine status: `cat lib/backup.ts` (expect it to exist and implement `runStartupBackup` — if this file is ever missing, item 3 has regressed, which would be a significant finding).
- AC3/SR-6 still open: check `resale-inventory-failure-archaeology` SR-6 status.
- D1-D4 all FIXED: `grep -n "^| D[1-4] " .claude/skills/resale-inventory-failure-archaeology/SKILL.md`.
- Priorities: re-rank whenever a milestone lands; update this file and its date.
