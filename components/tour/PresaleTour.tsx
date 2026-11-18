'use client';

import { Joyride } from 'react-joyride';

import type { Category } from '@/lib/constants';
import { CLOTHING_TOUR_STEPS, BOOK_TOUR_STEPS } from '@/lib/tourSteps';

import TourTooltip from './TourTooltip';
import TourCompletionModal from './TourCompletionModal';
import { usePresaleTourState } from './usePresaleTourState';

export { isTourCompleted } from './tourCompletion';

interface PresaleTourProps {
  category: Category;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Basic Joyride mount for the presale tour: picks the right step list for
 * the category and drives it as a controlled tour (see usePresaleTourState).
 * Also handles tour-end (finished/skipped) and target-not-found by closing
 * the tour and persisting per-category completion to localStorage. Also owns
 * its own Escape-key handling (Joyride's built-in ESC dismissal is disabled
 * via `dismissKeyAction: false`); TourTooltip owns the Tab focus trap.
 */
export default function PresaleTour({ category, open, onOpenChange }: PresaleTourProps) {
  const steps = category === 'clothing' ? CLOTHING_TOUR_STEPS : BOOK_TOUR_STEPS;
  const { stepIndex, run, showCompletionModal, handleEvent, handleCompletionModalClose } =
    usePresaleTourState({ category, open, onOpenChange, totalSteps: steps.length });

  return (
    <>
      <Joyride
        steps={steps}
        stepIndex={stepIndex}
        run={run}
        continuous
        tooltipComponent={TourTooltip}
        onEvent={handleEvent}
        // Task 10 adds PresaleTour's own independent Escape handling; disable
        // Joyride's built-in ESC-to-dismiss so the two don't double-fire.
        options={{ dismissKeyAction: false }}
        // Zero out Joyride's own floater opacity transition — the custom
        // TourTooltip (see ./TourTooltip) already owns its own fade/scale
        // animation, so Joyride's default `transition: 'opacity 0.3s'` on the
        // floater wrapper (node_modules/react-joyride/src/styles.ts) would
        // otherwise double up on it.
        styles={{ floater: { transition: 'none' } }}
      />
      <TourCompletionModal open={showCompletionModal} onClose={handleCompletionModalClose} />
    </>
  );
}
