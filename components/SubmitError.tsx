/** Form-level submission error banner, shared by both "add item" forms. */
export function SubmitError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="text-sm text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900 rounded px-3 py-2 bg-red-50 dark:bg-red-950/30">{message}</p>
  );
}
