# Requirements: Playwright QA Harness

## Problem statement
The app has grown well past its original single-user CRUD scope — it now has multi-tenant auth, eight marketplace connectors with a consent/credential/kill-switch system, a phone-handoff QR upload path, CSV import/export, and a guided presale tutorial — but the existing Playwright E2E suite (`tests/e2e/`) and its config (`playwright.config.ts`) may still carry assumptions from before that growth (e.g. a documented "single-user, no auth" note that predates login/signup). Without a harness that actually exercises both the simple, everyday flows and the long, multi-step flows end-to-end, regressions in these newer surfaces can ship undetected — and because `data/inventory.db` is the business's one and only inventory record, a broken flow discovered in production is not just a bug, it's a risk to real data. The person who has this problem is whoever ships changes to this app going forward; it matters now because the newest surfaces (connectors, phone handoff, multi-tenant auth) are exactly the ones with the least test coverage and the highest blast radius.

## Users / stakeholders
- Developers shipping changes to the app, who need the harness to catch regressions before merge.
- The operator of the reseller business, whose live inventory (`data/inventory.db`, `data/photos/`) must never be touched by any test run.
- CI (if/when wired up), which consumes the harness's pass/fail exit code and report.
- Future contributors to `tests/e2e/`, who need a maintainable pattern (shared helpers, role-based locators) to extend rather than duplicate.

## Functional requirements
1. The system shall execute the Playwright E2E suite via the existing `npm run test:e2e` entry point, running exclusively against the scratch database, scratch photo directory, and scratch credential-key path already wired through `BOOKSELLER_DB_PATH`, `BOOKSELLER_PHOTOS_PATH`, and `BOOKSELLER_CREDENTIAL_KEY_PATH` in `playwright.config.ts`.
2. The system shall provide Playwright coverage for these simple flows: add a book item, add a clothing item, edit an item's details, move an item through the Unlisted -> Listed -> Sale Pending -> Sold state machine, and upload a photo to an item.
3. The system shall provide Playwright coverage for these complex, multi-step flows: signup -> login -> create an item -> session persists across navigation and reload; CSV export followed by CSV import that round-trips item data without loss; the phone-handoff flow (issue QR-backed upload link, consume it from a second Playwright `BrowserContext` — or a new tab within the same `BrowserContext` — in the same test process, simulating a phone opening the QR-encoded URL directly, confirm the photo lands on the originating item); and, for the Depop marketplace connector, the consent -> credential entry -> first-win confirmation flow. This Depop flow is already fully covered end-to-end by the existing `tests/e2e/connections-flow.spec.ts` (verified by reading it: it drives Depop's connect card -> consent screen -> credential form -> masked confirmation -> first-win panel in dry-run mode, with no live network calls) — FR3's connector clause is satisfied by verifying that existing test still passes, not by writing new spec code.
4. The system shall assert on user-visible, role/accessible-name-oriented locators (`getByRole`, `getByText`, or this repo's existing `fieldWrapper`/`inputByLabel` helpers in `tests/e2e/helpers.ts`) for lines newly added or modified within a spec file, not raw CSS selectors tied to incidental DOM structure.
5. The system shall use Playwright's web-first auto-waiting assertions (e.g. `expect(locator).toBeVisible()`) for lines newly added or modified within a spec file and shall not introduce fixed-duration waits (e.g. `page.waitForTimeout`) among those newly-added or modified lines.
6. Each spec file shall be independently runnable and shall not depend on execution order or state left behind by another spec file, except for the shared `setup` project (`auth.setup.ts`) dependency already established in `playwright.config.ts`.
7. The system shall seed flow preconditions unrelated to the behavior under test (e.g. tenant login) via the existing `auth.setup.ts` / stored-session pattern rather than by re-driving login through the UI in every spec.
8. The system shall audit `playwright.config.ts` and every file in `tests/e2e/` for assumptions that predate multi-tenant auth (e.g. "single-user, no auth" reasoning) and shall correct any such assumption found to be stale.
9. The system shall verify that Playwright's existing configured reporter (`list` locally, `[html, github]` on CI, already wired in `playwright.config.ts`) produces a human-readable run report showing per-spec pass/fail/flaky status after each execution — no new reporter or reporting code is built by this feature.
10. When the harness surfaces a defect in application code during this feature's initial build-out, the system shall triage it: a defect that is a genuine data-integrity/correctness bug shall be fixed in application code in this branch (not skipped, retry-wrapped, or covered by deleting the failing assertion), with a regression spec assertion added or extended that would catch a regression of that defect; if the fix lands in code that already has Vitest unit coverage, the corresponding Vitest test shall also be extended or added, not just a Playwright assertion. A defect found that is out of this feature's scope shall be noted in the delivery report rather than fixed silently.
11. The system shall re-run any newly added or newly modified spec file 3 consecutive times with zero failures before that spec is considered non-flaky and kept in the suite.
12. The system shall exit non-zero when any spec in the suite fails, consistent with `npm run test:e2e`'s existing exit-code behavior.
13. The system shall factor locators and multi-step interactions used (or duplicated) in 2 or more spec files into `tests/e2e/helpers.ts` (or an equivalent shared module) rather than duplicating them inline per spec.

**Scope note (FR4/FR5):** "newly added or modified" means lines/logic newly introduced at the point a spec file is touched. Pre-existing, unrelated code already in a file is not retroactively required to comply with FR4/FR5 merely because the file was touched for an unrelated fix — e.g. swapping `phone-handoff.spec.ts`'s book-creation helper does not require rewriting that file's existing, unrelated polling logic.

## Non-functional requirements
- Data safety: no file added or modified by this feature may reference `data/inventory.db` or `data/photos/` directly — all execution paths through the scratch DB/photos/credential-key env vars, per the existing hard constraint already enforced in `vitest.config.ts` and `playwright.config.ts`.
- Security/isolation: the marketplace-connector flow(s) exercised shall not make live network calls to real third-party marketplaces during a test run — only the app's own consent/credential/kill-switch UI and storage are exercised.
- Reliability: newly added or modified specs must be deterministic — 3 consecutive clean runs with no flakes before being trusted as passing (matches FR11/AC2). The scratch database (`.playwright-scratch/inventory.db`) is never wiped between test runs, by existing design; every new or modified spec must generate unique values (via the existing `uniqueSuffix()` helper convention) for any field with a uniqueness constraint (e.g. `isbn`), not fixed literals, so repeated runs don't collide.
- Concurrency/scale: the harness runs single-machine, `workers: 1`, `fullyParallel: false` (matches existing config — tests share one server/DB/tenant); it is not designed for distributed or parallel execution.
- Runtime budget: no full-suite runtime target is specified by current project context; if one is required, threshold TBD.

## Constraints
- Must extend the existing Playwright infrastructure (`playwright.config.ts`, `tests/e2e/`, `tests/e2e/helpers.ts`, `tests/e2e/auth.setup.ts`, `tests/e2e/storageStatePath.ts`) rather than replacing it.
- Must integrate with the multi-tenant auth system already present (login/signup routes, tenant-scoped session via `storageState`).
- Must use only the scratch-DB/scratch-photos/scratch-credential-key redirection pattern already established via env vars — this is a hard, non-negotiable constraint per repo documentation.
- No new third-party services or testing frameworks — Playwright is the mandated tool per the feature description and is already a project dependency.
- Must coexist with the project's other QA gates (Vitest unit/component tests, coverage thresholds, Stryker mutation testing, ESLint, `tsc --noEmit`, `fallow`) without modifying their configuration as part of this feature.

## Out of scope
- A standing, recurring, unattended pipeline that auto-applies code fixes on every future harness run without human review. Autonomous fixing under this feature applies only to defects discovered during this feature's initial build-out; subsequent runs report defects for a human to triage and fix.
- Load, stress, or performance testing.
- Accessibility (a11y) audit automation.
- Visual regression / screenshot-diff testing.
- End-to-end testing against real, live third-party marketplace accounts (eBay, Etsy, Amazon, Poshmark, Depop, Mercari, Vinted, Grailed) — connector coverage is limited to the app's own consent/credential/kill-switch UI.
- Native mobile app testing — only browser-based/PWA behavior reachable via Playwright is covered.
- Changes to Vitest, Stryker, coverage thresholds, ESLint rules, or `fallow` configuration.
- New negative/error-path spec coverage beyond what a surfaced defect's own regression test requires.

## Acceptance criteria
1. `npm run test:e2e` completes and, for the duration of the run, `BOOKSELLER_DB_PATH`, `BOOKSELLER_PHOTOS_PATH`, and `BOOKSELLER_CREDENTIAL_KEY_PATH` all resolve under `.playwright-scratch/`, never under `data/`.
2. Running `npm run test:e2e` three consecutive times on an unchanged codebase produces identical pass/fail results (zero flakes) across every spec in `tests/e2e/`.
3. `tests/e2e/` contains passing spec coverage for: add-book, add-clothing-item, full status state-machine transition, photo upload, CSV export/import round trip, signup->login->use-app, phone-handoff QR upload, and at least one marketplace connector's consent->credential->first-win flow.
4. Every locator introduced in a new or modified spec file is role/accessible-name-based (`getByRole`, `getByText`, or the repo's `fieldWrapper`/`inputByLabel` helpers) — zero newly introduced raw CSS or XPath selectors outside those helpers.
5. Zero occurrences of `page.waitForTimeout` or another fixed-duration sleep exist in any new or modified spec file.
6. Every application defect the harness surfaces during this feature's build-out is fixed in application code and covered by a spec assertion that fails against the pre-fix behavior and passes against the fix.
7. A repo-wide search (e.g. `git grep`) for `data/inventory.db` and `data/photos` under `tests/e2e/` and `playwright.config.ts` returns no direct references — only the scratch-path env vars.
8. The final Playwright report generated at feature completion shows 0 failing specs.
9. `playwright.config.ts` and every `tests/e2e/*.spec.ts` file are free of comments or logic that assume single-user/no-auth behavior; each either correctly assumes multi-tenant auth or has been corrected to do so as part of this feature.
