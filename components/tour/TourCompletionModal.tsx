'use client';

import { useEffect, useRef } from 'react';

const DEFAULT_MESSAGE = "Tour complete! You're ready to list your first item.";

interface TourCompletionModalProps {
  open: boolean;
  onClose: () => void;
  message?: string;
}

/**
 * Shown when a guided product tour reaches its final step.
 *
 * Built on the native <dialog> element rather than a hand-rolled focus trap:
 * `.showModal()` / `.close()` give us focus-trapping and Escape-to-close for
 * free, straight from the browser, at zero extra dependency cost.
 */
export default function TourCompletionModal({ open, onClose, message }: TourCompletionModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    // Native `close` event fires for every dismissal path — the Close
    // button below, or the browser's own Escape-to-close — so this is the
    // single place parent state gets resynced.
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="tour-completion-heading"
      className={`fixed inset-0 m-auto backdrop:bg-black/50 dark:backdrop:bg-black/70 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-300 dark:border-gray-700 rounded-lg p-6 max-w-sm w-full h-fit transition-all duration-200 ease-out motion-reduce:transition-none motion-reduce:duration-0 ${
        open ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
      }`}
    >
      <h2 id="tour-completion-heading" className="text-base font-semibold mb-2">
        You&apos;re all set
      </h2>
      <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">{message ?? DEFAULT_MESSAGE}</p>
      <button
        type="button"
        onClick={() => dialogRef.current?.close()}
        className="w-full bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded px-4 py-2 text-sm font-medium hover:bg-gray-700 dark:hover:bg-gray-200 transition-all duration-200 ease-out motion-reduce:transition-none motion-reduce:duration-0"
      >
        Close
      </button>
    </dialog>
  );
}
