'use client';

import { useEffect, useRef, useState } from 'react';
import type { TooltipRenderProps } from 'react-joyride';

/**
 * Custom tooltip rendered by react-joyride for the presale tour. Wired in as
 * the `tooltipComponent` prop on <Joyride>, so its prop shape is dictated by
 * react-joyride's `TooltipRenderProps` — see node_modules/react-joyride/dist
 * for the exact fields (backProps/primaryProps/skipProps are prop-getters
 * that already carry the correct onClick + data-action wiring).
 *
 * Tab/Shift+Tab cycling is intentionally NOT handled here. react-joyride's
 * `Step` component already installs its own focus trap
 * (node_modules/react-joyride/src/hooks/useFocusTrap.ts, wired to this
 * tooltip's container and enabled by default — see `disableFocusTrap` in
 * node_modules/react-joyride/src/defaults.ts) that cycles Tab across every
 * tabbable element inside the tooltip and wraps at both ends. A second,
 * component-owned trap here used to double-handle every Tab press — the
 * built-in trap moved focus first (its native listener sits on an ancestor
 * node and fires before React's delegated synthetic event does), then this
 * component's own boundary check ran again on the *already-moved* focus and
 * wrapped it a second time. Confirmed via a real browser: tabbing forward
 * from "Back" landed on "Skip", silently skipping "Next"/"Finish" for
 * keyboard users. Only the primary-button mount-focus below is still owned
 * here (react-joyride's own trap does the same focus, just 100ms later).
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
  const [visible, setVisible] = useState(false);

  const primaryRef = useRef<HTMLButtonElement>(null);

  const showBack = index > 0;

  // Fade/scale in shortly after mount rather than starting already-visible,
  // so the transition actually animates.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Land keyboard focus on the primary (Next/Finish) action by default.
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

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

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          {...skipProps}
          className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        >
          Skip
        </button>

        <div className="flex items-center gap-2">
          {showBack && (
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

      <p className="mt-2 text-right text-xs text-gray-400 dark:text-gray-500">
        {index + 1} / {size}
      </p>
    </div>
  );
}
