// Pure, testable state-machine logic for tour step advancement. No React, no
// DOM — this only computes "given the current step and the action Joyride
// reported, what should the next step index be (or should the tour close)."
//
// Consumed by components/tour/PresaleTour.tsx, which feeds this the
// `action`/`index` fields from react-joyride's `onEvent` payload (the
// `callback` prop from older react-joyride majors was replaced by `onEvent`
// in the installed 3.2.0 — see node_modules/react-joyride/src/types/events.ts).
import { ACTIONS } from 'react-joyride';
import type { Actions } from 'react-joyride';

/**
 * Result of computing the next tour step.
 * - `advance`: move the controlled `stepIndex` to `index`.
 * - `close`: the tour should stop (e.g. ACTIONS.NEXT past the last step).
 */
export type StepTransition = { type: 'advance'; index: number } | { type: 'close' };

/**
 * Pure function: given the step index Joyride reported *before* the action
 * (react-joyride's STEP_AFTER event reports the pre-action index), the
 * action that fired, and the total step count, compute what should happen
 * next. Clamps within [0, totalSteps - 1]; only ACTIONS.NEXT can trigger a
 * `close` (advancing past the last step). Any other action is treated
 * defensively as a close, since this task only wires up NEXT/PREV — later
 * tasks handle SKIP/CLOSE/STATUS.FINISHED/STATUS.SKIPPED themselves.
 */
export function getNextStepIndex(
  currentIndex: number,
  action: Actions | string,
  totalSteps: number,
): StepTransition {
  if (totalSteps <= 0) {
    return { type: 'close' };
  }

  const maxIndex = totalSteps - 1;

  switch (action) {
    case ACTIONS.NEXT: {
      const nextIndex = currentIndex + 1;

      if (nextIndex > maxIndex) {
        return { type: 'close' };
      }

      return { type: 'advance', index: nextIndex };
    }
    case ACTIONS.PREV: {
      const prevIndex = Math.max(currentIndex - 1, 0);

      return { type: 'advance', index: prevIndex };
    }
    default:
      return { type: 'close' };
  }
}
