import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeISBN, lookupISBN } from '../isbn';

// ---------------------------------------------------------------------------
// normalizeISBN
// ---------------------------------------------------------------------------

describe('normalizeISBN', () => {
  it('returns a 13-digit ISBN unchanged', () => {
    expect(normalizeISBN('9780306406157')).toBe('9780306406157');
  });

  it('converts ISBN-10 to ISBN-13', () => {
    // 0306406152 → 9780306406157
    expect(normalizeISBN('0306406152')).toBe('9780306406157');
  });

  it('strips hyphens then converts', () => {
    expect(normalizeISBN('0-306-40615-2')).toBe('9780306406157');
  });

  it('strips spaces then converts', () => {
    expect(normalizeISBN('0 306 40615 2')).toBe('9780306406157');
  });

  it('handles ISBN-10 with X check digit', () => {
    // 019853453X → 9780198534532
    expect(normalizeISBN('019853453X')).toBe('9780198534532');
  });

  it('handles hyphenated 13-digit ISBN', () => {
    expect(normalizeISBN('978-0-306-40615-7')).toBe('9780306406157');
  });

  it('throws on too-short input', () => {
    expect(() => normalizeISBN('12345')).toThrow('Invalid ISBN format.');
  });

  it('throws on non-numeric input', () => {
    expect(() => normalizeISBN('ABCDEFGHIJ')).toThrow('Invalid ISBN format.');
  });

  it('throws on 11-digit input', () => {
    expect(() => normalizeISBN('12345678901')).toThrow('Invalid ISBN format.');
  });
});

// ---------------------------------------------------------------------------
// lookupISBN — fetch is mocked for all tests
// ---------------------------------------------------------------------------

function makeStreamResponse(data: unknown): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return { ok: true, body: stream } as unknown as Response;
}

describe('lookupISBN', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns title/author/publisher on success', async () => {
    const payload = {
      'ISBN:9780306406157': {
        title: 'On Being a Scientist',
        authors: [{ name: 'Committee on Science' }],
        publishers: [{ name: 'National Academies Press' }],
      },
    };
    vi.mocked(fetch).mockResolvedValue(makeStreamResponse(payload));

    const result = await lookupISBN('9780306406157');
    expect(result).toEqual({
      title: 'On Being a Scientist',
      author: 'Committee on Science',
      publisher: 'National Academies Press',
    });
  });

  it('returns null when the ISBN is not in the response', async () => {
    vi.mocked(fetch).mockResolvedValue(makeStreamResponse({}));

    const result = await lookupISBN('9780306406157');
    expect(result).toBeNull();
  });

  it('returns null on timeout (AbortError)', async () => {
    vi.mocked(fetch).mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError'),
    );

    const result = await lookupISBN('9780306406157');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network error'));

    const result = await lookupISBN('9780306406157');
    expect(result).toBeNull();
  });

  it('returns null for an invalid ISBN (not numeric)', async () => {
    const result = await lookupISBN('NOTANISBN');
    expect(result).toBeNull();
    // fetch should never have been called — invalid ISBN rejected before network
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('returns null when response body exceeds 64 KB', async () => {
    // Build a payload > 64 KB
    const bigString = 'x'.repeat(65 * 1024);
    const bytes = new TextEncoder().encode(bigString);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    vi.mocked(fetch).mockResolvedValue({ ok: true, body: stream } as unknown as Response);

    const result = await lookupISBN('9780306406157');
    expect(result).toBeNull();
  });

  it('returns null when response is not ok', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, body: null } as unknown as Response);

    const result = await lookupISBN('9780306406157');
    expect(result).toBeNull();
  });

  it('accepts ISBN-10 input and looks up normalised ISBN-13', async () => {
    // 0306406152 → ISBN-13 key ISBN:9780306406157
    const payload = {
      'ISBN:0306406152': {
        title: 'Some Book',
        authors: [{ name: 'Some Author' }],
        publishers: [{ name: 'Some Press' }],
      },
    };
    vi.mocked(fetch).mockResolvedValue(makeStreamResponse(payload));

    // lookupISBN uses the raw stripped ISBN as the key, not the normalised ISBN-13
    const result = await lookupISBN('0306406152');
    expect(result).toEqual({
      title: 'Some Book',
      author: 'Some Author',
      publisher: 'Some Press',
    });
  });
});
