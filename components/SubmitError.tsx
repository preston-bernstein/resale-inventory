/** Form-level submission error banner, shared by both "add item" forms. */
export function SubmitError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="text-sm text-red-600 border border-red-200 rounded px-3 py-2 bg-red-50">{message}</p>
  );
}
