# Spec Challenge Notes

## Agents run
- Requirements Auditor (sonnet): 20 issues found, 15 accepted
- Scope & Dependency Auditor (sonnet): 12 issues found, 9 accepted
- Design Devil's Advocate (sonnet): 10 issues found, 7 accepted (1 kept as open question, not acted on)
- Implementation Realist (sonnet): 13 issues found, 10 accepted
- Steps & Sequencing Critic (sonnet): 17 issues found, 11 accepted
- Data Model Critic (sonnet): 6 issues found, 4 accepted (localStorage pseudo-schema, since there's no SQL data model)
- Security/Threat Auditor (sonnet): 4 issues found, 4 accepted

## Verification performed mid-review
Three separate agents (Scope Auditor, Design Devil's Advocate, Implementation Realist) independently flagged the same unchecked assumption: that `react-joyride@^3.2.0` actually supports React 19. Rather than accept or reject on guesswork, this was verified directly: `npm view react-joyride peerDependencies` confirms the published 3.2.0 declares `react: '16.8 - 19'` / `react-dom: '16.8 - 19'` — genuinely compatible. This is now recorded as a checked fact in plan.md's new Design decisions section instead of an assumption.

## Changes made
- **Resolved a real contradiction**: requirements demanded Skip/Close both tear down instantly (FR6/AC3) and always play an exit animation (FR11/FR12). Fixed by scoping the animated-exit requirement to Next/Back/Finish only — Skip/Close is explicitly instant by design.
- **Fixed a global-vs-per-category persistence bug before it shipped**: the plan's single `localStorage` completion flag meant finishing the clothing tour would permanently hide the book tour's "not yet seen" state (or vice versa). Now two versioned, per-category keys (`presale-tour:v1:book` / `presale-tour:v1:clothing`).
- **Closed a silent-typo risk three agents flagged independently**: `data-tour` anchor strings were duplicated by hand across `AddClothingForm.tsx`, `AddBookForm.tsx`, and `lib/tourSteps.ts`, with no shared source — one typo would silently degrade to `TARGET_NOT_FOUND`. Now a single `lib/tourAnchors.ts` module is the shared source for all three.
- **Removed a hand-rolled accessibility landmine**: `TourCompletionModal` now builds on the native `<dialog>` element (free focus-trap + Escape-to-close from the browser) instead of a fully hand-rolled focus trap, which reviewers correctly flagged as a hard problem to get right with zero a11y-library budget.
- **Gave the highest-risk new code real mutation coverage** without breaking the project's existing "no components mutated" convention: extracted the tour's callback/state-machine logic into a pure `lib/tourStateMachine.ts`, added *that* to `stryker.conf.json` instead of the component.
- **Locked two previously-open TBD placeholders**: transition duration is now a concrete 200ms, bundle budget a concrete ≤50KB gzipped — both were unfalsifiable as written.
- **Sequencing fixes**: split three oversized steps (Joyride orchestrator, unit tests, E2E tests), merged two undersized ones, fixed a dependency-order bug where mutation config was wired before the tests that would trigger it, and added a new early step for the shared anchor constants.

## Critiques rejected
- Design Devil's Advocate's core challenge — "is react-joyride worth it at all, given every one of its defaults (tooltip, motion, keyboard handling) gets overridden?" — is a legitimate one-way-door concern, but re-litigating the tour-engine choice at this stage would mean redoing the plan's entire approach section for a decision made deliberately upstream (with research backing it). Recorded as an explicit, acknowledged design decision in plan.md rather than acted on. See Open questions below.
- Scope Auditor's "FALSE OUT-OF-SCOPE" claim that editing `app/playbook/page.tsx` violates scope — rejected as a misreading; FR17 only requires the page's *output/behavior* not regress, not that the file itself stay untouched. The extraction is explicitly required by FR16.
- Design Devil's Advocate's suggestion to lift tour state to a layout-level context now, anticipating a future multi-page tour — rejected as speculative architecture for explicitly out-of-scope functionality (YAGNI).
- Steps Critic's proposal for a dedicated new "skipped state" UI component — rejected in favor of a cheaper fix: FR10 now defines completion/skip as inherently distinct by modal-presence-or-absence, no new component needed.
- Data Model Critic's flag about no namespace room for a future multi-user/account id in the localStorage key — rejected; multi-device/multi-user sync is explicitly out of scope already, adding room for it now is premature.
- Scope Auditor's note on unexplained 85/80/85/85 coverage numbers — rejected; these are the project's existing global QA bar (NFR: "maintained or exceeded"), not invented for this feature.

## Open questions requiring human input
- **Is react-joyride still the right call for this feature**, given the final design overrides its tooltip, its motion, and (partially) its keyboard handling, keeping mainly its step-sequencing and target-tracking? The alternative (a lighter positioning primitive like Floating UI, or a fully hand-rolled overlay) was seriously raised by the Design Devil's Advocate agent. This spec keeps react-joyride as originally scoped, but it's worth a quick gut-check before `/new-story` starts building 8+ files around its API shape, since swapping later is a rewrite of the whole orchestration layer, not a swap.
