# Tasks: Interactive Presale Tutorial with Motion UX

Generated from: docs/seller-tutorial-motion-ux/ on 2026-07-12

## Status legend
- [ ] pending
- [>] in progress
- [x] done
- [!] blocked

## Tasks

### Task 1: Extract SELLER_WORKFLOW_STEPS to shared library
**Status**: [x] done
**Files**: lib/sellerWorkflowSteps.ts (create)
**Test**: Run `tsc --noEmit`; confirm the new file exports `SELLER_WORKFLOW_STEPS` as a 17-element array of strings with recognizable step titles.
**Depends on**: none
**Parallelizable**: No
**Notes**:

### Task 2: Update app/playbook/page.tsx to import SELLER_WORKFLOW_STEPS
**Status**: [x] done
**Files**: app/playbook/page.tsx (modify)
**Test**: `npm run build` succeeds; playbook unit test passes; rendered step list content matches the imported array.
**Depends on**: 1
**Parallelizable**: No
**Notes**:

### Task 3: Create shared anchor-name constants (lib/tourAnchors.ts)
**Status**: [x] done
**Files**: lib/tourAnchors.ts (create)
**Test**: `tsc --noEmit`; CLOTHING_ANCHORS and BOOK_ANCHORS each export exactly 6 non-empty string keys in "category-field" format.
**Depends on**: none
**Parallelizable**: No
**Notes**:

### Task 4: Create lib/useReducedMotion.ts hook
**Status**: [x] done
**Files**: lib/useReducedMotion.ts (create)
**Test**: Render a component using the hook with an explicit window.matchMedia mock in test setup; verify cleanup on unmount.
**Depends on**: none
**Parallelizable**: No
**Notes**:

### Task 5: Create lib/tourSteps.ts and add react-joyride to package.json
**Status**: [x] done
**Files**: package.json (modify), lib/tourSteps.ts (create)
**Test**: `npm install` succeeds with react-joyride pinned at 3.2.0, no peer-dep warnings; `tsc --noEmit`; CLOTHING_TOUR_STEPS/BOOK_TOUR_STEPS each export 6 valid Step entries using tourAnchors targets.
**Depends on**: 1, 3
**Parallelizable**: No
**Notes**:

### Task 6: Create components/tour/TourTooltip.tsx
**Status**: [x] done
**Files**: components/tour/TourTooltip.tsx (create)
**Test**: Render with mock Joyride props; fade-in transition applies; Next/Back/Skip emit correct actions; Tab cycles only visible/enabled buttons; motion-reduce classes suppress animation.
**Depends on**: 5
**Parallelizable**: Yes
**Notes**:

### Task 7: Create components/tour/TourCompletionModal.tsx
**Status**: [x] done
**Files**: components/tour/TourCompletionModal.tsx (create)
**Test**: Native `<dialog>`-based modal fades+scales in; Escape closes; Close button emits onClose; motion-reduce suppresses scale; focus trapped while open.
**Depends on**: none
**Parallelizable**: Yes
**Notes**:

### Task 8: Create lib/tourStateMachine.ts and components/tour/PresaleTour.tsx (Joyride basics)
**Status**: [x] done
**Files**: lib/tourStateMachine.ts (create), components/tour/PresaleTour.tsx (create)
**Test**: Mount with open=true; step 1 renders; Next/Back advance/retreat stepIndex via state machine; controlled props stay in sync with Joyride.
**Depends on**: 5, 6, 7
**Parallelizable**: No
**Notes**:

### Task 9: Add status/localStorage and TARGET_NOT_FOUND handling to PresaleTour.tsx
**Status**: [x] done
**Files**: components/tour/PresaleTour.tsx (modify)
**Test**: Skip triggers onOpenChange(false) + per-category localStorage write; TARGET_NOT_FOUND closes silently; form input untouched across tour lifecycle.
**Depends on**: 8
**Parallelizable**: No
**Notes**:

### Task 10: Add keyboard and focus management to PresaleTour.tsx
**Status**: [x] done
**Files**: components/tour/PresaleTour.tsx (modify)
**Test**: Keyboard-only launch/navigate/close; Escape closes from any step; Tab never escapes tour controls; visible focus rings throughout.
**Depends on**: 9
**Parallelizable**: No
**Notes**:

### Task 11: Add data-tour anchors to components/AddClothingForm.tsx
**Status**: [x] done
**Files**: components/AddClothingForm.tsx (modify)
**Test**: All 6 data-tour attributes present via tourAnchors constants; form still submits/validates; input not cleared.
**Depends on**: 3
**Parallelizable**: Yes
**Notes**:

### Task 12: Add data-tour anchors to components/AddBookForm.tsx
**Status**: [x] done
**Files**: components/AddBookForm.tsx (modify)
**Test**: All 6 data-tour attributes present via tourAnchors constants; form still submits/validates; input not cleared.
**Depends on**: 3
**Parallelizable**: Yes
**Notes**:

### Task 13: Add tour entry button and state to app/inventory/new/page.tsx
**Status**: [x] done
**Files**: app/inventory/new/page.tsx (modify)
**Test**: Entry button anchors step 1; field value survives 2+ steps then skip + reload; button label becomes "Retake"; category toggle mid-tour auto-closes; existing AddClothingForm/AddBookForm test suites still pass unmodified.
**Depends on**: 9, 10, 11, 12
**Parallelizable**: No
**Notes**:

### Task 14: Create unit tests for PresaleTour and lib/tourStateMachine.ts
**Status**: [x] done
**Files**: components/tour/__tests__/PresaleTour.test.tsx (create)
**Test**: `npm run test:unit` passes; coverage ≥85% for PresaleTour.tsx and tourStateMachine.ts; realistic flow test (start→Next→Skip→localStorage set).
**Depends on**: 9, 10
**Parallelizable**: No
**Notes**:

### Task 15: Create unit tests for TourTooltip.tsx
**Status**: [x] done
**Files**: components/tour/__tests__/TourTooltip.test.tsx (create)
**Test**: `npm run test:unit` passes; coverage ≥85% for TourTooltip.tsx; button-state variations across step positions covered.
**Depends on**: 6
**Parallelizable**: No
**Notes**:

### Task 16: Create unit tests for TourCompletionModal/tourSteps/useReducedMotion + update stryker.conf.json
**Status**: [x] done
**Files**: components/tour/__tests__/TourCompletionModal.test.tsx (create), stryker.conf.json (modify)
**Test**: `npm run test:unit` passes; coverage ≥85% for all three files; `npm run test:mutation` completes, tourStateMachine.ts/tourSteps.ts/useReducedMotion.ts appear mutated.
**Depends on**: 7, 14, 15
**Parallelizable**: No
**Notes**:

### Task 17: E2E tests — AC1-4 (anchor/step-count/skip/form-preservation)
**Status**: [x] done
**Files**: tests/e2e/presale-tour.spec.ts (create)
**Test**: `npm run test:e2e -- presale-tour.spec.ts` passes AC1-AC4 for both categories.
**Depends on**: 13
**Parallelizable**: No
**Notes**: Genuine bug found: clicking Finish on the last step never shows TourCompletionModal — STEP_AFTER handler treats "advance past last index" as an instant close (like Skip) instead of routing to the FINISHED flow. AC2 test written correctly against intended behavior, fails against actual buggy behavior. Needs Task 9c fix in PresaleTour.tsx.

### Task 18: E2E tests — AC5-6 (motion)
**Status**: [x] done
**Files**: tests/e2e/presale-tour.spec.ts (modify)
**Test**: emulateMedia reduced-motion suppresses transitions (AC5); default shows visible transitions (AC6); full E2E suite has no regressions.
**Depends on**: 13
**Parallelizable**: No
**Notes**:

### Task 19: E2E tests — AC7/AC8/AC13 (keyboard/persistence)
**Status**: [x] done
**Files**: tests/e2e/presale-tour.spec.ts (modify)
**Test**: Escape closes tour (AC7); no auto-relaunch after completion, manual relaunch works (AC8); full keyboard-only run-through (AC13).
**Depends on**: 13
**Parallelizable**: No
**Notes**:

### Task 20: Run the complete QA bar as one closing gate
**Status**: [x] done
**Files**: none (orchestration step)
**Test**: `npm run lint && npm run typecheck && npm run test:coverage && npm run test:e2e && npm run test:mutation` all exit 0; coverage ≥85% across changed files; mutation report shows mutations caught.
**Depends on**: 16, 17, 18, 19
**Parallelizable**: No
**Notes**:


### Task 9b: Wire TourCompletionModal into PresaleTour.tsx (gap fix)
**Status**: [x] done
**Files**: components/tour/PresaleTour.tsx (modify)
**Test**: FINISHED status shows TourCompletionModal (distinct from SKIPPED, which shows no modal); closing the modal marks completion + onOpenChange(false).
**Depends on**: 9
**Parallelizable**: No
**Notes**: Orchestrator-identified gap — Task 9's original scope conflated FINISHED/SKIPPED handling without ever rendering the modal Task 7 built. Added mid-run to satisfy FR10/FR11.


### Task 9c: Fix Finish-click not showing completion modal (bug fix)
**Status**: [x] done
**Files**: components/tour/PresaleTour.tsx (modify), possibly lib/tourStateMachine.ts (modify)
**Test**: Clicking Finish on the last tour step shows TourCompletionModal (not an instant silent close).
**Depends on**: 17
**Parallelizable**: No
**Notes**: Root cause found by Task 17's E2E agent — STEP_AFTER's generic "close" branch fires on every real Finish click (advance past last index via ACTIONS.NEXT), racing out Joyride's own FINISHED/TOUR_END event before it can show the modal.

## Blocked / open
(populated during implementation)
