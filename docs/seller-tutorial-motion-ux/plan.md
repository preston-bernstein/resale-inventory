# Plan: Interactive Presale Tutorial with Motion UX

## Approach
Extract the existing `STEPS` array out of `app/playbook/page.tsx` into a shared `lib/` module so both the static playbook page and a new guided tour read from one source, then layer React Joyride (the sole approved new dependency) on top of `app/inventory/new/page.tsx` as a controlled, opt-in overlay that targets `data-tour` anchors added to the real form fields in `AddClothingForm.tsx`/`AddBookForm.tsx`. All enter/exit motion (tooltip fade, completion-modal fade+scale) is hand-authored Tailwind CSS driven by component state, not Joyride's own transitions and not an animation library, with Tailwind's `motion-reduce:` variant and a small `matchMedia` hook covering `prefers-reduced-motion`. Tour-completion state lives in `localStorage` only — no schema, no server round trip, nothing that touches `better-sqlite3`.

## Design decisions

**Why react-joyride is still the tour engine despite overriding all its defaults.** Every visual and interaction default Joyride ships with — its built-in tooltip rendering, its transition/animation timing, its Escape/keyboard handling — is turned off or replaced in this plan (see Motion/interaction details below). What's actually retained is step-sequencing bookkeeping (current step index, next/back/skip/finish status machine) and Joyride's internal target-tracking: its ResizeObserver/MutationObserver-based repositioning of the spotlight/tooltip when the anchored element moves or resizes, and its default `scrollIntoView` behavior when a target is off-screen. Hand-rolling an equivalent overlay (spotlight math, resize/mutation observers, scroll-into-view, step bookkeeping) was weighed against this and rejected for this iteration as disproportionate rework given Joyride already does it correctly and is the one approved new dependency. This is a decision worth revisiting only if a second, unrelated tour is ever built elsewhere in the app — at that point the case for a shared hand-rolled overlay (amortized across two tours) would be stronger.

**React 19 compatibility is verified, not assumed.** `npm view react-joyride peerDependencies` was run against the published `3.2.0` release; it returns `{ react: '16.8 - 19', 'react-dom': '16.8 - 19' }`. This repo runs React 19.1.0, which falls inside that declared range. This is a checked fact from the command above, not an inference from changelogs, issues, or general "should be fine" reasoning.

## Architecture

```
app/inventory/new/page.tsx  (AddItemPage, 'use client', owns `category` state today)
  ├─ category toggle (Book/Clothing) — existing
  ├─ [NEW] "Take the tour" / "Retake the tour" button  ──┐
  ├─ AddBookForm / AddClothingForm (existing, unchanged   │
  │     logic; new data-tour="..." attrs on field wrappers)│
  └─ [NEW] <PresaleTour category={category}               │
             open={tourOpen} onOpenChange={setTourOpen}/>  ◄┘
              │
              ├─ react-joyride <Joyride> (controlled: run, stepIndex, steps)
              │     steps ← lib/tourSteps.ts
              │     tooltipComponent ← components/tour/TourTooltip.tsx (Tailwind fade)
              │     callback → handles STEP_AFTER / CLOSE / SKIPPED / FINISHED
              │
              ├─ on FINISHED → components/tour/TourCompletionModal.tsx (Tailwind fade+scale)
              ├─ on SKIPPED/CLOSE → instant teardown, no modal
              └─ writes localStorage["presale-tour:v1:<category>"] = '{"completed":true}'

lib/sellerWorkflowSteps.ts  (NEW — moved verbatim out of app/playbook/page.tsx)
  └─ imported by:
        app/playbook/page.tsx        (renders all 17, unchanged output)
        lib/tourSteps.ts             (picks a themed subset per category)

lib/tourSteps.ts (NEW)
  └─ CLOTHING_TOUR_STEPS: Step[]  (react-joyride Step shape; target = data-tour selector)
  └─ BOOK_TOUR_STEPS: Step[]
     each step's copy references/derives from SELLER_WORKFLOW_STEPS[i] or
     docs/clothing-resale-research.md §7 prose already surfaced in
     app/playbook/page.tsx's Section components (pricing/prep/listing text)

lib/useReducedMotion.ts (NEW) — matchMedia('(prefers-reduced-motion: reduce)') hook,
  used only for JS-timed step-transition orchestration (CSS side uses Tailwind's
  motion-reduce: variant directly, no JS needed there)
```

Data flow is one-directional and local: button click → `tourOpen=true` → `PresaleTour` mounts Joyride with the step set matching the currently-rendered form → user navigates with Next/Back/Skip/Escape, form state in `AddClothingForm`/`AddBookForm` is never touched (Joyride only reads the DOM to position tooltips, it never writes to it) → on end, a `localStorage` flag is set and focus returns to the entry button.

## Motion/interaction details
Joyride ships its own `styles.options` transition timing (tooltip/spotlight fade and movement animations) and its own Escape/overlay-close handling. Both are explicitly neutralized rather than left to run alongside the hand-authored behavior:

- **Transitions**: Joyride's `styles` prop sets every `styles.options` duration-bearing value to zero (no transition/animation), so Joyride's own tooltip/spotlight animations never run. The only visible motion is the hand-authored Tailwind `transition-all duration-200 ease-out` on `TourTooltip`/`TourCompletionModal` described in the Motion contract below.
- **Escape/overlay-close**: Joyride's `disableCloseOnEsc` prop (and its equivalent overlay-click-to-close behavior) is explicitly set so Joyride never independently closes or advances the tour in response to Escape or an overlay click. `PresaleTour`'s own `keydown` listener (see Keyboard contract) is the single, authoritative Escape path — without disabling Joyride's own handling, Joyride and `PresaleTour` could both react to the same Escape keypress and double-fire teardown/state changes.

## Data model
No data model changes. No SQLite tables, no migrations, no API routes. The only persisted state is two per-category, versioned `localStorage` keys, written client-side:

```
key:   "presale-tour:v1:book"
value: {"completed": true}   (JSON string)

key:   "presale-tour:v1:clothing"
value: {"completed": true}   (JSON string)
```

Per-category (rather than one global flag) because completing the clothing tour must not permanently hide the book tour's "not yet seen" entry-button state, and vice versa — a real UX bug two reviewers flagged independently against a single shared flag. The `v1` segment and the JSON object shape (rather than a bare string) future-proof the key for e.g. a completion timestamp later, without a breaking migration.

Read once on mount of `app/inventory/new/page.tsx` (or inside `PresaleTour`), keyed by the currently-selected `category`, purely to decide the entry button's label ("Take the tour" vs "Retake the tour") — never to auto-launch the tour, per FR2/FR8/AC8.

## API / interface contract
No HTTP endpoints. UI-level contract:

- **Entry point** — a button rendered in `app/inventory/new/page.tsx` near the `<h1>`/category toggle. `onClick` sets `tourOpen=true`. Always present and always clickable, regardless of prior completion state (FR9).
- **`PresaleTour` component props**:
  ```ts
  interface PresaleTourProps {
    category: 'book' | 'clothing'; // existing Category type from lib/constants
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }
  ```
- **Events surfaced via Joyride's `callback`**: `STEP_AFTER` (advance/retreat `stepIndex`, orchestrating the fade-out/fade-in described below), `ACTIONS.CLOSE`/`STATUS.SKIPPED` (instant teardown, no modal, `onOpenChange(false)`, write localStorage), `STATUS.FINISHED` (show `TourCompletionModal`, then on its close write localStorage and `onOpenChange(false)`).
- **Keyboard contract** (FR14, AC7, AC13): Escape closes/skips identically to clicking Skip at any step (verified: Joyride's own Escape handling is not guaranteed sufficient — see Risk areas — so `PresaleTour` attaches its own `keydown` listener while `open` is true as the authoritative Escape path, and Joyride's own `disableCloseOnEsc`/overlay-close handling is explicitly turned off — see Motion/interaction details — so the two never double-fire). Tab/Shift+Tab cycle only through the tooltip's own Back/Next/Skip controls — implemented as a small manual focus trap (`onKeyDown` cycling focus between the container's first/last focusable element) in `TourTooltip`, not a new dependency. When the completion modal is open, Tab/Shift+Tab cycling and Escape-to-close come from the native HTML `<dialog>` element's built-in focus-trapping and Escape behavior (see `TourCompletionModal` in Integration points) rather than a hand-rolled trap.
- **Motion contract**: tooltip and modal each render with `opacity-0 scale-95` initially, flip to `opacity-100 scale-100` one animation frame after mount (`transition-all duration-200 ease-out`), and reverse on close, with actual unmount deferred until the transition ends (via `transitionend` listener or a timeout matched to the Tailwind duration class) so exit animation always plays (FR11/FR12, AC3/AC5/AC6). All transition/scale utility classes are paired with `motion-reduce:transition-none motion-reduce:duration-0` so `prefers-reduced-motion: reduce` collapses them to instant show/hide (FR13).
- Error cases: if a `data-tour` target is missing from the DOM (e.g., stale selector after a future form refactor), Joyride's `disableScrolling`/`spotlightClicks` defaults apply and it emits a `TARGET_NOT_FOUND` callback status — `PresaleTour` treats this the same as Skip (tear down cleanly) rather than leaving a stuck tooltip, satisfying "no partial/stuck tour state" (FR6).

## Integration points
- `package.json` — add `react-joyride` pinned to an exact version (`3.2.0`, no `^` caret range) as the single new runtime dependency; commit the resulting `package-lock.json` change alongside it, run `npm audit` on the tree before merging, and spot-check the published package (tarball contents / `npm view react-joyride scripts`) for postinstall scripts or telemetry/network calls before merging, to confirm it doesn't violate the "no external network calls, local-first" constraint. React 19 peer-dep compatibility is a verified fact, not an assumption — see Design decisions.
- `lib/sellerWorkflowSteps.ts` (new file) — the 17-string `STEPS` array moved verbatim out of `app/playbook/page.tsx` and exported as `SELLER_WORKFLOW_STEPS`, becoming the single source of truth for both the static page and the tour (FR16, AC11).
- `app/playbook/page.tsx` — replace the inline `const STEPS = [...]` with `import { SELLER_WORKFLOW_STEPS as STEPS } from '@/lib/sellerWorkflowSteps'`; no other line changes, output and `app/playbook/__tests__/page.test.tsx` unaffected (FR17, AC10).
- `lib/tourAnchors.ts` (new file) — a shared module exporting the exact `data-tour` string literal constants for both categories, e.g. `CLOTHING_ANCHORS.brand`, `CLOTHING_ANCHORS.measurements`, `BOOK_ANCHORS.isbn`, `BOOK_ANCHORS.condition`, etc. `AddClothingForm.tsx`/`AddBookForm.tsx` use these constants (not inline string literals) for their `data-tour` attribute values, and `lib/tourSteps.ts` uses the same constants to build its Joyride `target` selector strings — this removes the risk of a typo between a form's attribute and a step's target silently causing `TARGET_NOT_FOUND`, which three separate reviewers flagged independently.
- `lib/tourSteps.ts` (new file) — `CLOTHING_TOUR_STEPS` / `BOOK_TOUR_STEPS`, each 6 entries (within the 5–7 range, FR3/AC2), typed against react-joyride's `Step`, targeting selectors built from `lib/tourAnchors.ts` constants and drawing copy from `SELLER_WORKFLOW_STEPS` indices and the prose already in the playbook's prep/pricing/listing sections.
- `lib/useReducedMotion.ts` (new file) — small hook for the JS-timed half of the reduced-motion contract (step-transition delay orchestration); the CSS half is plain Tailwind `motion-reduce:` classes needing no JS.
- `lib/tourStateMachine.ts` (new file) — the tour's callback/status state machine (advance/retreat/skip/finish decisions) extracted out of `components/tour/PresaleTour.tsx` into a pure, testable function that the component imports rather than inlines. This preserves the project's existing "no `components/**/*.tsx` mutated" convention (see `stryker.conf.json` update below) while still giving real mutation coverage to the single highest-risk piece of new logic called out in Risk areas.
- `components/tour/TourTooltip.tsx` (new file) — custom `tooltipComponent` for Joyride: Tailwind fade/scale transition, Next/Back/Skip buttons, `role="dialog"`, visible focus rings, manual Tab focus trap scoped to itself. Never uses `dangerouslySetInnerHTML`; all copy is static strings from `lib/tourSteps.ts`/`lib/sellerWorkflowSteps.ts`, never interpolated from user- or database-sourced data.
- `components/tour/TourCompletionModal.tsx` (new file) — end-of-tour modal built on the native HTML `<dialog>` element (`showModal()`/`close()`) rather than a fully hand-rolled focus trap, so focus-trapping and Escape-to-close come from the browser for free at zero new dependency cost — hand-rolling this was flagged by a reviewer as a well-known hard-to-get-right accessibility problem given no a11y library is in the dependency budget. Tailwind's `::backdrop` pseudo-element (or a simple overlay div) plus the existing `opacity-0 scale-95` → `opacity-100 scale-100` classes still deliver the fade+scale enter/exit motion; returns focus to the entry button on close. Never uses `dangerouslySetInnerHTML`; same static-copy-only constraint as `TourTooltip.tsx`.
- `components/tour/PresaleTour.tsx` (new file) — owns Joyride, controlled `stepIndex`/`run`, delegates advance/retreat/skip/finish decisions to `lib/tourStateMachine.ts`, the Escape keydown listener, and localStorage read/write. All `localStorage` reads happen inside `useEffect` (never at render time or module scope), to avoid a Next.js SSR/client hydration mismatch.
- `components/AddClothingForm.tsx` — **anchor point gap**: today there are zero `data-testid`/`data-tour` attributes anywhere in this file. Add `data-tour={CLOTHING_ANCHORS.brand}`, `{CLOTHING_ANCHORS.size}`, `{CLOTHING_ANCHORS.condition}` (wrapping the existing `<ConditionSelect>` call), `{CLOTHING_ANCHORS.measurements}` (new wrapping `<div>` around the `CLOTHING_MEASUREMENT_FIELDS.map(...)` block, which currently has no enclosing element), `{CLOTHING_ANCHORS.acquisition}` (wrapping `<AcquisitionFields>`), and `{CLOTHING_ANCHORS.submit}` (wrapping `<SubmitButton>`) — six anchors sourced from `lib/tourAnchors.ts`, purely additive markup, no field/validation/submission logic touched. A manual visual check is required after adding these wrappers — particularly the new wrapper `<div>` around the `CLOTHING_MEASUREMENT_FIELDS.map()` block — to confirm the existing Tailwind spacing/grid layout isn't visually altered by it.
- `components/AddBookForm.tsx` — same anchor-point gap. Add `data-tour={BOOK_ANCHORS.isbn}`, `{BOOK_ANCHORS.title}`, `{BOOK_ANCHORS.author}`, `{BOOK_ANCHORS.condition}` (wrapping `<ConditionSelect>`), `{BOOK_ANCHORS.acquisition}` (wrapping `<AcquisitionFields>`), `{BOOK_ANCHORS.submit}` (wrapping `<SubmitButton>`) — six anchors sourced from `lib/tourAnchors.ts`, additive only.
- `components/ConditionSelect.tsx` / `components/AcquisitionFields.tsx` — may need to accept and forward a `data-tour` prop onto their actual control element, rather than relying solely on the parent form's wrapping `<div>`, if a tour anchor must land precisely on the control rather than spotlighting the whole sub-component (a wrapping div would also spotlight unrelated label/hint whitespace around it).
- `app/inventory/new/page.tsx` — add the tour entry button, `tourOpen` state, render `<PresaleTour>`; guard against the category toggle being clicked mid-tour (stale Joyride targets) by closing the tour automatically if `category` changes while `tourOpen` is true.
- `stryker.conf.json` — add `lib/tourSteps.ts`, `lib/useReducedMotion.ts`, and `lib/tourStateMachine.ts` to the `mutate` array (not the `.tsx` components); all contain real branching logic (category selection, reduced-motion checks, tour advance/retreat/skip/finish decisions) that the project's existing mutation-testing convention (see current `lib/*.ts` entries, and the standing "no `components/**/*.tsx` mutated" convention) would otherwise silently skip.
- `components/__tests__/` / new `components/tour/__tests__/` — unit tests for `PresaleTour`, `TourTooltip`, `TourCompletionModal` (render, Next/Back/Skip, Escape, reduced-motion class assertions) to hold the 85/80/85/85 thresholds, which already auto-include any new file under `components/**/*.tsx` and `lib/**/*.ts` per `vitest.config.ts`'s existing `coverage.include` globs — no config change needed there.
- `tests/e2e/` (new spec, e.g. `presale-tour.spec.ts`) — Playwright E2E covering AC1–AC4, AC7, AC8, AC13, using `page.emulateMedia({ reducedMotion: 'reduce' })` for AC5/AC6.
- No change needed to `app/globals.css` — Tailwind v4's built-in utilities (`transition`, `opacity-*`, `scale-*`, `duration-*`, `ease-out`, `motion-reduce:*`, the existing `dark:` variant) cover every animation and theme need without new custom CSS.

## Technology choices
- **react-joyride (`3.2.0`, exact-pinned, MIT)** — the approved tour engine; keeps step sequencing, spotlighting, and target-tracking out of hand-rolled code while its `tooltipComponent`/`callback` extension points let every visual and motion requirement (Tailwind-only transitions, custom keyboard handling) be implemented outside its defaults, satisfying the "no other new dependency" constraint.
- **Tailwind `motion-reduce:` variant** (already shipped in Tailwind CSS 4, no addition) — declarative, CSS-only way to satisfy FR13's reduced-motion requirement for the animated classes themselves, verifiable in Playwright via `emulateMedia` without any custom JS media-query plumbing on the CSS side.
- **A hand-rolled `matchMedia` hook (`lib/useReducedMotion.ts`)** instead of a library — needed only for the handful of JS-side `setTimeout`/transition-duration decisions (e.g., how long to wait before actually advancing `stepIndex` so the exit animation is allowed to finish); trivial enough that pulling in a hook library would be gold-plating.

## Risk areas
- **Joyride's built-in keyboard/focus handling is not fully documented/guaranteed for this custom-tooltip configuration.** The plan assumes we cannot rely on Joyride to close on Escape or contain Tab focus once a custom `tooltipComponent` is supplied, and instead implements both by hand in `PresaleTour`/`TourTooltip`. This needs to be validated early (spike before full implementation) — if Joyride fights our manual listeners (e.g., double-handling Escape, or its portal stealing focus), the keyboard-contract requirements (FR14, AC7, AC13) become the hardest part of this feature.
- **Coordinating a two-phase (fade-out-old, fade-in-new) transition on every Next/Back click against Joyride's controlled `stepIndex` model** is the most intricate piece of new code here. Joyride doesn't natively support "animate then swap," so `PresaleTour` must intercept clicks, delay the actual `stepIndex` update, and keep the old and new step's target/positioning in sync with Joyride's internal `beacon`/`spotlight` state during that delay. Getting this wrong risks a visible jump or a spotlight briefly pointing at the wrong element.
- **Mid-tour category switch.** `AddItemPage` already lets the user toggle Book/Clothing while a tour targeting the other form's `data-tour` anchors is open, which would leave Joyride pointed at unmounted DOM nodes. The plan mitigates this by auto-closing the tour on category change, but that's a design choice worth confirming feels right in practice rather than jarring.
- **Bundle-size budget is unfixed.** Requirements leave the exact KB budget as `[TBD]`; react-joyride's own quoted ~34KB gzipped baseline is the only anchor point given, so there's no hard gate to check `npm run build` output against beyond "no other new dependency" (AC9), which is verifiable, and the size figure, which currently is not.
- **Six-step-per-category anchor mapping may feel thin relative to the 17-step playbook.** Because the add-item form only has fields for capture/cataloging (brand, size, condition, cost, etc.) and none for the post-listing steps (publish, ship, reprice), roughly two-thirds of `SELLER_WORKFLOW_STEPS` has no natural anchor on this page. The plan leans on referencing the relevant prose (pricing/condition/measurement guidance) rather than the literal step text for several steps — this is a legitimate, requirements-sanctioned adaptation ("naturally implied by which form is being toured") but the exact tooltip copy will need a light editorial pass at implementation time to avoid feeling like a stretch.
- **Async, layout-shifting form behavior isn't fully reconciled with Joyride's live target tracking.** `AddClothingForm`'s ~400ms-debounced autocomplete dropdowns and `AddBookForm`'s on-blur ISBN autofill (`lookupIsbn()`) can both shift layout after a tour step has already positioned its tooltip/spotlight. This is accepted as a known risk to manually verify during implementation (via the anchor steps' manual test pass), not a blocking redesign — Joyride's ResizeObserver/MutationObserver-based repositioning (see Design decisions) should largely cover it, but the interaction hasn't been exercised end-to-end yet.
- **Category-switch-mid-tour QA will surface a pre-existing, unrelated bug.** Switching category in `app/inventory/new/page.tsx` today unmounts the previously-rendered form entirely, losing its state — this is existing behavior, not something this feature introduces. It will resurface during manual QA of "switch category mid-tour" (see the auto-close mitigation above) and should not be mistaken for a regression caused by the tour work.
