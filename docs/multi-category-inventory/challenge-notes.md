# Spec Challenge Notes

## Agents run

- Requirements Auditor (sonnet): 20 issues found, 17 accepted
- Scope & Dependency Auditor (sonnet): 15 issues found, 8 accepted
- Design Devil's Advocate (sonnet): 12 issues found, 10 accepted
- Implementation Realist (sonnet): 20 issues found, 17 accepted
- Steps & Sequencing Critic (sonnet): 20 issues found, 19 accepted
- Data Model Critic (sonnet): 26 issues found, 16 accepted
- Security/Threat Auditor (sonnet): 11 issues found, 6 accepted

## Changes made

- **Critical bug fix**: `lib/db.ts` currently runs `001_init.sql` unconditionally on every boot, relying on its `CREATE TABLE IF NOT EXISTS` guard for safety. After migration 003 renames `books`/`book_platforms` away, the next app restart would have silently resurrected empty copies of those tables. Fixed by folding `001_init.sql` into the same `PRAGMA user_version`-gated loop as an implicit version-1 step. Caught independently by the Implementation Realist and referenced by two other agents — the single highest-value finding of the review.
- **Migration safety upgraded from destructive to archival**: `books`/`book_platforms` are now renamed to `*_archived` instead of dropped in migration 003; the actual DROP is deferred to a future migration 004 once the new schema has proven stable in production. This gives a built-in rollback path that doesn't depend on an external backup file surviving. Three independent agents (Design Devil's Advocate, Data Model Critic, Implementation Realist) converged on related concerns here.
- **Architecture honesty**: the plan's claim that a third category would be fully "additive" was self-contradicted by its own stated SQLite limitation (`items.category`'s CHECK constraint still needs a rebuild to add a value). Three agents independently caught this. Reworded to an honest, bounded claim instead of an overclaim.
- **Category immutability got real DB-level enforcement**: added an `items_category_immutable` trigger as defense-in-depth behind the existing API-layer discipline (never accept `category` in PATCH), which the Design Devil's Advocate and Data Model Critic both flagged as a gap with no DB-level backstop.
- **Photo handling hardened substantially**: file-type/size/count limits, server-generated filenames (never trust originals), path-traversal guarding, IDOR scoping (`item_id` + `id` on every photo operation), a previously-missing GET/serving route for photo bytes, and a specified row-then-file delete order. The Security Auditor and Implementation Realist converged heavily here — this was undertreated in the original plan.
- **Migration simplified**: `price_history`'s `book_id → item_id` rename now uses a single `ALTER TABLE ... RENAME COLUMN` instead of the full create-copy-drop-rename dance, meaningfully cutting migration risk for that table (Data Model Critic).
- **Requirements contradictions resolved**: FR8 (UI add fields) and FR19 (CSV import required fields) disagreed on whether color/material were required for clothing — reconciled to optional in both paths. The "extends, does not replace" constraint was reconciled against the plan's actual route-path replacement (book routes are renamed/consolidated, not duplicated).
- **Steps.md restructured**: split three oversized steps (schema migration, UI, tests) into smaller independently-verifiable sub-steps, fixed four dependency-declaration errors, and added an explicit step to delete the legacy `app/api/books/**`/`app/books/**` surface rather than leaving it implicit.

## Critiques rejected

- Nullable-column single-table alternative to the satellite-table design (Design Devil's Advocate #1) — the "combinatorial explosion" framing was overstated for 2 categories, and the plan's language was corrected, but the underlying architectural choice itself was already settled in the prior research phase (`docs/reseller-architecture-research.md`) after evaluating this exact tradeoff; not revisited here.
- EAV/side-table for clothing measurements (Design Devil's Advocate #7) — 8 fixed nullable columns is bounded and appropriate for one garment archetype at this scope; revisit only if a materially different item shape (shoes, bags) is added later.
- Storage abstraction layer for photos (Design Devil's Advocate #8, partial) — kept local-filesystem-only per explicit NFR; added the validation/limit fixes but not a swappable storage interface, which would be premature for a single-user local app.
- `ON DELETE CASCADE` on satellite foreign keys (Data Model Critic) — no delete endpoint exists for items in this app (today or in this feature); added a note explaining the FK's default RESTRICT is intentional rather than an oversight.
- `sale_platform` validated against `item_platforms` (Data Model Critic) — pre-existing gap in the current book app, not introduced by this feature; out of scope.
- Table/column renaming for naming-consistency nitpicks (`price_history` → `item_price_history`, `*_cents` suffixes, PK pattern on satellite tables) (Data Model Critic NAMING, 4 findings) — all cosmetic, would expand the rename surface for no functional benefit, and the satellite-table `item_id`-as-PK pattern is actually the idiomatic choice, not an inconsistency.
- Date-format/UUID-format CHECK gaps, single-transaction migration lock duration (Data Model Critic TYPE/MIGRATION) — inherited from the existing app's established pattern, not new gaps introduced by this feature.
- Auth/authz hardening beyond localhost bind, CSV export over-fetch, dependency CVE pinning (Security Auditor) — the app has zero auth by design (documented, existing, single-user local tool); not this feature's concern to fix. Export column list is already explicit in plan.md, not `SELECT *`. Dependency pinning is a build-time concern, not a spec-time one.
- `book_platforms`→`item_platforms` price_history_v2 "no rename-back" claim, exact-measurement-units-unspecified, CSV column ambiguity (Scope Auditor, several) — false positives caused by prompt condensation for that agent; the actual plan.md already specified these correctly.
- FR21's "third category is additive" verified by a dedicated step (Steps Critic) — the underlying claim was already softened to an honest, bounded statement in requirements.md; a verification step for an architectural principle (rather than a concrete behavior) isn't a meaningful test surface.

## Open questions requiring human input

- **Photo upload limits are placeholders.** Requirements/plan use "[threshold TBD]" for max file size, max photo count per item, and allowed image types — no source in this session's research specified concrete numbers. Needs an owner decision before implementation (reasonable defaults: 10MB/photo, 20 photos/item, jpeg/png/webp — but confirm before coding).
- **Legacy ISBN normalization.** Existing `books.isbn` values are copied as-is into `book_details.isbn` during migration, not re-normalized to ISBN-13. A post-migration report step is planned, but any actual fix requires manual reconciliation (an owner decision per this repo's change-control non-negotiables) since auto-fixing risks silently colliding two records.
- **When to write migration 004** (the actual DROP of `books_archived`/`book_platforms_archived`) is intentionally left open — "once the new schema has proven stable in production for at least one release cycle" is a judgment call for the owner, not a fixed date.
