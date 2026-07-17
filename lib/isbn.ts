const ISBN_PATTERN = /^\d{9}[\dX]$|^\d{13}$/;

/**
 * Normalise an ISBN string:
 * - Strip hyphens and spaces
 * - ISBN-10 → ISBN-13 (prepend "978", compute check digit)
 * - ISBN-13 → return as-is
 * - Anything else → throw Error("Invalid ISBN format.")
 */
export function normalizeISBN(isbn: string): string {
  const stripped = isbn.replace(/[-\s]/g, '');

  if (/^\d{13}$/.test(stripped)) {
    return stripped;
  }

  if (/^\d{9}[\dX]$/.test(stripped)) {
    // Take the first 9 digits (drop the ISBN-10 check digit)
    const base = '978' + stripped.slice(0, 9);
    return base + computeIsbn13CheckDigit(base);
  }

  throw new Error('Invalid ISBN format.');
}

/**
 * Compute the ISBN-10 check digit for a 9-digit prefix.
 *
 * Weights 10 down to 2 are applied across the 9 digits, summed, then
 * reduced via `11 - (sum mod 11)`, itself reduced mod 11. A remainder
 * of 10 is represented as the character 'X' per the ISBN-10 spec.
 */
function computeIsbn10CheckDigit(prefix: string): string {
  const digits = prefix.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += digits[i] * (10 - i);
  }
  const remainder = (11 - (sum % 11)) % 11;
  return remainder === 10 ? 'X' : remainder.toString();
}

/**
 * Compute the ISBN-13 check digit for a 12-digit prefix (e.g. "978" plus
 * the first 9 digits of an ISBN-10). Extracted from the mod-10 math
 * previously inlined in {@link normalizeISBN}.
 */
function computeIsbn13CheckDigit(prefix: string): string {
  const digits = prefix.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += digits[i] * (i % 2 === 0 ? 1 : 3);
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit.toString();
}

/**
 * Validate an ISBN-10 or ISBN-13's check digit, without performing a
 * lookup. Strips hyphens/spaces (matching {@link normalizeISBN}'s
 * stripping behaviour) and accepts a lowercase 'x' check character as
 * equivalent to 'X'.
 *
 * Shape is checked via the existing {@link ISBN_PATTERN}; a shape-valid
 * ISBN-10 or ISBN-13 is then checked against its own computed check
 * digit.
 */
export function validateIsbnChecksum(
  isbn: string
): { valid: true } | { valid: false; reason: 'shape' | 'checksum' } {
  const raw = isbn.replace(/[-\s]/g, '');
  const stripped =
    raw.length > 0 ? raw.slice(0, -1) + raw.slice(-1).toUpperCase() : raw;

  if (!ISBN_PATTERN.test(stripped)) {
    return { valid: false, reason: 'shape' };
  }

  if (stripped.length === 10) {
    const expected = computeIsbn10CheckDigit(stripped.slice(0, 9));
    return stripped[9] === expected
      ? { valid: true }
      : { valid: false, reason: 'checksum' };
  }

  const expected = computeIsbn13CheckDigit(stripped.slice(0, 12));
  return stripped.slice(12) === expected
    ? { valid: true }
    : { valid: false, reason: 'checksum' };
}

/**
 * Discriminated result of an ISBN lookup, so callers can tell a genuine
 * "not in the provider's catalogue" (→ 404) apart from a provider being
 * unavailable (→ 503). Previously every failure class collapsed to `null`,
 * which forced the route to map outages to a misleading 404 (DR-3).
 *
 *   - found:       the provider returned a record for this ISBN
 *   - not-found:   the provider answered but has no record for this ISBN
 *   - invalid:     the ISBN failed the format check (never reached the network)
 *   - unavailable: the provider could not be reached or gave an unusable
 *                  answer; `reason` narrows which failure class occurred
 *                    - timeout:      the 3-second AbortController fired
 *                    - network:      fetch rejected for any other reason
 *                    - bad-response: non-OK HTTP status, missing/empty body,
 *                                    or a body that would not JSON-parse
 *                    - oversize:     body exceeded the 64 KB cap
 */
export type ISBNLookupResult =
  | { status: 'found'; title: string; author: string; publisher: string }
  | { status: 'not-found' }
  | { status: 'invalid' }
  | {
      status: 'unavailable';
      reason: 'timeout' | 'network' | 'bad-response' | 'oversize';
    };

/**
 * Look up an ISBN via the Open Library Books API.
 *
 * Returns a discriminated {@link ISBNLookupResult} so the caller can
 * distinguish "not found" from "provider unavailable". Never throws.
 *
 * Security: validates the ISBN pattern before constructing the URL.
 * Limits: 3-second AbortController timeout; response body capped at 64 KB.
 * (Both limits are unchanged from the previous implementation.)
 */
export async function lookupISBN(isbn: string): Promise<ISBNLookupResult> {
  const stripped = isbn.replace(/[-\s]/g, '');

  if (!ISBN_PATTERN.test(stripped)) {
    return { status: 'invalid' };
  }

  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${stripped}&format=json&jscmd=data`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);

  let body: string;
  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok || !response.body) {
      return { status: 'unavailable', reason: 'bad-response' };
    }

    // Cap body at 64 KB
    const MAX_BYTES = 64 * 1024;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_BYTES) {
        await reader.cancel();
        return { status: 'unavailable', reason: 'oversize' };
      }
      chunks.push(value);
    }

    // Assemble body
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    body = new TextDecoder().decode(merged);
  } catch (err) {
    // The AbortController fires on the 3-second timeout, surfacing as an
    // AbortError; any other rejection is a genuine network failure.
    const name = (err as { name?: string } | null)?.name;
    return {
      status: 'unavailable',
      reason: name === 'AbortError' ? 'timeout' : 'network',
    };
  } finally {
    clearTimeout(timeoutId);
  }

  // A body we cannot parse means the provider gave us something unusable,
  // which is an availability problem, not a genuine "not found".
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { status: 'unavailable', reason: 'bad-response' };
  }

  const key = `ISBN:${stripped}`;
  if (!data[key]) {
    return { status: 'not-found' };
  }

  const book = data[key] as {
    title?: string;
    authors?: { name?: string }[];
    publishers?: { name?: string }[];
  };

  return {
    status: 'found',
    title: book.title ?? '',
    author: book.authors?.[0]?.name ?? '',
    publisher: book.publishers?.[0]?.name ?? '',
  };
}
