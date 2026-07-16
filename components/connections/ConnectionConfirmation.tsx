'use client';

import type { ReactNode } from 'react';
import type { SupportedPlatform } from '@/lib/constants';

interface ConnectionConfirmationProps {
  platform: SupportedPlatform;
  /**
   * Already-masked identifier (via maskIdentifier), computed by the caller.
   * This component never receives or renders a raw identifier from an API
   * response -- only this client-derived, pre-masked string.
   */
  maskedIdentifier: string;
  /**
   * Slot for a sibling component (e.g. FirstWinPanel, built by a different
   * task) to be placed below the confirmation banner by the wiring task.
   * Kept as a generic children slot so this component never needs to
   * import that sibling directly.
   */
  children?: ReactNode;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function ConnectionConfirmation({
  platform,
  maskedIdentifier,
  children,
}: ConnectionConfirmationProps) {
  return (
    <div data-testid="connection-confirmation">
      <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-4">
        <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
          Connected!
        </p>
        <p
          className="text-sm text-emerald-700 dark:text-emerald-400 mt-1"
          data-testid="connection-confirmation-identifier"
        >
          {capitalize(platform)} connected as @{maskedIdentifier}
        </p>
      </div>

      <div className="mt-4">{children}</div>
    </div>
  );
}
