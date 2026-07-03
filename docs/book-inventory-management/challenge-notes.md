# Spec Challenge Notes: Book Inventory Management

## Agents run
- Requirements Auditor (sonnet): 5 issues found, 5 accepted
- Scope & Dependency Auditor (sonnet): 2 issues found, 1 accepted
- Design Devil's Advocate (sonnet): 5 issues found, 5 accepted (15 plan changes)
- Implementation Realist (sonnet): connection closed after ~20 min — 0 findings (below threshold; 6/7 agents returned output; triage proceeded)
- Steps & Sequencing Critic (sonnet): 10 issues found, 10 accepted
- Data Model Critic (sonnet): 7 issues found, 7 accepted
- Security/Threat Auditor (sonnet): 10 issues found, 10 accepted

## Changes made
- **platforms → junction table**: `platforms TEXT` (comma-separated) replaced with a `book_platforms(id, book_id, platform, listed_at)` junction table. Stored as a single column, multi-platform listing was a silent design assumption with no backing requirement; this change makes it a first-class data relationship with a proper FK and index.
- **gross_profit column removed**: stored `INTEGER` column deleted from `books`; computed as `(sale_price - acquisition_cost) AS gross_profit` at read time in every SELECT. Eliminates the Step 9 bug (dividing by 100 before storing truncated to 0 for small values) and removes a redundant stored derivation.
- **WAL mode + FK enforcement added**: `lib/db.ts` now runs `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;` on every connection. Without WAL, Next.js App Router's concurrent async handlers hit `SQLITE_BUSY` errors under any parallel request load.
- **Security section added to plan**: 10 concrete mitigations added — localhost binding, prepared-statement requirement, ISBN digit-only validation, `q` param length cap (200 chars), monetary value bounds, CSV import 10 MB limit, formula injection escape (prefix `=+−@` cells with tab), Origin header CSRF check, safe 500 error responses, Open Library 64 KB response cap.
- **Status transition graph fully specified**: requirements.md now has FR10 enumerating every legal transition and FR11 defining Sale Pending semantics. Previous spec had FR9 ("prevent logically invalid transitions") with only one example — untestable as written.
- **Import schema defined**: FR21 now names required CSV columns explicitly (`title, author, condition, acquisition_cost_usd, acquisition_date`); plan.md documents that sale fields are ignored on import and all imported items are created as Unlisted.
- **Steps dep errors fixed + vitest added**: Step 6 now depends on Step 5 (both write `app/api/books/route.ts`); Step 8 depends on Step 6 (both write `app/api/books/[id]/route.ts`); Step 8 Parallelizable changed to Yes; vitest added to Step 1 install list.

## Critiques rejected
- **Implementation Realist findings**: agent connection closed at ~20 min, no output. 6/7 agents above threshold; triage proceeded without these findings.
- No other findings were rejected — all 6 active agents' findings were actionable and accepted.

## Open questions requiring human input
- **AC3 contradiction**: AC3 shows an item transitioning directly from Listed → Sold when the operator "records a sale with price and platform." But the transition table (FR10) requires Listed → Sale Pending → Sold. Which is authoritative? Options: (a) AC3 is wrong — update it to show the two-step flow; (b) FR10 is too strict — add Listed → Sold as a legal direct transition (e.g. for cash sales with no pending period). Needs a decision before implementation of `lib/transitions.ts`.
