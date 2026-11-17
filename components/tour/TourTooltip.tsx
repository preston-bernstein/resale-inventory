'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { TooltipRenderProps } from 'react-joyride';

// Fade/scale in shortly after mount rather than starting already-visible, so
// the transition actually animates; and land keyboard focus on the primary
// (Next/Finish) action by default.
function useTooltipEntrance() {
  const [visible, setVisible] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  return { visible, primaryRef };
}

interface TourActionsProps {
  /** null on the first step, where there is nothing to go back to. */
  backProps: TooltipRenderProps['backProps'] | null;
  primaryProps: TooltipRenderProps['primaryProps'];
  skipProps: TooltipRenderProps['skipProps'];
  primaryRef: RefObject<HTMLButtonElement | null>;
  isLastStep: boolean;
}

function TourActions({ backProps, primaryProps, skipProps, primaryRef, isLastStep }: TourActionsProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <button
        type="button"
        {...skipProps}
        className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
      >
        Skip
      </button>

      <div className="flex items-center gap-2">
        {backProps && (
          <button
            type="button"
            {...backProps}
            className="border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
          >
            Back
          </button>
        )}
        <button
          type="button"
          {...primaryProps}
          ref={primaryRef}
          className="bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded px-3 py-2 text-sm font-medium hover:bg-gray-700 dark:hover:bg-gray-200 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        >
          {isLastStep ? 'Finish' : 'Next'}
        </button>
      </div>
    </div>
  );
}

/**
 * Custom tooltip rendered by react-joyride for the presale tour. Wired in as
 * the `tooltipComponent` prop on <Joyride>, so its prop shape is dictated by
 * react-joyride's `TooltipRenderProps` — see node_modules/react-joyride/dist
 * for the exact fields (backProps/primaryProps/skipProps are prop-getters
 * that already carry the correct onClick + data-action wiring).
 *
 * Tab and Shift+Tab cycling is not handled here on purpose. react-joyride's
 * `Step` already traps focus in the tooltip and wraps at both ends (see
 * `useFocusTrap.ts` and `disableFocusTrap` in `defaults.ts` under
 * node_modules/react-joyride/src). A second trap here handled every Tab press
 * twice, so keyboard users skipped "Next" and "Finish". Only the mount focus
 * on the primary button stays here.
 */
export default function TourTooltip({
  backProps,
  index,
  isLastStep,
  primaryProps,
  size,
  skipProps,
  step,
  tooltipProps,
}: TooltipRenderProps) {
  const { visible, primaryRef } = useTooltipEntrance();

  const showBack = index > 0;

  return (
    <div
      {...tooltipProps}
      role="dialog"
      className={`max-w-sm rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-lg p-4 transition-all duration-200 ease-out motion-reduce:transition-none motion-reduce:duration-0 ${
        visible ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
      }`}
    >
      {step.title && <h2 className="text-sm font-semibold mb-1">{step.title}</h2>}
      <div className="text-sm text-gray-700 dark:text-gray-300 mb-4">{step.content}</div>

      <TourActions
        backProps={showBack ? backProps : null}
        primaryProps={primaryProps}
        skipProps={skipProps}
        primaryRef={primaryRef}
        isLastStep={isLastStep}
      />

      <p className="mt-2 text-right text-xs text-gray-400 dark:text-gray-500">
        {index + 1} / {size}
      </p>
    </div>
  );
}
