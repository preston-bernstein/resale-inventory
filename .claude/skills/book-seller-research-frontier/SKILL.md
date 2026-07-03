---
name: book-seller-research-frontier
description: Open problems where book-seller could grow beyond maintenance - pricing intelligence, sale-event ingestion, durability automation, search at scale - each with why current practice fails, the repo's specific asset, first three steps, and a falsifiable done-milestone. Includes the external-positioning brief (what is and is not novel). Use when asked "what next", "roadmap", "pricing feature", "new capability", "is this novel/publishable", or before proposing a feature direction.
---

# Book-Seller — Research Frontier

## Positioning first (external-positioning brief, merged)

This skill also serves as the project's external-positioning statement; the repo is too thin to justify a standalone positioning skill — that is a deliberate merge, stated here so nobody goes looking for a sibling.

**What is genuinely here (2026-07-02):** a spec-first, money-safe (integer cents, computed-never-stored derivations), state-machine-disciplined inventory core with a complete audit trail: every price change (`price_history`), every sale outcome (`sale_price/sale_platform/sale_date` locked at Sold), acquisition cost and condition per physical book.

**What is NOT novel and must never be claimed as such:** CRUD on SQLite, CSV import/export, ISBN lookup, a Next.js dashboard. Nothing in this repo advances any state of the art today.

**What may become an asset:** the accumulating local dataset linking *acquisition cost + condition + listing-price trajectory + platform + realized sale outcome* per book. Marketplaces show sellers competitor asks; they do not hand back your own cost-conditioned realized-outcome history in analyzable form. A sole seller who records faithfully ends up with a private comps dataset. That is a data asset, not an algorithmic one — and it is EMPTY today (see the sufficiency measurement below).

**Claim discipline:** nothing below may be stated as delivered or superior until its falsifiable milestone is met and reproducible (seeded scratch DB + scripted scenario). Everything below is CANDIDATE/OPEN.

## Frontier item 1 — Pricing intelligence (CANDIDATE)

Explicitly deferred by the spec: requirements.md Out of scope — "Book valuation / market price recommendations (a separate pricing feature)."

**Why current practice fails:** commercial repricers optimize against competitor list prices; they are blind to *your* acquisition cost, *your* condition mix, and *your* realized sell-through velocity. Pricing to undercut the lowest ask can be strictly worse than pricing against your own cost-conditioned outcome history.

**This repo's asset:** `price_history` + Sold rows already capture exactly the variables a cost-aware policy needs. Gross-profit-per-day-held is computable from existing columns (sale_price, acquisition_cost, acquisition_date, sale_date).

**First three steps in this repo:**
1. *Data sufficiency instrument* (read-only, runnable today):
```bash
sqlite3 "file:data/inventory.db?mode=ro" "SELECT COUNT(*) FROM books WHERE status='Sold' AND sale_price IS NOT NULL AND acquisition_cost IS NOT NULL AND condition IS NOT NULL AND sale_date IS NOT NULL; SELECT COUNT(DISTINCT book_id) FROM price_history;"
```
Run 2026-07-02: `0` and `0`. That IS the current finding — the instrument exists before the data. Re-run monthly; nothing downstream starts before ~30 sold rows.
2. *Sold-comps export* (spec-gated proposal via `book-seller-change-control`): a view/route exporting per-sold-book: condition, acquisition_cost, first/last listing price, days held, sale_price, platform, gross profit.
3. *Offline baseline heuristic*, evaluated by backtest on a scratch copy — e.g., "price at median of own past sale prices for the same condition, floor at cost + margin." No production code until the milestone.

**You have a result when:** on ≥30 recorded sales, the heuristic's backtested gross-profit-per-day-held beats the naive baseline (median own-history listing price, condition-blind) by a pre-registered margin (predict the number before running — `book-seller-analysis-and-methodology`). **Blocked by:** real data accumulation; honest sale recording requires the two-step Sale Pending→Sold flow to be ergonomic (AC3 dispute SR-6) and import to be trustworthy (D2 — `book-seller-constraint-leak-campaign`).

## Frontier item 2 — Sale-event ingestion from platform reports (CANDIDATE)

Spec posture: requirements.md Out of scope — "Automated ingestion of sale events from platform APIs." — but Constraints allow "either via manual operator entry or an import mechanism". Report-file ingestion (CSV the operator downloads from the platform) threads that needle without API integration.

**Why manual entry fails at scale:** each sale needs status transition + three sale fields; at tens of sales/month, operators batch and forget, and the outcome data that item 1 depends on rots.

**First three steps:** (1) obtain one real platform report sample (OWNER DEPENDENCY — formats are account-specific; do not guess the schema); (2) spec a mapping from report rows to the status API respecting the state machine — rows arriving as "sold" for a book in `Listed` must route Listed→Sale Pending→Sold or trigger the owner's AC3 decision (SR-6) — this feature is likely what forces that decision; (3) build it as an import-style adapter with per-row errors (FR22 pattern), only after D2 is fixed.

**You have a result when:** one genuine platform report imports on a scratch copy with per-row error reporting, zero invalid transitions, and dashboard/export totals reconciling with the report's own totals.

## Frontier item 3 — Durability automation (CANDIDATE — cheapest, highest value; do this first)

plan.md Risk 6 specified a startup backup routine (copy to `data/backups/`, keep last 7). Never implemented (DR-2). Meanwhile the DB is one `vitest run` away from wiping (T1).

**First three steps:** (1) spec the routine per plan Risk 6 via change-control (it is behavior-adding: startup side effect); (2) implement using SQLite `.backup`-equivalent (better-sqlite3 `db.backup()`), 7-file rotation; (3) restore drill on a scratch copy, documented in `book-seller-run-and-operate`.

**You have a result when:** 7 dated backups rotate automatically across restarts, and a restore drill on a scratch copy passes `db-integrity.sh` clean with matching row counts. No new theory; pure risk retirement.

## Frontier item 4 — Search at scale (FENCED: measure first)

plan.md line 79 (data-model SQL comment): "full-text search handled by LIKE queries; upgrade to FTS5 if needed at scale". Note: that comment exists only in plan.md — the shipped `data/migrations/001_init.sql` does not carry it; the NOCASE indexes on title/author exist in both.

**Fence:** LIKE + NOCASE indexes are almost certainly fine for a sole seller's thousands of rows. Do not build FTS5 on vibes.

**First steps:** (1) benchmark proposal: seed a SCRATCH-COPY DB (never the real one) with 10k synthetic rows, measure `GET /api/books?title=...` p95; (2) only if p95 exceeds a pre-registered threshold (e.g., 200 ms locally) does an FTS5 spec go to change-control (it is a schema change — table-rebuild rules apply).

**You have a result when:** measured p95 at a realistic row count crosses the pre-registered threshold — that is the license to build, not the build itself.

## Priority guidance

3 (durability) → unblock 1&2's prerequisites (D2 fix via the campaign; AC3 owner decision) → 2 (starts the data flywheel) → 1 (needs the data) → 4 (only if measurement demands).

## When NOT to use this skill

- Fixing live defects → `book-seller-constraint-leak-campaign` / `book-seller-debugging-playbook`.
- Whether/how to gate a new feature → `book-seller-change-control`.
- Experiment discipline (pre-registered predictions, refutation) → `book-seller-analysis-and-methodology`.
- What the domain terms mean → `bookselling-domain-reference`.

## Provenance and maintenance

Authored 2026-07-02. Verified that day: sufficiency query output (0/0) against the residue DB; out-of-scope quotes at requirements.md lines 54 and 58; FTS5 comment present in plan.md line 79 and absent from the shipped migration; NOCASE indexes in `data/migrations/001_init.sql`.

Re-verify:
- Sufficiency counts (the flywheel gauge): the sqlite one-liner in item 1.
- Out-of-scope stance unchanged: `grep -n "valuation\|Automated ingestion" docs/book-inventory-management/requirements.md`.
- Backup routine still absent: `grep -rn "backup" lib/ app/ --include="*.ts"` (expect none).
- AC3/SR-6 still open: check `book-seller-failure-archaeology` SR-6 status.
- Priorities: re-rank whenever a milestone lands; update this file and its date.
