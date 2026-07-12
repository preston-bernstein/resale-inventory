# Steps: Interactive Presale Tutorial with Motion UX

## Prerequisites
None. The add-item forms and playbook page already exist with all required content; react-joyride is the only new external dependency, and it has no peer-dependency conflicts with React 19.

## Implementation steps

### Step 1: Extract SELLER_WORKFLOW_STEPS to shared library
**What**: Move the existing 17-step STEPS array from `app/playbook/page.tsx` into a new shared module so both the static page and the tour read from a single authoritative source.
**Files**: `lib/sellerWorkflowSteps.ts` (create).
**Test**: Run `tsc --noEmit` to verify exports; confirm the new file exports `SELLER_WORKFLOW_STEPS` as a 17-element array of strings with recognizable step titles (e.g., "Find the item", "Check condition").
**Depends on**: none.
**Parallelizable**: No.

### Step 2: Update app/playbook/page.tsx to import SELLER_WORKFLOW_STEPS
**What**: Replace the inline `const STEPS = [...]` array in app/playbook/page.tsx with an import statement from lib/sellerWorkflowSteps.
**Files**: `app/playbook/page.tsx` (modify).
**Test**: `npm run build` succeeds; `npm run test:unit -- app/playbook` passes; render the page via Vitest using testing-library and verify the step list content matches the imported SELLER_WORKFLOW_STEPS array.
**Depends on**: 1.
**Parallelizable**: No.

### Step 3: Create shared anchor-name constants (lib/tourAnchors.ts)
**What**: Create a new module that exports data-tour string constants for both tour categories. Export two objects: `CLOTHING_ANCHORS` with keys `brand`, `size`, `condition`, `measurements`, `acquisition`, `submit` and corresponding values like `"clothing-brand"`, etc.; and `BOOK_ANCHORS` with keys `isbn`, `title`, `author`, `condition`, `acquisition`, `submit` and corresponding values like `"book-isbn"`, etc. These constants are used both as `data-tour` attribute values in the form components and as Joyride `target` selectors in lib/tourSteps.ts.
**Files**: `lib/tourAnchors.ts` (create).
**Test**: Run `tsc --noEmit` to verify exports; manually verify both objects export exactly 6 keys each and all values are non-empty strings in the format `"category-field"`.
**Depends on**: none.
**Parallelizable**: No.

### Step 4: Create lib/useReducedMotion.ts hook
**What**: Implement a React hook that listens to the `prefers-reduced-motion: reduce` media query and returns true when motion should be reduced, with cleanup on unmount.
**Files**: `lib/useReducedMotion.ts` (create).
**Test**: Render a component using the hook; verify it returns `false` in the test environment by including an explicit `window.matchMedia` mock/stub in the test setup (jsdom does NOT implement `window.matchMedia` by default—calling it without a mock throws `TypeError`, it does not return a benign falsy value); manually test on a real browser with OS reduced-motion enabled and confirm the hook detects it; verify `matchMedia` listener is cleaned up on unmount.
**Depends on**: none.
**Parallelizable**: No.

### Step 5: Create lib/tourSteps.ts with tour step definitions and add react-joyride to package.json
**What**: (1) Add `react-joyride@3.2.0` (pinned exact version, no caret) to package.json; confirm peer-dependency compatibility with React 19 (react-joyride 3.2.0 declares react/react-dom '16.8 - 19'). (2) Define two arrays—CLOTHING_TOUR_STEPS (6 steps) and BOOK_TOUR_STEPS (6 steps)—each shaped as react-joyride Step objects with `target` (data-tour selector from lib/tourAnchors, e.g., `[data-tour='clothing-brand']`), `content`, `title`, and other required Joyride fields. Draw step content from SELLER_WORKFLOW_STEPS and the prose descriptions already in the playbook's pricing/prep sections.
**Files**: `package.json` (modify), `lib/tourSteps.ts` (create).
**Test**: `npm install` succeeds; `node_modules/react-joyride/package.json` exists and confirms version 3.2.0; no peer-dependency warnings. Run `tsc --noEmit` passes; manually verify both arrays export exactly 6 entries; each step has valid `target` (using tourAnchors constants), `content` (non-empty string), and `title`; Joyride type-checks with no errors.
**Depends on**: 1, 3.
**Parallelizable**: No.

### Step 6: Create components/tour/TourTooltip.tsx
**What**: Build a custom Tailwind-styled tooltip component that serves as react-joyride's `tooltipComponent`. Include Next/Back/Skip buttons, proper alignment, CSS fade-in/fade-out transitions using `opacity-0 → opacity-100` with `motion-reduce:` variants, role="dialog", visible focus rings, and a manual focus trap that keeps Tab/Shift+Tab cycling within the tooltip's visible and enabled controls.
**Files**: `components/tour/TourTooltip.tsx` (create).
**Test**: Render the tooltip with mock Joyride props; verify fade-in transition applies on mount (check for `opacity-100`); click Next/Back/Skip and verify they emit correct Joyride actions; press Tab multiple times and verify focus cycles only through visible/enabled buttons (accounting for Back hidden on step 1, Next becoming "Finish" on last step); press Escape and verify it's handled (expect the parent to close the tour); verify `motion-reduce:opacity-100 motion-reduce:transition-none` classes suppress animations in reduced-motion mode.
**Depends on**: 5.
**Parallelizable**: Yes.

### Step 7: Create components/tour/TourCompletionModal.tsx
**What**: Build a modal component displayed when the tour reaches its final step, built on the native `<dialog>` element. Include a Tailwind fade+scale enter/exit transition (`opacity-0 scale-95 → opacity-100 scale-100`), a centered congratulatory message, a Close button, role="alertdialog", Escape-to-close support, and a focus trap that returns focus to the entry button after dismissal.
**Files**: `components/tour/TourCompletionModal.tsx` (create).
**Test**: Render the modal; verify it fades in and scales up; press Escape and verify it closes; click Close button and verify it emits an `onClose` callback; verify `motion-reduce:` classes suppress the scale animation when reduced-motion is enabled; verify focus is trapped within the modal while open.
**Depends on**: none.
**Parallelizable**: Yes.

### Step 8: Create lib/tourStateMachine.ts and components/tour/PresaleTour.tsx with Joyride basics
**What**: (1) Create lib/tourStateMachine.ts containing pure state-machine decision logic for tour advancement: functions that take current `stepIndex`, Joyride action (STEP_AFTER, ACTIONS.CLOSE), and return the next `stepIndex` or a closing signal. (2) Create components/tour/PresaleTour.tsx as the main tour orchestrator that wraps react-joyride with controlled `run`, `stepIndex`, and `steps` props; implements the callback handler for `STEP_AFTER` (advance/retreat using the state machine logic), and `ACTIONS.CLOSE` (skip). Mount the Joyride component with these controlled props; verify steps increment/decrement on callback.
**Files**: `lib/tourStateMachine.ts` (create), `components/tour/PresaleTour.tsx` (create).
**Test**: Mount the component with `open=true` and a category; verify step 1 renders; click "Next" button (via Joyride's callback) and verify `stepIndex` increments and step 2 renders; click "Back" and verify `stepIndex` decrements. Verify the state machine logic handles all STEP_AFTER transitions correctly and that the controlled props keep Joyride in sync.
**Depends on**: 5, 6, 7.
**Parallelizable**: No.

### Step 9: Add status/localStorage and TARGET_NOT_FOUND handling to PresaleTour.tsx
**What**: Extend PresaleTour.tsx to handle `STATUS.FINISHED` (show completion modal), `STATUS.SKIPPED` (close tour), and `TARGET_NOT_FOUND` (close tour silently). Add localStorage read on mount (reading from two per-category versioned keys: `presale-tour:v1:book` and `presale-tour:v1:clothing`) to determine prior completion state; write localStorage when tour completes or is dismissed with completion status. Implement `onOpenChange(false)` callback to signal to parent when tour should close.
**Files**: `components/tour/PresaleTour.tsx` (modify).
**Test**: Mount the component with `open=true`; click "Skip" and verify `onOpenChange(false)` is called and localStorage is written with the per-category key; reload and verify the component reads the persisted state correctly. Test TARGET_NOT_FOUND by rendering with an invalid category; verify the tour closes silently without error. Fill in a form field, navigate through the tour, skip it, reload, and verify the form input is still there (localStorage keys are per-category and do not interfere with form data).
**Depends on**: 8.
**Parallelizable**: No.

### Step 10: Add keyboard and focus management to PresaleTour.tsx
**What**: Attach a `keydown` listener to PresaleTour that treats Escape as an authoritative close signal (tear down tour and set localStorage) independent of Joyride's own Escape handling; implement a manual Tab focus trap at the component level that cycles focus between the tooltip's controls (Next/Back/Skip) and, when the completion modal is open, only through its Close button; ensure visible focus rings on all interactive elements.
**Files**: `components/tour/PresaleTour.tsx` (modify).
**Test**: Launch the tour via keyboard-only (Tab to button, Enter to open); navigate steps with Tab and Enter on buttons; press Escape at any step and verify the tour closes (form is left intact, localStorage is set); verify Tab does not escape to elements outside the tour controls; run keyboard-only navigation (no mouse) through all steps, completion modal, and close; verify all controls have a visible outline/ring on focus.
**Depends on**: 9.
**Parallelizable**: No.

### Step 11: Add data-tour anchors to components/AddClothingForm.tsx
**What**: Add `data-tour` attributes to wrapper elements in AddClothingForm using constants from lib/tourAnchors: wrap the brand field with `data-tour={CLOTHING_ANCHORS.brand}`, size field with `data-tour={CLOTHING_ANCHORS.size}`, the ConditionSelect with `data-tour={CLOTHING_ANCHORS.condition}`, the CLOTHING_MEASUREMENT_FIELDS block with a new `<div data-tour={CLOTHING_ANCHORS.measurements}>`, AcquisitionFields with `data-tour={CLOTHING_ANCHORS.acquisition}`, and SubmitButton with `data-tour={CLOTHING_ANCHORS.submit}`. No changes to field validation, logic, or submission.
**Files**: `components/AddClothingForm.tsx` (modify).
**Test**: Inspect the DOM via browser dev tools or a test query and verify all six attributes are present and correctly target the intended elements using tourAnchors constants; verify the form still submits and validates as before; verify form input is not cleared by the new attributes.
**Depends on**: 3.
**Parallelizable**: Yes.

### Step 12: Add data-tour anchors to components/AddBookForm.tsx
**What**: Add `data-tour` attributes to wrapper elements in AddBookForm using constants from lib/tourAnchors: ISBN field with `data-tour={BOOK_ANCHORS.isbn}`, title with `data-tour={BOOK_ANCHORS.title}`, author with `data-tour={BOOK_ANCHORS.author}`, ConditionSelect with `data-tour={BOOK_ANCHORS.condition}`, AcquisitionFields with `data-tour={BOOK_ANCHORS.acquisition}`, and SubmitButton with `data-tour={BOOK_ANCHORS.submit}`. No changes to field validation, logic, or submission.
**Files**: `components/AddBookForm.tsx` (modify).
**Test**: Inspect the DOM and verify all six attributes are present and correctly target the intended elements using tourAnchors constants; verify the form still submits and validates as before; verify form input is not cleared by the new attributes.
**Depends on**: 3.
**Parallelizable**: Yes.

### Step 13: Add tour entry button and state to app/inventory/new/page.tsx
**What**: Add a React state variable `tourOpen` and `setTourOpen` to the page component; render a button ("Take the tour" / "Retake the tour") that reads localStorage to determine the label and sets `tourOpen=true` on click; render the `<PresaleTour category={category} open={tourOpen} onOpenChange={setTourOpen} />` component; add a `useEffect` that closes the tour automatically if the category toggle changes while `tourOpen` is true (to avoid stale Joyride targets). Reload and verify the button label changes to "Retake" if the tour was previously completed.
**Files**: `app/inventory/new/page.tsx` (modify).
**Test**: Navigate to `/inventory/new`, click the tour button, verify step 1 appears anchored to the corresponding form element; fill in a field (e.g., brand), click through 2+ steps, then skip; reload the page and verify the field value is still there and the tour button label changed to "Retake"; toggle from Book to Clothing while the tour is open and verify the tour closes automatically; verify the form's existing add/submit flow is unaffected by running the existing AddClothingForm.test.tsx and AddBookForm.test.tsx test suites unmodified.
**Depends on**: 9, 10, 11, 12.
**Parallelizable**: No.

### Step 14: Create unit tests for PresaleTour and lib/tourStateMachine.ts
**What**: Write a Vitest test suite for `PresaleTour.tsx` and `lib/tourStateMachine.ts`. Cover rendering, button interactions (Next/Back/Skip via state machine), Escape key close, localStorage read/write with per-category versioned keys, focus management, TARGET_NOT_FOUND handling, and completion modal display. For the state machine, test all STEP_AFTER transitions, boundary conditions (first step, last step), and close-signal handling. Ensure coverage meets 85/80/85/85 thresholds.
**Files**: `components/tour/__tests__/PresaleTour.test.tsx` (create).
**Test**: Run `npm run test:unit` and verify all tests pass; run `npm run test:unit -- --coverage` and confirm statements, branches, functions, lines all ≥85% for `components/tour/PresaleTour.tsx` and `lib/tourStateMachine.ts`; manually inspect that each test exercises a realistic flow (e.g., tour start → click Next → step 2 appears via state machine → click Skip → tour closes, localStorage set with per-category key).
**Depends on**: 9, 10.
**Parallelizable**: No.

### Step 15: Create unit tests for TourTooltip.tsx
**What**: Write a Vitest test suite for `TourTooltip.tsx`. Cover rendering with various button states (Back hidden on step 1, Next text becomes "Finish" on last step), button interactions (Next/Back/Skip emit correct actions), Escape key handling, focus trap (Tab cycles through visible/enabled buttons only), and transition class presence (`opacity-100`, fade animations) and motion-reduce suppression (`motion-reduce:opacity-100 motion-reduce:transition-none`). Ensure coverage meets 85/80/85/85 thresholds.
**Files**: `components/tour/__tests__/TourTooltip.test.tsx` (create).
**Test**: Run `npm run test:unit` and verify all tests pass; run `npm run test:unit -- --coverage` and confirm coverage ≥85% for `components/tour/TourTooltip.tsx`; manually inspect tests for button-state variations across step positions.
**Depends on**: 6.
**Parallelizable**: No.

### Step 16: Create unit tests for TourCompletionModal, lib/tourSteps.ts, lib/useReducedMotion.ts, and update stryker.conf.json
**What**: (1) Write a Vitest test suite for `TourCompletionModal.tsx` covering modal rendering, fade+scale transitions, Escape-to-close, Close button callback, motion-reduce class suppression, and focus trap. (2) Write unit tests for `lib/tourSteps.ts` covering both CLOTHING_TOUR_STEPS and BOOK_TOUR_STEPS arrays—verify 6 entries each, valid targets from tourAnchors, non-empty content/title, and Joyride type compatibility. (3) Write unit tests for `lib/useReducedMotion.ts` covering hook return value, matchMedia listener attachment/cleanup, and motion-detection logic. Ensure coverage meets 85/80/85/85 thresholds for all three. (4) Update `stryker.conf.json` to add `lib/tourStateMachine.ts`, `lib/tourSteps.ts`, and `lib/useReducedMotion.ts` to the `mutate` array so mutation testing exercises category branching logic, step definitions, and motion-detection logic.
**Files**: `components/tour/__tests__/TourCompletionModal.test.tsx` (create), `stryker.conf.json` (modify).
**Test**: Run `npm run test:unit` and verify all tests pass; run `npm run test:unit -- --coverage` and confirm coverage ≥85% for `components/tour/TourCompletionModal.tsx`, `lib/tourSteps.ts`, and `lib/useReducedMotion.ts`. Run `npm run test:mutation`; verify the command completes without error and both new files appear in the mutated list; spot-check that branching logic (e.g., category === 'book' conditionals) generates mutations and that test coverage catches them.
**Depends on**: 7, 14, 15.
**Parallelizable**: No.

### Step 17: Create E2E tests for tour flow (AC1-4: anchor/step-count/skip/form-preservation)
**What**: Write Playwright tests in `tests/e2e/presale-tour.spec.ts` covering acceptance criteria AC1–AC4: (AC1) tour starts and step 1 tooltip anchors to a real form element (brand field for clothing, ISBN for book); (AC2) clicking through all steps reaches completion (5–7 total steps); (AC3) form input typed before tour, then tour + steps, then skip—input still present; (AC4) same as AC3 but for book category. Use `BOOKSELLER_DB_PATH` override to avoid touching the real database.
**Files**: `tests/e2e/presale-tour.spec.ts` (create).
**Test**: Run `npm run test:e2e -- presale-tour.spec.ts` and verify all AC1-AC4 tests pass; smoke-test the tour on the real `/inventory/new` page for both Book and Clothing categories.
**Depends on**: 13.
**Parallelizable**: No.

### Step 18: Create E2E tests for tour flow (AC5-AC6: motion)
**What**: Extend Playwright tests in `tests/e2e/presale-tour.spec.ts` to cover acceptance criteria AC5–AC6: (AC5) with `page.emulateMedia({ reducedMotion: 'reduce' })`, launch the tour and verify no fade/scale transitions play (instant opacity/scale to final state); (AC6) without reduced-motion emulation, verify transitions play (fade-in, scale-up animations are visually present).
**Files**: `tests/e2e/presale-tour.spec.ts` (modify).
**Test**: Run `npm run test:e2e -- presale-tour.spec.ts` and verify all AC5-AC6 tests pass; run the full E2E suite and confirm no regressions to existing tests.
**Depends on**: 13.
**Parallelizable**: No.

### Step 19: Create E2E tests for tour flow (AC7/AC8/AC13: keyboard/persistence)
**What**: Extend Playwright tests in `tests/e2e/presale-tour.spec.ts` to cover acceptance criteria AC7, AC8, and AC13: (AC7) Escape closes tour from any step (form is left intact, localStorage is set); (AC8) after completion, reloading page does not auto-launch tour (tour button label changes to "Retake", but tour does not open automatically); manual click re-launches tour. (AC13) Tab-only navigation works end-to-end (no mouse interaction—Tab to button, Enter to open, Tab through tooltip buttons, Escape to close).
**Files**: `tests/e2e/presale-tour.spec.ts` (modify).
**Test**: Run `npm run test:e2e -- presale-tour.spec.ts` and verify all AC7/AC8/AC13 tests pass; run the full E2E suite and confirm no regressions.
**Depends on**: 13.
**Parallelizable**: No.

### Step 20: Run the complete QA bar as one closing gate
**What**: Execute all linting, type-checking, unit test coverage, Playwright E2E, and Stryker mutation testing in a single final validation run before considering the feature complete. This gate ensures no isolated test suite passed while others failed, and no regressions were introduced across the full feature surface.
**Files**: none (orchestration step).
**Test**: Run `npm run lint && npm run type-check && npm run test:unit -- --coverage && npm run test:e2e && npm run test:mutation` in sequence; verify all commands exit with code 0; review unit test coverage output and confirm ≥85% across all modified and new files; review Stryker report and confirm mutations were caught by tests.
**Depends on**: 16, 17, 18, 19.
**Parallelizable**: No.

## Rollback plan
- **Steps 1–2**: Revert app/playbook/page.tsx to inline STEPS array, delete lib/sellerWorkflowSteps.ts.
- **Step 3**: Delete lib/tourAnchors.ts.
- **Step 4**: Delete lib/useReducedMotion.ts.
- **Step 5**: Remove react-joyride from package.json, run `npm install`; delete lib/tourSteps.ts.
- **Steps 6–20**: Delete all new files (lib/tourStateMachine.ts, components/tour/*, tests/e2e/presale-tour.spec.ts), revert modified files (app/playbook/page.tsx, components/AddClothingForm.tsx, components/AddBookForm.tsx, app/inventory/new/page.tsx, stryker.conf.json) to their pre-feature state via `git checkout`.
- **Stale localStorage**: Per-category versioned keys (`presale-tour:v1:book`, `presale-tour:v1:clothing`) left behind by a rollback are harmless orphaned client-side data requiring no cleanup action; browsers will ignore them.
- **Stryker config revert**: Reverting the stryker.conf.json mutate-array change is an isolated, low-risk single-array edit.
- **General**: If all changes are in a single git branch, `git reset --hard` to the last known-good commit. All changes are additive or isolated; no cascading deletions or schema migrations to reverse.

---

Steps written: 20 steps, 2 marked parallelizable.
