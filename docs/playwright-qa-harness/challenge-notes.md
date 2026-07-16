# Spec Challenge Notes

## Agents run
- Requirements Auditor (haiku): 7 issues found, 6 accepted
- Scope & Dependency Auditor (sonnet): 11 issues found, 9 accepted
- Design Devil's Advocate (sonnet): 9 issues found, 7 accepted
- Implementation Realist (sonnet): 10 issues found, 8 accepted
- Steps & Sequencing Critic (sonnet): 20 issues found, 19 accepted
- Data Model Critic (sonnet): 3 issues found, 2 accepted
- Security/Threat Auditor (haiku): 19 issues found, 1 accepted

## Changes made
- **Session-persistence test redesigned to not create a new tenant.** The original plan for `auth-pages.spec.ts`'s new test overrode `storageState` to empty and re-signed-up through the UI — that would create a brand-new tenant on every single run in a scratch DB that is never wiped by design, silently violating the "one E2E tenant" invariant `playwright.config.ts` documents. Now it reuses the default authenticated session and only proves the session survives navigation + reload.
- **Fixed a real, previously-unflagged bug in `csv-export-import.spec.ts`**: its `suffix` fixture value is computed once at module load rather than per-test, which would have caused the new `--repeat-each=3` determinism requirement (FR11/AC2) to fail on repeats 2 and 3 via title/ISBN collisions. Folded the fix into that file's existing edit.
- **Constrained the new full-field CSV round-trip test to import only its own new row(s)**, never the full existing export — reimporting everything could duplicate every prior row in the shared never-wiped DB (if import is insert-only, not upsert) and break `dashboard.spec.ts`'s/`search-filter.spec.ts`'s aggregate-count assertions for unrelated reasons.
- **Discovered the marketplace-connector requirement (FR3/AC3) is already fully satisfied** by the existing `tests/e2e/connections-flow.spec.ts` (Depop consent → credential → first-win, dry-run mode, no live network calls) — no new connector spec needs to be written, only a verification pass.
- **Corrected the file-complexity assumption for `dashboard.spec.ts`/`search-filter.spec.ts`**: these don't have simple inline book creation to swap 1:1 — each has a combined book+clothing creation function that needs decomposing into two calls. Steps.md splits the former "6 files in one step" into 2a/2b/2c/2d by actual complexity.
- **Made the `--repeat-each=3` determinism check permanent**: added a `test:e2e:flaky-check` npm script instead of leaving it as a manually-typed one-off with no lasting trace.
- **Added explicit FR9 (report)/FR12 (exit code) verification** to the full-suite run step — neither had a step actually checking them before.
- **Fixed an invalid Playwright CLI flag** (`-v`) and several unverifiable "Test" fields (file-list placeholders, disjunctive pass-either-way conditions) across steps.md.

## Critiques rejected
- Most of the Security/Threat Auditor's findings (auth checks on `/api/import`/`/api/export`, CSRF protection, phone-handoff token validation depth, formula-injection escaping, dependency CVE policy, Next.js dev-mode headers) — these audit the app's existing, pre-existing endpoint/auth surface, not something this test-infra feature touches or changes. Fixing them would be a separate initiative. Kept: test-credential hygiene (already the repo's convention, just made explicit).
- A proposal to generalize `createBookItem`/`createClothingItem` into one generic `createItem(page, category, fields)` — rejected as over-engineering beyond this feature's stated scope (would force rewriting `createClothingItem` and all its existing call sites too).
- A claim that the existing `CSV_HEADERS` constant is a "new" duplication risk — rejected, it's pre-existing code style this feature doesn't introduce.
- A claimed PRAGMA `user_version` migration race under repeated runs — rejected; `playwright.config.ts`'s `workers: 1` + `fullyParallel: false` + `webServer.reuseExistingServer: false` already force strictly sequential, single-process server boots, so concurrent-migration races (a real historical defect under `next build`'s parallel workers) can't occur here.
- A claim that AC6 is untestable because it needs a manual revert-and-test cycle — rejected; that's an acceptable one-time verification method during build-out, consistent with this project's own predict-then-observe QA convention.
- New functional requirements for general negative/error-path test coverage — rejected as scope expansion; instead added one explicit "Out of scope" line covering it.
- A scope-creep finding that Step 6 (data-path grep) was an invented, unsupported safety check — rejected; it maps directly to AC7, which the auditor agent wasn't given in full detail.

## Open questions requiring human input
- None blocking. One minor, non-blocking documentation drift: steps.md's Step 2c still frames `dashboard.spec.ts`/`search-filter.spec.ts`'s cost values as assertion-critical, while plan.md's more careful direct-read correction found neither file actually asserts on the exact cost value (only format/presence) — steps.md's stricter "pass the exact value anyway" instruction is still safe (keeps the refactor behavior-preserving) and doesn't need to block build-out, but a future editor of these files should treat plan.md's Integration points section as the more accurate source of truth on this point.
