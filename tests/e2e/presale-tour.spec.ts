import { test, expect, type Page, type Locator } from '@playwright/test';
import { inputByLabel, uniqueSuffix } from './helpers';
import { CLOTHING_TOUR_STEPS, BOOK_TOUR_STEPS } from '@/lib/tourSteps';
import { CLOTHING_ANCHORS, BOOK_ANCHORS } from '@/lib/tourAnchors';

// Anchor id + tooltip title for each step, in the exact order the tour walks
// them (see lib/tourSteps.ts). Pulling `title` from the real step objects
// (rather than hardcoding copy here) keeps this spec from drifting if the
// tour copy changes.
const CLOTHING_STEP_ORDER = CLOTHING_TOUR_STEPS.map((step) => String(step.title));
const BOOK_STEP_ORDER = BOOK_TOUR_STEPS.map((step) => String(step.title));

/** The tour entry button label flips between "Take the tour" and "Retake the tour". */
function tourButton(page: Page) {
  return page.getByRole('button', { name: /the tour/i });
}

/** The Joyride tooltip rendered by TourTooltip (role="dialog"). */
function tourTooltip(page: Page) {
  return page.getByRole('dialog');
}

/** The TourCompletionModal (native <dialog role="alertdialog">). */
function completionModal(page: Page) {
  return page.getByRole('alertdialog');
}

/**
 * Opens the tour and gets step 1's tooltip on screen.
 *
 * react-joyride (v3) only auto-shows the tooltip directly on Next/Back
 * navigation between steps (see shouldHideBeacon in
 * node_modules/react-joyride/src/modules/step.ts — it hides the beacon only
 * when the triggering action is PREV/NEXT). On tour *start* it first renders
 * a "Beacon" — a pulsing dot button with accessible name matching the
 * locale's `open` string ("Open the dialog") — that the user must click
 * before the tooltip itself appears. This helper clicks the entry button and
 * then that beacon, landing on step 1's visible tooltip.
 */
async function startTour(page: Page): Promise<void> {
  await tourButton(page).click();
  await page.getByRole('button', { name: 'Open the dialog' }).click();
  await expect(tourTooltip(page)).toBeVisible();
  await page.waitForTimeout(500);
}

/**
 * Clicks the tooltip's "Next" button and waits for the *next* step's title
 * to actually appear in the tooltip.
 *
 * Important: asserting on the `[data-tour="..."]` wrapper div is NOT a valid
 * "did the tour advance" check — that div is part of the static form markup
 * and is present/visible regardless of tour state. Waiting on the tooltip's
 * own text content is the correct verification.
 *
 * TourTooltip (components/tour/TourTooltip.tsx) fades/scales itself in over
 * a 200ms CSS transition after mount (its own `visible` state flips true on
 * the next animation frame). Interacting with the *previous* tooltip's
 * "Next" button again before react-joyride has finished retargeting +
 * remounting the next step's tooltip is racy — observed empirically as the
 * next tooltip never mounting at all when the two clicks land back-to-back
 * with no settle time. A short pause after each transition confirms lets
 * that remount/animation finish before the next click fires.
 */
async function clickNextAndExpectStep(page: Page, nextStepTitle: string): Promise<void> {
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(tourTooltip(page)).toContainText(nextStepTitle);
  await page.waitForTimeout(500);
}

async function openClothingTab(page: Page): Promise<void> {
  await page.goto('/inventory/new');
  await expect(page.getByRole('heading', { name: 'Add Item' })).toBeVisible();
  await page.getByRole('button', { name: 'Clothing', exact: true }).click();
}

test.describe('Presale Tour', () => {
  test('AC1: starting the clothing tour anchors step 1 to the real data-tour element, form stays visible', async ({
    page,
  }) => {
    await openClothingTab(page);
    await startTour(page);

    // Step 1 tooltip is up, anchored to the real clothing-brand element.
    await expect(page.locator(`[data-tour="${CLOTHING_ANCHORS.brand}"]`)).toBeVisible();
    await expect(tourTooltip(page)).toContainText(CLOTHING_STEP_ORDER[0]);

    // The underlying AddClothingForm is still fully present/visible behind
    // the tooltip — the tour is an overlay, not a replacement.
    await expect(inputByLabel(page, 'Brand *')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Clothing Item' })).toBeVisible();
  });

  test('AC2: clicking Next through all 6 clothing tour steps reaches the completion modal', async ({ page }) => {
    await openClothingTab(page);
    await startTour(page);
    await expect(tourTooltip(page)).toContainText(CLOTHING_STEP_ORDER[0]);

    // Walk steps 2-6 via "Next", confirming each step's tooltip copy in turn
    // (steps 1-5 of the 0-indexed CLOTHING_STEP_ORDER array).
    for (let i = 1; i < CLOTHING_STEP_ORDER.length; i++) {
      await clickNextAndExpectStep(page, CLOTHING_STEP_ORDER[i]);
    }

    // Step 6 (last) — the button's *visible* text switches to "Finish", but
    // its accessible name stays "Last": react-joyride's primaryProps spreads
    // aria-label/title from `locale.last` ("Last") onto the button, and
    // TourTooltip.tsx (components/tour/TourTooltip.tsx) only overrides the
    // JSX children (visible text) to "Finish", not that aria-label. So the
    // role-accessible button to click is named "Last", not "Finish".
    await expect(tourTooltip(page)).toContainText(CLOTHING_STEP_ORDER[5]);
    await expect(page.locator(`[data-tour="${CLOTHING_ANCHORS.submit}"]`)).toBeVisible();
    const finishButton = page.getByRole('button', { name: 'Last', exact: true });
    await expect(finishButton).toBeVisible();
    await expect(finishButton).toHaveText('Finish');
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
    await finishButton.click();

    // Exactly 6 steps traversed lands on the completion modal.
    await expect(completionModal(page)).toBeVisible();
    await expect(completionModal(page)).toContainText("You're all set");
    await expect(tourTooltip(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(completionModal(page)).toBeHidden();
  });

  test('AC3: Skip after 2+ steps immediately removes all tour UI with no completion modal, form untouched', async ({
    page,
  }) => {
    await openClothingTab(page);
    await startTour(page);
    await expect(tourTooltip(page)).toContainText(CLOTHING_STEP_ORDER[0]);

    // Advance a couple of steps first.
    await clickNextAndExpectStep(page, CLOTHING_STEP_ORDER[1]);
    await clickNextAndExpectStep(page, CLOTHING_STEP_ORDER[2]);

    await page.getByRole('button', { name: 'Skip', exact: true }).click();

    // All tour UI gone, no completion modal.
    await expect(tourTooltip(page)).toHaveCount(0);
    await expect(completionModal(page)).toBeHidden();

    // The underlying form is left exactly as it was: still on the Add Item
    // page, Brand field still empty (untouched by the tour), submit button
    // still there.
    expect(page.url()).toMatch(/\/inventory\/new$/);
    await expect(inputByLabel(page, 'Brand *')).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Add Clothing Item' })).toBeVisible();
  });

  test('AC4: form input typed before the tour survives Skip (clothing: Brand)', async ({ page }) => {
    await openClothingTab(page);

    const brand = `E2ETourDenim${uniqueSuffix()}`;
    await inputByLabel(page, 'Brand *').fill(brand);

    await startTour(page);
    await expect(tourTooltip(page)).toContainText(CLOTHING_STEP_ORDER[0]);

    await clickNextAndExpectStep(page, CLOTHING_STEP_ORDER[1]);
    await clickNextAndExpectStep(page, CLOTHING_STEP_ORDER[2]);
    await page.getByRole('button', { name: 'Skip', exact: true }).click();

    await expect(tourTooltip(page)).toHaveCount(0);
    await expect(completionModal(page)).toBeHidden();
    await expect(inputByLabel(page, 'Brand *')).toHaveValue(brand);
  });

  test('AC4: form input typed before the tour survives Skip (book: Title)', async ({ page }) => {
    await page.goto('/inventory/new');
    await expect(page.getByRole('heading', { name: 'Add Item' })).toBeVisible();
    // Book is the default tab — no tab click needed.

    const title = `E2E Tour Book ${uniqueSuffix()}`;
    await inputByLabel(page, 'Title *').fill(title);

    await startTour(page);
    await expect(page.locator(`[data-tour="${BOOK_ANCHORS.isbn}"]`)).toBeVisible();
    await expect(tourTooltip(page)).toContainText(BOOK_STEP_ORDER[0]);

    await clickNextAndExpectStep(page, BOOK_STEP_ORDER[1]);
    await clickNextAndExpectStep(page, BOOK_STEP_ORDER[2]);

    await page.getByRole('button', { name: 'Skip', exact: true }).click();

    await expect(tourTooltip(page)).toHaveCount(0);
    await expect(completionModal(page)).toBeHidden();
    await expect(inputByLabel(page, 'Title *')).toHaveValue(title);
  });

  // ---------------------------------------------------------------------
  // AC5 / AC6 — motion
  //
  // TourTooltip (components/tour/TourTooltip.tsx) and TourCompletionModal
  // (components/tour/TourCompletionModal.tsx) both carry the exact same
  // transition utility classes: `transition-all duration-200 ease-out
  // motion-reduce:transition-none motion-reduce:duration-0`. Tailwind's
  // `motion-reduce:` variant only takes effect under the
  // `@media (prefers-reduced-motion: reduce)` query, so the only way to
  // actually prove the requirement (rather than just asserting a class
  // string is present in the DOM, which says nothing about whether the
  // media query is active) is to read the browser's own resolved
  // `getComputedStyle(el).transitionDuration` under each
  // `page.emulateMedia({ reducedMotion })` setting.
  // ---------------------------------------------------------------------

  async function transitionDuration(locator: ReturnType<typeof tourTooltip>): Promise<string> {
    return locator.evaluate((el) => getComputedStyle(el).transitionDuration);
  }

  /** Walks the clothing tour from step 1 through Finish, landing on the completion modal. */
  async function finishClothingTour(page: Page): Promise<void> {
    await openClothingTab(page);
    await startTour(page);
    await expect(tourTooltip(page)).toContainText(CLOTHING_STEP_ORDER[0]);

    for (let i = 1; i < CLOTHING_STEP_ORDER.length; i++) {
      await clickNextAndExpectStep(page, CLOTHING_STEP_ORDER[i]);
    }

    await page.getByRole('button', { name: 'Last', exact: true }).click();
    await expect(completionModal(page)).toBeVisible();
  }

  test('AC5: with prefers-reduced-motion, tooltip and completion modal apply a 0s transition', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await finishClothingTour(page);

    // The tooltip from the last step traversed is gone by the time the
    // modal is up, so only the modal's resolved duration is checked here —
    // step 1's tooltip duration is checked while it's still on screen,
    // before advancing.
    const modalDuration = await transitionDuration(completionModal(page));
    expect(modalDuration).toBe('0s');
  });

  test('AC5b: with prefers-reduced-motion, the tour tooltip itself applies a 0s transition', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await openClothingTab(page);
    await startTour(page);
    await expect(tourTooltip(page)).toContainText(CLOTHING_STEP_ORDER[0]);

    const tooltipDuration = await transitionDuration(tourTooltip(page));
    expect(tooltipDuration).toBe('0s');
  });

  test('AC6: without reduced motion, tooltip and completion modal apply the real 200ms transition', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    await openClothingTab(page);
    await startTour(page);
    await expect(tourTooltip(page)).toContainText(CLOTHING_STEP_ORDER[0]);

    const tooltipDuration = await transitionDuration(tourTooltip(page));
    expect(tooltipDuration).toBe('0.2s');

    for (let i = 1; i < CLOTHING_STEP_ORDER.length; i++) {
      await clickNextAndExpectStep(page, CLOTHING_STEP_ORDER[i]);
    }
    await page.getByRole('button', { name: 'Last', exact: true }).click();
    await expect(completionModal(page)).toBeVisible();

    const modalDuration = await transitionDuration(completionModal(page));
    expect(modalDuration).toBe('0.2s');
  });

  // ---------------------------------------------------------------------
  // AC7 — Escape from an early step
  // ---------------------------------------------------------------------

  test('AC7: Escape from an early step closes the tour like Skip, no completion modal, form untouched', async ({
    page,
  }) => {
    await openClothingTab(page);

    const brand = `E2ETourEscape${uniqueSuffix()}`;
    await inputByLabel(page, 'Brand *').fill(brand);

    await startTour(page);
    await expect(tourTooltip(page)).toContainText(CLOTHING_STEP_ORDER[0]);

    // Advance one step (an early step, not the last) before dismissing, to
    // prove Escape works mid-tour and not only when already on the final step.
    await clickNextAndExpectStep(page, CLOTHING_STEP_ORDER[1]);

    await page.keyboard.press('Escape');

    // Same immediate, non-animated teardown as Skip (AC3): no tooltip, no
    // completion modal, form state preserved.
    await expect(tourTooltip(page)).toHaveCount(0);
    await expect(completionModal(page)).toBeHidden();
    expect(page.url()).toMatch(/\/inventory\/new$/);
    await expect(inputByLabel(page, 'Brand *')).toHaveValue(brand);
  });

  // ---------------------------------------------------------------------
  // AC8 — persistence across reload, per-category isolation
  // ---------------------------------------------------------------------

  test('AC8: completing the tour persists per category; reload skips auto-launch, button flips to "Retake the tour", manual relaunch still works', async ({
    page,
  }) => {
    await finishClothingTour(page);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(completionModal(page)).toBeHidden();

    // A full reload (fresh mount, not just an in-app tab switch) is the real
    // test of persistence — component state resets, only localStorage survives.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Add Item' })).toBeVisible();
    await page.getByRole('button', { name: 'Clothing', exact: true }).click();

    // The tour does not auto-launch on load/tab-switch.
    await expect(tourTooltip(page)).toHaveCount(0);

    // Entry button label reflects the persisted completion.
    await expect(tourButton(page)).toHaveText('Retake the tour');

    // Clicking it still manually relaunches the tour, starting fresh at step 1.
    await startTour(page);
    await expect(tourTooltip(page)).toContainText(CLOTHING_STEP_ORDER[0]);
  });

  test("AC8: completing the Clothing tour does not affect the Book tour's not-yet-seen entry-button label", async ({
    page,
  }) => {
    await finishClothingTour(page);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(completionModal(page)).toBeHidden();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Add Item' })).toBeVisible();
    // Book is the default tab — no tab click needed.
    await expect(tourButton(page)).toHaveText('Take the tour');
  });

  // ---------------------------------------------------------------------
  // AC13 — full keyboard-only navigation, visible focus at every step
  // ---------------------------------------------------------------------

  /**
   * Presses Tab repeatedly (bounded) until `locator` is the focused element.
   * Used instead of a hardcoded Tab count so this test doesn't break if
   * unrelated focusable chrome (nav links, theme toggle, skip-to-content
   * link — see app/layout.tsx) is added/removed upstream of the element
   * under test.
   */
  async function tabUntilFocused(page: Page, locator: Locator, maxPresses = 20): Promise<void> {
    for (let i = 0; i < maxPresses; i++) {
      await page.keyboard.press('Tab');
      if (await locator.evaluate((el) => document.activeElement === el)) {
        return;
      }
    }
    throw new Error('Tab never reached the target element within the press budget');
  }

  /** True if `document.activeElement` is `<body>` — i.e. focus fell off the page. */
  async function focusIsOnBody(page: Page): Promise<boolean> {
    return page.evaluate(() => document.activeElement === document.body);
  }

  test('AC13: keyboard-only (no mouse) — open, navigate, and close the tour with visible focus at every step', async ({
    page,
  }) => {
    await page.goto('/inventory/new');
    await expect(page.getByRole('heading', { name: 'Add Item' })).toBeVisible();
    // Book is the default tab — no tab click (mouse) needed.

    // Tab from the top of the page to the entry button, then activate it
    // with Enter — no click anywhere in this test.
    await tabUntilFocused(page, tourButton(page));
    await expect(tourButton(page)).toBeFocused();
    await page.keyboard.press('Enter');

    // react-joyride's Beacon (node_modules/react-joyride/src/components/Beacon.tsx)
    // renders a real `<button aria-label="Open the dialog">`, so it IS
    // keyboard-operable by design: Tab reaches it and Enter/Space activate
    // it like any native button. It also self-focuses on mount under some
    // conditions (its `shouldFocus` prop, tied to whether the target had to
    // scroll into view) — so confirm whichever happened (already focused,
    // or reachable via an explicit Tab) rather than assuming one or the
    // other, then activate with Enter, not a click.
    const beacon = page.getByRole('button', { name: 'Open the dialog' });
    await expect(beacon).toBeVisible();
    await page.waitForTimeout(100);
    if (!(await beacon.evaluate((el) => document.activeElement === el))) {
      await tabUntilFocused(page, beacon);
    }
    await expect(beacon).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(tourTooltip(page)).toBeVisible();
    await page.waitForTimeout(500);
    await expect(tourTooltip(page)).toContainText(BOOK_STEP_ORDER[0]);

    // TourTooltip (components/tour/TourTooltip.tsx) focuses its primary
    // (Next) button on mount.
    const nextButton = page.getByRole('button', { name: 'Next', exact: true });
    const skipButton = page.getByRole('button', { name: 'Skip', exact: true });
    await expect(nextButton).toBeFocused();

    // Step 1 has no "Back" button, so TourTooltip's own manual Tab focus
    // trap (`handleKeyDown`) cycles between exactly two controls: Skip and
    // Next. Forward-Tab from the last control (Next) wraps to the first
    // (Skip); at no point does focus fall through to <body> while the tour
    // is open (requirement 15 in docs/seller-tutorial-motion-ux/requirements.md).
    await page.keyboard.press('Tab');
    expect(await focusIsOnBody(page)).toBe(false);
    await expect(skipButton).toBeFocused();

    // Shift+Tab from the first control (Skip) wraps back to the last (Next).
    await page.keyboard.press('Shift+Tab');
    expect(await focusIsOnBody(page)).toBe(false);
    await expect(nextButton).toBeFocused();

    // Advance to step 2 with Enter (not a click) on the focused Next button.
    await page.keyboard.press('Enter');
    await expect(tourTooltip(page)).toContainText(BOOK_STEP_ORDER[1]);
    await page.waitForTimeout(500);

    // Step 2 has a "Back" button too; the new tooltip instance re-focuses
    // Next on mount again.
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeFocused();

    const backButton = page.getByRole('button', { name: 'Back', exact: true });
    await tabUntilFocused(page, backButton);
    expect(await focusIsOnBody(page)).toBe(false);
    await expect(backButton).toBeFocused();

    // Activate Back with Enter, landing on step 1 again.
    await page.keyboard.press('Enter');
    await expect(tourTooltip(page)).toContainText(BOOK_STEP_ORDER[0]);
    await page.waitForTimeout(500);

    // Visible focus indication: the focused control's own `focus:ring-*`
    // Tailwind utility (TourTooltip.tsx) resolves to a real box-shadow, not
    // "none" — concrete CSS proof behind the `toBeFocused()` assertions
    // above being a *visibly* focused control, not merely a programmatically
    // focused one.
    const refocusedNext = page.getByRole('button', { name: 'Next', exact: true });
    await expect(refocusedNext).toBeFocused();
    const nextRing = await refocusedNext.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(nextRing).not.toBe('none');

    // Finally, close the tour with Escape (keyboard-only, no click) — the
    // same immediate teardown as Skip/AC7.
    await page.keyboard.press('Escape');
    await expect(tourTooltip(page)).toHaveCount(0);
    await expect(completionModal(page)).toBeHidden();
  });
});
