'use client';

import { useCallback, useEffect, useState } from 'react';
import { ACTIONS, Joyride, EVENTS, STATUS } from 'react-joyride';
import type { EventData } from 'react-joyride';

import type { Category } from '@/lib/constants';
import { getNextStepIndex } from '@/lib/tourStateMachine';
import { CLOTHING_TOUR_STEPS, BOOK_TOUR_STEPS } from '@/lib/tourSteps';

import TourTooltip from './TourTooltip';
import TourCompletionModal from './TourCompletionModal';

interface PresaleTourProps {
  category: Category;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TOUR_STORAGE_PREFIX = 'presale-tour:v1:';

function tourStepsFor(category: Category) {
  return category === 'clothing' ? CLOTHING_TOUR_STEPS : BOOK_TOUR_STEPS;
}

/**
 * Reads the per-category completion flag written by `markTourCompleted`.
 * Defensive against localStorage being unavailable (disabled, private mode,
 * quota exceeded) and against a corrupted/unparseable stored value — both
 * cases are treated as "not completed" rather than throwing. Only call this
 * from an effect (or other client-only code path), never at module scope or
 * synchronously during render, since Next.js can still prerender
 * 'use client' components on the server.
 */
export function isTourCompleted(category: Category): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return false;
    }

    const raw = window.localStorage.getItem(TOUR_STORAGE_PREFIX + category);

    if (!raw) {
      return false;
    }

    const parsed = JSON.parse(raw) as unknown;

    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      'completed' in parsed &&
      (parsed as { completed: unknown }).completed === true
    );
  } catch {
    return false;
  }
}

/**
 * Writes the per-category completion flag. Swallows any localStorage error
 * (disabled, quota exceeded, private mode) so the tour always closes cleanly
 * even when the write can't be persisted.
 */
function markTourCompleted(category: Category): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return;
    }

    window.localStorage.setItem(TOUR_STORAGE_PREFIX + category, JSON.stringify({ completed: true }));
  } catch {
    // Ignore — localStorage unavailable or full. Tour still closes normally.
  }
}

type TourEventAction =
  | { kind: 'advance'; index: number }
  // Tour completed: tear down Joyride and show the completion modal. The
  // parent's onOpenChange(false) waits until the user dismisses the modal.
  | { kind: 'finish' }
  // Instant close with no completion record and no modal.
  | { kind: 'close' }
  // Instant close that still records completion.
  | { kind: 'skip' }
  | { kind: 'ignore' };

function resolveStepAfter(data: EventData, stepCount: number): TourEventAction {
  const transition = getNextStepIndex(data.index, data.action, stepCount);

  if (transition.type === 'advance') {
    return { kind: 'advance', index: transition.index };
  }

  // react-joyride (controlled + continuous mode) fires STEP_AFTER with
  // ACTIONS.NEXT at the last step index when the user clicks "Finish".
  // getNextStepIndex resolves that to `close` since there's no next
  // step to advance to — but this IS the real tour-completion moment,
  // not a generic close. Any other action resolving to "close" is
  // genuinely unexpected, so it closes instantly with no completion modal.
  return data.action === ACTIONS.NEXT ? { kind: 'finish' } : { kind: 'close' };
}

function resolveTourEnd(status: EventData['status']): TourEventAction {
  if (status === STATUS.FINISHED) return { kind: 'finish' };
  if (status === STATUS.SKIPPED) return { kind: 'skip' };
  return { kind: 'ignore' };
}

/** Pure mapping from a Joyride event to what PresaleTour should do about it. */
function resolveTourEvent(data: EventData, stepCount: number): TourEventAction {
  if (data.type === EVENTS.STEP_AFTER) return resolveStepAfter(data, stepCount);

  // A `data-tour` selector didn't match anything in the DOM — close
  // cleanly rather than leaving a stuck tooltip.
  if (data.type === EVENTS.TARGET_NOT_FOUND) return { kind: 'close' };

  if (data.type === EVENTS.TOUR_END) return resolveTourEnd(data.status);

  return { kind: 'ignore' };
}

// PresaleTour's own independent Escape handling. Joyride's built-in
// Escape-to-dismiss is disabled via `options={{ dismissKeyAction: false }}`
// below, so this is the single authoritative place that reacts to Escape —
// there's no double-fire risk. Only Escape is intercepted (no
// preventDefault/stopPropagation for other keys) so this listener never
// interferes with TourTooltip's own Tab/Shift+Tab focus trap. Attached only
// while `open` is true and always cleaned up on close/unmount.
function useEscapeToSkip(open: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onEscape();
      }
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onEscape]);
}

function usePresaleTourState({ category, open, onOpenChange }: PresaleTourProps) {
  const stepCount = tourStepsFor(category).length;

  const [stepIndex, setStepIndex] = useState(0);
  const [run, setRun] = useState(open);
  const [showCompletionModal, setShowCompletionModal] = useState(false);

  // Mirror `open` into the internal `run` state, and always restart at step
  // 0 when the tour (re)opens so re-launching never resumes mid-way.
  useEffect(() => {
    setRun(open);

    if (open) {
      setStepIndex(0);
    }
  }, [open]);

  const skipTour = useCallback(() => {
    setRun(false);
    onOpenChange(false);
    markTourCompleted(category);
  }, [category, onOpenChange]);

  useEscapeToSkip(open, skipTour);

  function handleEvent(data: EventData) {
    const action = resolveTourEvent(data, stepCount);

    if (action.kind === 'advance') {
      setStepIndex(action.index);
    } else if (action.kind === 'finish') {
      // Defer onOpenChange(false) until the user dismisses the modal.
      setRun(false);
      setShowCompletionModal(true);
      markTourCompleted(category);
    } else if (action.kind === 'skip') {
      skipTour();
    } else if (action.kind === 'close') {
      setRun(false);
      onOpenChange(false);
    }
  }

  function handleCompletionModalClose() {
    setShowCompletionModal(false);
    onOpenChange(false);
  }

  return { stepIndex, run, showCompletionModal, handleEvent, handleCompletionModalClose };
}

/**
 * Basic Joyride mount for the presale tour: picks the right step list for
 * the category and drives it as a controlled tour (stepIndex + run held in
 * local state, advanced/retreated via the pure getNextStepIndex state
 * machine). Also handles tour-end (finished/skipped) and target-not-found by
 * closing the tour and persisting per-category completion to localStorage.
 * Also owns its own Escape-key handling (Joyride's built-in ESC dismissal is
 * disabled via `dismissKeyAction: false`); TourTooltip owns the Tab focus
 * trap.
 */
export default function PresaleTour(props: PresaleTourProps) {
  const tour = usePresaleTourState(props);

  return (
    <>
      <Joyride
        steps={tourStepsFor(props.category)}
        stepIndex={tour.stepIndex}
        run={tour.run}
        continuous
        tooltipComponent={TourTooltip}
        onEvent={tour.handleEvent}
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
      <TourCompletionModal open={tour.showCompletionModal} onClose={tour.handleCompletionModalClose} />
    </>
  );
}
