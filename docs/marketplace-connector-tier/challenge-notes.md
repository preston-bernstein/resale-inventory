# Spec Challenge Notes

## Agents run
- Requirements Auditor (haiku): 12 issues found, 10 accepted
- Scope & Dependency Auditor (sonnet): 10 issues found, 7 accepted
- Design Devil's Advocate (sonnet): 11 issues found, 10 accepted
- Implementation Realist (sonnet): 22 issues found, 16 accepted
- Steps & Sequencing Critic (sonnet): 16 issues found, 14 accepted
- Data Model Critic (sonnet): 12 issues found, 9 accepted
- Security/Threat Auditor (haiku): 12 issues found, 10 accepted

## Changes made
- Fixed a real platform-count error: requirements.md said "7 platforms" throughout but the actual list (eBay/Etsy/Amazon/Poshmark/Depop/Mercari/Vinted/Grailed) is 8 — every reference corrected.
- Closed a real gating hole: `checkConnectionHealth` for the 5 browser-automation connectors was routing through the same session logic as mutating methods, meaning health-check polling could silently trigger unthrottled, bot-detectable login attempts. Added a read-only `validateSessionReadOnly()` path that never re-authenticates.
- Fixed a genuine architectural gap: `lib/automationGate.ts`'s `assertCanAutomate()` — referenced throughout the plan's own architecture diagram — was never listed as a file this increment creates. Added it to Integration points and Step 7.
- Added Poshmark's `sharePoshmarkListing()` as an explicit, formally-required, explicitly-gated 6th method (it was implied by the share-cap requirement but never stated as a real interface addition, and — critically — was not automatically covered by `gate.ts`'s wrapping since it sits outside the 5-method interface).
- Added a shared `lib/connectors/scrub.ts` credential-scrubbing utility so the "never leak a credential in an error/log" requirement has one tested implementation instead of 8 ad hoc ones.
- Fixed real data-model gaps in migrations 009/010: added a unique index + length bound on `external_listing_id`, added `tenant_id` directly to the two new Poshmark tables (matching existing precedent), made the `item_id` FK's `ON DELETE` explicit, and tightened the datetime CHECK constraints (the original `LIKE '____-__-__%'` pattern allowed non-digit garbage).
- Decoupled `gate.ts`'s own unit tests from all 8 real connectors (was an unnecessary bottleneck forcing the fastest, most foundational test to wait on the entire connector layer, including 5 Playwright modules).
- Split three oversized steps (eBay, Poshmark, and the 8-file suspension-test step) into independently verifiable sub-steps, and fixed two real dependency inaccuracies (Step 3 didn't actually need constants.ts; Amazon never reaches the OAuth-refresh code path so shouldn't depend on it).
- Documented several previously-implicit one-way-door decisions instead of leaving them to be discovered later: single-instance-only pacing state, singleton-connector-at-import-time, and the Playwright-as-production-dependency deployment-model shift (needs a persistent server process, not serverless/edge — this is bigger than a dependency-list line item).
- Added `next.config.ts`'s `serverExternalPackages` wiring and explicit browser-binary provisioning (`playwright install`) as real integration points — without them, the first production browser-automation call after this increment ships would fail with a missing-executable error that nothing in the test suite would have caught.

## Critiques rejected
- Renaming the Poshmark-specific event tables to a generic `platform_pacing_events` — rejected because requirements 33-35 are Poshmark-specific by design (documented legal/policy thresholds), not a placeholder for a general mechanism; kept as-is and documented as a deliberate scope decision.
- Switching migration 010 from `CREATE TABLE IF NOT EXISTS` to bare `CREATE TABLE` — rejected; this repo has documented history (in `lib/db.ts`'s own comments) of concurrent Next.js build-worker migration races, and `IF NOT EXISTS` is the established defensive convention here, not an inconsistency to fix.
- Adding a new `platform_connections.status` enum value (`rate_limited`) — rejected as unnecessary scope expansion; pacing/cooldown throttle errors are connector-level per-call rejections and intentionally do not transition the connection's overall status, only kill-switch suspension does.
- Flagging the eBay-Sandbox-vs-zero-credentials tension as a hidden dependency — rejected; requirement 19's skip-when-absent behavior already resolves this cleanly, no change needed.
- Several data-model findings about "missing indexes" on the Poshmark event tables were based on a condensed context that omitted the actual DDL (which already had them) — rejected as based on incomplete information given to that agent, not a real gap.
- CI/CD secret-masking and general Playwright supply-chain pinning — rejected as operational/deployment-pipeline concerns outside this spec's code-level scope, not something a requirements/plan document should mandate.

## Open questions requiring human input
- None that block starting the build. The one item genuinely outside this session's control — registering a free eBay Developer Sandbox app — is now explicitly called out in steps.md's Prerequisites and requirements.md's Out of Scope as the operator's task, but it does not block any other step; Sandbox-dependent tests are skip-gated until it's done.
