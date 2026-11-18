import { useCallback, useEffect, useState } from 'react';
import type { EventData } from 'react-joyride';

import type { Category } from '@/lib/constants';

import { markTourCompleted } from './tourCompletion';
import { resolveTourEvent, type TourEventResult } from './tourEvents';

// PresaleTour's own independent Escape handling. Joyride's built-in
// Escape-to-dismiss is disabled via `options={{ dismissKeyAction: false }}`
// below, so this is the single authoritative place that reacts to Escape —
// there's no double-fire risk. Only Escape is intercepted (no
// preventDefault/stopPropagation for other keys) so this listener never
// interferes with TourTooltip's own Tab/Shift+Tab focus trap. Attached only
// while `open` is true and always cleaned up on close/unmount.
function useEscapeKey(open: boolean, onEscape: () => void) {
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

// Mirror `open` into the internal `run` state, and always restart at step 0
// when the tour (re)opens so re-launching never resumes mid-way.
function useTourProgress(open: boolean) {
  const [stepIndex, setStepIndex] = useState(0);
  const [run, setRun] = useState(open);

  useEffect(() => {
    setRun(open);

    if (open) {
      setStepIndex(0);
    }
  }, [open]);

  return { stepIndex, setStepIndex, run, setRun };
}

interface PresaleTourStateOptions {
  category: Category;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  totalSteps: number;
}

/**
 * Controlled-tour state for PresaleTour: step index and run flag held
 * locally, advanced/retreated via the pure getNextStepIndex state machine
 * (see ./tourEvents), plus the completion modal and Escape handling.
 */
export function usePresaleTourState({ category, open, onOpenChange, totalSteps }: PresaleTourStateOptions) {
  const { stepIndex, setStepIndex, run, setRun } = useTourProgress(open);
  const [showCompletionModal, setShowCompletionModal] = useState(false);

  const closeAndRemember = useCallback(() => {
    setRun(false);
    onOpenChange(false);
    markTourCompleted(category);
  }, [category, onOpenChange, setRun]);

  useEscapeKey(open, closeAndRemember);

  function applyResult(result: TourEventResult) {
    switch (result.kind) {
      case 'goto':
        setStepIndex(result.index);
        break;
      case 'finish':
        // Defer `onOpenChange(false)` until the user dismisses
        // TourCompletionModal: that is the real "tour is fully done" moment.
        setRun(false);
        setShowCompletionModal(true);
        markTourCompleted(category);
        break;
      case 'close':
        setRun(false);
        onOpenChange(false);
        break;
      case 'skip':
        closeAndRemember();
        break;
      case 'ignore':
        break;
    }
  }

  function handleEvent(data: EventData) {
    applyResult(resolveTourEvent(data, totalSteps));
  }

  function handleCompletionModalClose() {
    setShowCompletionModal(false);
    onOpenChange(false);
  }

  return { stepIndex, run, showCompletionModal, handleEvent, handleCompletionModalClose };
}
