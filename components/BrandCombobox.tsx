'use client';

import {
  rankByFrequency,
  moveHighlightIndex,
  buildComboOptions as buildComboOptionsShared,
  type CanonicalItem,
  type ComboOption,
} from './comboboxHelpers';
import { VocabCombobox } from './VocabCombobox';

type CanonicalBrand = CanonicalItem;

interface BrandComboboxProps {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

// Advisory-only client-side bound — the server independently validates.
// Duplicated here (rather than importing from @/lib/brands) because that
// module pulls in better-sqlite3 via @/lib/db, a server-only native module
// that cannot be bundled into a 'use client' component.
const MAX_BRAND_LENGTH = 255;

export { rankByFrequency, moveHighlightIndex };

/**
 * Build the listbox options from the already-ranked canonical matches, plus
 * a trailing "Add new brand" option when the typed value has no exact
 * (case-insensitive) canonical match. Thin brand-specific wrapper over the
 * shared implementation (see ./comboboxHelpers), preserving this file's
 * original 3-arg public signature.
 */
export function buildComboOptions(
  ranked: CanonicalBrand[],
  trimmedValue: string,
  hasExactMatch: boolean
): ComboOption[] {
  return buildComboOptionsShared(ranked, trimmedValue, hasExactMatch, 'brand');
}

/**
 * Hand-rolled ARIA combobox for the clothing form's brand field.
 *
 * Thin instantiation of VocabCombobox (see ./VocabCombobox) — brand's own
 * data fetching, filtering, ranking, and keyboard/mouse behavior are all
 * identical to the seeded-vocabulary fields (color/material/department),
 * just pointed at /api/brands. Kept as its own named component (rather than
 * inlining <VocabCombobox endpoint="/api/brands" .../> at each call site)
 * so AddClothingForm's brand field reads as a single, self-documenting tag,
 * and so this file's rankByFrequency/moveHighlightIndex/buildComboOptions
 * re-exports (used by existing tests) still have somewhere to live.
 */
export function BrandCombobox({ value, onChange, error }: BrandComboboxProps) {
  return (
    <VocabCombobox
      value={value}
      onChange={onChange}
      error={error}
      endpoint="/api/brands"
      responseKey="brands"
      suggestionField="brand"
      label="Brand"
      required
      maxLength={MAX_BRAND_LENGTH}
    />
  );
}
