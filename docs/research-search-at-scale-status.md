# Research note — search-at-scale status check (frontier item 4, FENCED)

**Status:** investigation only, read-only. No code changed, no scratch DB built, no benchmark run.
**Date:** 2026-07-03

## Read-only checks performed

- Real DB row count: `SELECT COUNT(*) FROM books` → `1`. Nowhere near the "thousands of rows" scale the fence discusses.
- `data/migrations/001_init.sql` confirmed to already carry `idx_books_title` and `idx_books_author` with `COLLATE NOCASE`, plus indexes on `status`, `condition`, `created_at`, `sale_date` (lines 31–36). Matches the frontier skill's prior verification.
- No FTS5 objects present in the schema (grep for `fts` in the migration: no hits) — matches the documented finding that the FTS5 comment lives only in `plan.md` line 79, not in the shipped schema.

## Why this stays fenced, not actioned

The frontier item's own instructions require a benchmark against a **10k-row synthetic scratch copy**, never the real database, before any FTS5 spec work is justified. Building that scratch copy and running a benchmark is a measurement task, not a read-only inspection — it's out of scope for this investigation pass, which is restricted to read-only inspection of existing state. At current real-data scale (1 row), there is also no urgency: nothing here indicates the fence should be reconsidered yet.

## Conclusion

No new information changes the frontier skill's guidance: this item is correctly ranked last ("only if measurement demands"), and the measurement step itself needs to be picked up as a deliberate, change-control-gated task rather than folded into a read-only research pass.
