/** Submit button for the "add item" forms — identical styling/disabled/loading behavior, only the label differs. */
export function SubmitButton({ loading, label }: { loading: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="w-full bg-gray-900 text-white rounded px-4 py-2 text-sm font-medium hover:bg-gray-700 disabled:opacity-50"
    >
      {loading ? 'Adding…' : label}
    </button>
  );
}
