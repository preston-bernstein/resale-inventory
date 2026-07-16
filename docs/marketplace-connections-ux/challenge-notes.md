# Spec Challenge Notes

## Agents run
- Requirements Auditor (haiku): 5 categories of findings (untestable, missing, contradiction, vague, leaked) — 6 accepted
- Scope & Dependency Auditor (sonnet): 8 findings — 4 accepted
- Design Devil's Advocate (sonnet): 7 findings — 5 accepted (2 fully, 3 acknowledgment-only)
- Implementation Realist (sonnet): 5 findings (incl. concrete code-grounded bugs) — 4 accepted
- Steps & Sequencing Critic (sonnet): 17 findings — 13 accepted
- Data Model Critic (sonnet): 5 findings — 3 accepted
- Security/Threat Auditor (haiku): 5 findings — 3 accepted

## Changes made

- **Fixed a real correctness bug**: the item-readiness ("first win") SQL query had no `items.status` filter, so it would have counted Sold/Removed/Donated/Discarded items as "ready to list" — confirmed independently by both the Data Model Critic and the Implementation Realist. Added `AND i.status = 'Unlisted'` to `plan.md`'s query.
- **Fixed a factual error that would have caused a real bug**: `plan.md` incorrectly stated `PATCH /api/connections/:id/credential` handles the revoked→reconnect case. Reading the actual route code shows revoked-reconnect goes through `POST /api/connections`'s delete-then-recreate transaction, which generates a **brand-new UUID**. Left uncorrected, a developer would have wired the consent-record call to reuse a stale `connectionId` that no longer exists post-recreate (flagged as the single most likely first-try implementation mistake by the Implementation Realist). Fixed in `plan.md`'s API contract and Risk Areas, and reflected in `steps.md`'s Step 6a.
- **Closed a missing-integration gap**: nothing in the original architecture fetched per-connection consent validity (`GET /api/connections/:id/consent`), yet the spec required a distinct "stale consent" signal (FR15/AC10). Added the fetch to `plan.md`'s Architecture and `StatusRow`'s integration point, a new requirement (16) in `requirements.md`, and a dedicated Step 4b in `steps.md`. This also closes a related dead-end: a connection that's `active` but never got its consent recorded (tab closed mid-flow) now has a defined recovery path (requirement 18).
- **Split 5 oversized steps** (original Steps 4, 6, 11, 12, 14) into 12 independently-verifiable sub-steps, and fixed 4 real dependency errors (a circular Step 2↔3 reference, Step 6 missing deps on Steps 5/7, Step 8 missing a dependency on Step 7, Step 14 missing a dependency on Step 3).
- **Clarified a sequencing ambiguity that read as a contradiction**: requirements 8/9/12/13 conflated the client-side "affirm" gesture (no network call) with the server-side "record consent" API call (which happens later, after connection creation). Requirements 10 and 13 now state the full sequence explicitly.
- **Added security hardening notes** (new `## Security notes` section in `plan.md`): generalized the first-win route's error mapping to never leak raw exception text for *any* thrown error (not just the one anticipated `ConnectorNotConfiguredError` case), and added a verification note that credential fields must never be echoed by existing routes' error responses or logged/rendered by `CredentialStep`.
- **Acknowledged 3 accepted limitations explicitly** rather than leaving them as silent gaps: the "oauth" trust-tier label is a placeholder category (no real OAuth redirect flow exists yet), the masked identifier is a one-time-only display (never persisted server-side), and the readiness count is category-agnostic by design (a book item counts toward a Grailed readiness number too). All three are now named in `plan.md`'s Risk Areas so they read as informed MVP tradeoffs, not oversights discovered later.

## Critiques rejected

- **Latency NFR placeholder ("[threshold TBD]")** flagged as untestable — rejected as a defect; this was already an intentional, explicitly-acknowledged non-binding placeholder in the original plan, not an oversight. Fabricating a number would be worse than leaving it honest.
- **Several "vague terms" findings** (requirement wording like "visually competing," "existing convention," "explicit affirmative action," "immediate," "appropriate") — rejected; each term is already sufficiently scoped by adjacent constraint text or explicit existing-codebase references (e.g. `ItemCardGrid`'s convention), and tightening further would add padding without changing what gets built.
- **Server-component-vs-client-heavy page architecture** (Design Devil's Advocate proposed passing `initialConnections` from a server component to avoid a loading-flash) — rejected; the current approach isn't wrong, and the acceptance criteria's ordering guarantees only depend on the downstream wizard flow, not the first paint. Worth a future optimization pass, not a defect to fix now.
- **Platform-string validation on the new first-win route** (Security Auditor) — rejected as a code change; confirmed `connection.platform` is already validated against `SUPPORTED_PLATFORMS` at insert time by the existing `POST /api/connections` route, so the new route can safely trust the stored value. Documented as a note instead of adding redundant validation.
- **Category-aware readiness filtering** (Design Devil's Advocate wanted an actual platform→category allowlist so book items don't count toward Grailed's readiness number) — rejected as an implementation change; accepted only as a documented simplification (see Changes Made) to avoid scope creep beyond this increment's stated boundaries.
- **Full restructure so every step (3-8) carries its own test-writing inline** (Steps & Sequencing Critic's broader "unverifiable until 11-13" complaint) — rejected as stated; the accepted TOO-LARGE splits already narrow each step's own verifiable surface substantially, and mandating inline tests in every component-build step would roughly double the step count for marginal benefit over the current structure.

## Open questions requiring human input

- None. All findings were either fixed directly, acknowledged as explicit documented tradeoffs, or rejected with a stated reason above — no blocker requires a decision only a human can make.
