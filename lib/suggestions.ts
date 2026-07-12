// Shared by AddBookForm and AddClothingForm: both fetch autocomplete
// suggestion lists from the operator's own past entries via the same
// endpoint, differing only in which field they ask for and (for clothing's
// brand-scoped size lookup) an extra query param.
export async function fetchFieldSuggestions(
  field: string,
  extraParams?: Record<string, string>
): Promise<string[]> {
  try {
    const params = new URLSearchParams({ field, ...extraParams });
    const res = await fetch(`/api/items/suggestions?${params.toString()}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.values) ? data.values : [];
  } catch {
    return [];
  }
}
