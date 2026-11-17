import { ACTIONS, EVENTS, STATUS } from 'react-joyride';
import type { EventData } from 'react-joyride';

import { getNextStepIndex } from '@/lib/tourStateMachine';

/**
 * What PresaleTour should do for one Joyride event.
 * - goto: move the controlled tour to `index`.
 * - finish: the real tour-completion moment. Show the completion modal and
 *   remember completion; the parent hears about the close after the modal.
 * - close: stop the tour at once, without remembering completion.
 * - skip: stop the tour at once and remember completion.
 */
export type TourEventResult =
  | { kind: 'goto'; index: number }
  | { kind: 'finish' }
  | { kind: 'close' }
  | { kind: 'skip' }
  | { kind: 'ignore' };

function resolveStepAfter(data: EventData, totalSteps: number): TourEventResult {
  const transition = getNextStepIndex(data.index, data.action, totalSteps);

  if (transition.type === 'advance') {
    return { kind: 'goto', index: transition.index };
  }

  // react-joyride (controlled + continuous mode) fires STEP_AFTER with
  // ACTIONS.NEXT at the last step index when the user clicks "Finish".
  // getNextStepIndex resolves that to `close` since there's no next step to
  // advance to — but this IS the real tour-completion moment, not a generic
  // close.
  if (data.action === ACTIONS.NEXT) {
    return { kind: 'finish' };
  }

  // Defensive only — any other action resolving STEP_AFTER to "close" is
  // genuinely unexpected; close instantly with no completion modal.
  return { kind: 'close' };
}

function resolveTourEnd(status: EventData['status']): TourEventResult {
  if (status === STATUS.FINISHED) return { kind: 'finish' };
  if (status === STATUS.SKIPPED) return { kind: 'skip' };
  return { kind: 'ignore' };
}

export function resolveTourEvent(data: EventData, totalSteps: number): TourEventResult {
  if (data.type === EVENTS.STEP_AFTER) {
    return resolveStepAfter(data, totalSteps);
  }

  // A `data-tour` selector didn't match anything in the DOM — close cleanly
  // rather than leaving a stuck tooltip.
  if (data.type === EVENTS.TARGET_NOT_FOUND) {
    return { kind: 'close' };
  }

  if (data.type === EVENTS.TOUR_END) {
    return resolveTourEnd(data.status);
  }

  return { kind: 'ignore' };
}
