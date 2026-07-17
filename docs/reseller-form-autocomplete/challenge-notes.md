# Spec Challenge Notes

## Agents run
- Requirements Auditor (haiku): 22 issues found, 12 accepted
- Scope & Dependency Auditor (sonnet): 9 issues found, 6 accepted
- Design Devil's Advocate (sonnet): 9 issues found, 7 accepted
- Implementation Realist (sonnet): 18 issues found, 13 accepted
- Steps & Sequencing Critic (sonnet): 16 issues found, 13 accepted
- Data Model Critic (sonnet): 8 issues found, 5 accepted
- Security/Threat Auditor (haiku): 8 issues found, 2 accepted

## Changes made
- **Cut `clothing_brand_aliases` entirely (plan.md).** Nothing in this feature's scope ever writes an alias row — it was schema for a feature that's never wired up, and the actual "Nike"/"nike"/"NIKE" casing problem is already fully solved by `COLLATE NOCASE` on `canonical_name` alone. Simplified `clothing_brands` to canonical-name-only; alias support is now an explicit, documented Out-of-scope item in requirements.md, deferred until an admin/merge mechanism exists to populate it.
- **Fixed a real correctness bug before it shipped: the "add new brand" path was cosmetic.** The original plan auto-created a canonical brand row on *any* unmatched submit, whether the operator deliberately picked "Add new brand" or just fat-fingered a typo — the confirmation UI didn't actually gate anything. Added an explicit `confirmed_new` signal requirement (new FR15) and committed the concurrency fix (catch `SQLITE_CONSTRAINT_UNIQUE`, re-lookup) as a required behavior rather than an acknowledged risk.
- **Caught a wrong-algorithm risk before implementation: `computeIsbn10CheckDigit` was described as "extracted from existing code," but no ISBN-10 check-digit math exists anywhere in `lib/isbn.ts` today** (only the unrelated ISBN-13/mod-10 math does). Two independent reviewers flagged this as the single most likely implementation mistake — a developer trusting "extracted" would likely copy-adapt the wrong algorithm by analogy. Plan now spells out the correct mod-11/weights-10-to-2/remainder-10-is-'X' algorithm explicitly and states it's new code.
- **Fixed a real ordering bug: `normalizeISBN` silently "corrects" bad ISBN-10 input instead of validating it** (it discards the user's actual check digit and computes a fresh one from the 9-digit prefix). If the new checksum gate ran after `normalizeISBN`, it would never see the original bad input. Plan now mandates `validateIsbnChecksum` runs on raw input strictly before any call to `normalizeISBN`, with a test asserting the ordering.
- **Resolved a genuine requirements/plan contradiction**: FR17/18 described size-system selection as inferred from "unambiguous item context," but the plan (correctly) made it an explicit operator choice via a picker, since no garment-type column exists to infer from. Rewrote FR20/21 (renumbered) to match the operator-choice design.
- **Fixed a UI-impossible design**: `numeric_waist_inseam` was specified as a closed-vocabulary `<select>`, but a dropdown can't reasonably enumerate every waist×inseam combination. Changed to two number inputs combined client-side into the `"WWxII"` string; loosened the validation regex from `^\d{2}x\d{2}$` to `^\d{1,3}x\d{1,3}$` so it doesn't reject legitimate single/triple-digit sizes.
- **Dropped the DB-level `CHECK` constraint on `size_system`** — SQLite can't alter a `CHECK` constraint without a full table rebuild, which was inconsistent with the plan's own reasoning for keeping the size vocabulary itself as a plain, easily-widened array/regex. Validation is now app-layer only (`validateSizeSystem`), consistent with the rest of the feature.
- Split three steps that bundled independent concerns (brand canonicalization vs. size validation; combobox wiring vs. picker wiring; four e2e scenarios in one step) into eight properly-scoped, independently-testable sub-steps, and fixed several wrong step dependencies (e.g. the ISBN book-branch step falsely depended on the clothing/brand migration).

## Critiques rejected
- Untestable brand-latency NFR ("[threshold TBD]") — this is an intentional placeholder per spec-gather's own sparse-context convention, not a defect at this feature's scale.
- Size-system persistence/editability after initial item submission — out of scope; a general item-editing concern, not specific to the add-item forms this feature touches.
- Switching the hand-rolled combobox to a library dependency (downshift/react-aria/cmdk) — rejected in favor of the repo's established zero-UI-dependency convention (confirmed deliberately twice now, at spec-gather and again here); mitigated instead by adding explicit keyboard-operability test coverage.
- A backfill/seed step for historical brand values into the new canonical table — explicitly out of scope per the original requirements; documented as an accepted transition-state limitation instead of built.
- FK from `clothing_details.brand` to `clothing_brands.id` — rejected as over-normalization inconsistent with this schema's existing convention (condition, color, material are all plain denormalized `TEXT` columns too).
- A trigger guarding `clothing_brands.tenant_id` against `UPDATE` — no code path in this feature (or the codebase generally) ever updates `tenant_id` on an existing row; the added complexity isn't justified by a real risk.
- SQL-injection / "require parameterized queries" as a structural concern — this codebase already exclusively uses better-sqlite3's `.prepare()`/named-params everywhere with zero string-concatenated SQL; added one clarifying line to the plan instead of treating it as a design gap.
- ISBN URL-encoding and Open Library timeout/circuit-breaker concerns — already handled by existing, unchanged code (`ISBN_PATTERN` shape-gates the string before URL construction; a 3-second `AbortController` timeout and 64KB body cap already exist in `lib/isbn.ts`). The auditor's prompt lacked this existing-code context, producing a false positive.
- Migration numbering (`011`) and specific file/route names (`GET /api/brands`, `lib/brands.ts`, etc.) appearing in plan.md but not requirements.md — correct separation of concerns; requirements.md appropriately stays at the "new versioned migration file" / behavior level of abstraction.

## Open questions requiring human input
None. All findings were either fixed directly or explicitly deferred with a documented rationale (brand alias matching, garment-type-derived sizing, brand rename/merge tooling) — none of these block building this pass.
