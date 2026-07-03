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
    const digits = base.split('').map(Number);
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += digits[i] * (i % 2 === 0 ? 1 : 3);
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    return base + checkDigit.toString();
  }

  throw new Error('Invalid ISBN format.');
}

/**
 * Look up an ISBN via the Open Library Books API.
 * Returns { title, author, publisher } or null on any error / timeout / not-found.
 *
 * Security: validates the ISBN pattern before constructing the URL.
 * Limits: 3-second AbortController timeout; response body capped at 64 KB.
 */
export async function lookupISBN(
  isbn: string,
): Promise<{ title: string; author: string; publisher: string } | null> {
  const stripped = isbn.replace(/[-\s]/g, '');

  if (!ISBN_PATTERN.test(stripped)) {
    return null;
  }

  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${stripped}&format=json&jscmd=data`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok || !response.body) {
      return null;
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
        return null;
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
    const body = new TextDecoder().decode(merged);

    const data = JSON.parse(body) as Record<string, unknown>;
    const key = `ISBN:${stripped}`;

    if (!data[key]) {
      return null;
    }

    const book = data[key] as {
      title?: string;
      authors?: { name?: string }[];
      publishers?: { name?: string }[];
    };

    const title = book.title ?? '';
    const author = book.authors?.[0]?.name ?? '';
    const publisher = book.publishers?.[0]?.name ?? '';

    return { title, author, publisher };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
