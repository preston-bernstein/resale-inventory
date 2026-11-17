'use client';

import { useEffect, useRef, useState } from 'react';
import type { TooltipRenderProps } from 'react-joyride';

type TourControlsProps = Pick<
  TooltipRenderProps,
  'backProps' | 'isLastStep' | 'primaryProps' | 'skipProps'
> & {
  showBack: boolean;
  primaryRef: React.RefObject<HTMLButtonElement | null>;
};

const FOCUS_RING = 'focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500';

function TourControls({ backProps, isLastStep, primaryProps, skipProps, showBack, primaryRef }: TourControlsProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <button
        type="button"
        {...skipProps}
        className={`text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded px-2 py-1 ${FOCUS_RING}`}
      >
        Skip
      </button>

      <div className="flex items-center gap-2">
        {showBack && (
          <button
            type="button"
            {...backProps}
            className={`border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 ${FOCUS_RING}`}
          >
            Back
          </button>
        )}
        <button
          type="button"
          {...primaryProps}
          ref={primaryRef}
          className={`bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded px-3 py-2 text-sm font-medium hover:bg-gray-700 dark:hover:bg-gray-200 ${FOCUS_RING}`}
        >
          {isLastStep ? 'Finish' : 'Next'}
        </button>
      </div>
    </div>
  );
}

// Fade/scale in shortly after mount rather than starting already-visible,
// so the transition actually animates.
function useFadeIn(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  return visible;
}

// Land keyboard focus on the primary (Next/Finish) action by default.
function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return ref;
}

/**
 * Custom tooltip for the presale tour, wired in as the `tooltipComponent`
 * prop on <Joyride>. Its props come from react-joyride's `TooltipRenderProps`;
 * the back, primary and skip props are prop-getters that already carry the
 * click handlers.
 *
 * Do not add Tab or Shift+Tab handling here. react-joyride installs its own
 * focus trap for this tooltip, and a second trap moves focus twice per key
 * press, so keyboard users skipped the "Next" and "Finish" buttons. Only the
 * mount focus on the primary button lives here.
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
  const visible = useFadeIn();
  const primaryRef = useFocusOnMount<HTMLButtonElement>();

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

      <TourControls
        backProps={backProps}
        isLastStep={isLastStep}
        primaryProps={primaryProps}
        skipProps={skipProps}
        showBack={index > 0}
        primaryRef={primaryRef}
      />

      <p className="mt-2 text-right text-xs text-gray-400 dark:text-gray-500">
        {index + 1} / {size}
      </p>
    </div>
  );
}
