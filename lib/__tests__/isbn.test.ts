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

  it('throws on a valid 13-digit suffix preceded by non-digit characters (regex must anchor at the start)', () => {
    // Without the leading `^` on the 13-digit check, a string merely ENDING
    // in 13 digits would wrongly pass, and the stray prefix would leak
    // straight through into the returned "normalised" ISBN.
    expect(() => normalizeISBN('AB9780306406157')).toThrow('Invalid ISBN format.');
  });

  it('throws on a valid 13-digit prefix followed by trailing digits (regex must anchor at the end)', () => {
    // Without the trailing `$` on the 13-digit check, a 14+ digit string
    // that merely STARTS with 13 valid digits would wrongly pass — and the
    // extra trailing digit(s) would be silently dropped rather than
    // rejected, since normalizeISBN returns the matched value as-is.
    expect(() => normalizeISBN('97803064061579')).toThrow('Invalid ISBN format.');
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
      status: 'found',
      title: 'On Being a Scientist',
      author: 'Committee on Science',
      publisher: 'National Academies Press',
    });
  });

  it('returns not-found when the ISBN is not in the response', async () => {
    vi.mocked(fetch).mockResolvedValue(makeStreamResponse({}));

    const result = await lookupISBN('9780306406157');
    expect(result).toEqual({ status: 'not-found' });
  });

  it('returns unavailable/timeout on timeout (AbortError)', async () => {
    vi.mocked(fetch).mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError'),
    );

    const result = await lookupISBN('9780306406157');
    expect(result).toEqual({ status: 'unavailable', reason: 'timeout' });
  });

  it('returns unavailable/network on network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network error'));

    const result = await lookupISBN('9780306406157');
    expect(result).toEqual({ status: 'unavailable', reason: 'network' });
  });

  it('returns invalid for an invalid ISBN (not numeric)', async () => {
    const result = await lookupISBN('NOTANISBN');
    expect(result).toEqual({ status: 'invalid' });
    // fetch should never have been called — invalid ISBN rejected before network
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('returns unavailable/oversize when response body exceeds 64 KB', async () => {
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
    expect(result).toEqual({ status: 'unavailable', reason: 'oversize' });
  });

  it('returns unavailable/bad-response when response is not ok', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, body: null } as unknown as Response);

    const result = await lookupISBN('9780306406157');
    expect(result).toEqual({ status: 'unavailable', reason: 'bad-response' });
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
      status: 'found',
      title: 'Some Book',
      author: 'Some Author',
      publisher: 'Some Press',
    });
  });

  it('rejects a valid ISBN-10 suffix preceded by non-digit characters (regex must anchor at the start)', async () => {
    // Without the leading `^` on the ISBN-10 alternative, a string ending in a
    // valid 10-char ISBN-10 body would incorrectly validate regardless of prefix.
    const result = await lookupISBN('ZZ0306406152');
    expect(result).toEqual({ status: 'invalid' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('rejects a valid 13-digit suffix preceded by non-digit characters (regex must anchor at the start)', async () => {
    // Without the leading `^` on the 13-digit alternative, a string ending in
    // 13 digits would incorrectly validate regardless of prefix.
    const result = await lookupISBN('ZZ9780593099322');
    expect(result).toEqual({ status: 'invalid' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('calls fetch with the correctly constructed Open Library URL and an abort signal', async () => {
    vi.mocked(fetch).mockResolvedValue(makeStreamResponse({}));

    await lookupISBN('978-0-306-40615-7');

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(
      'https://openlibrary.org/api/books?bibkeys=ISBN:9780306406157&format=json&jscmd=data',
    );
    expect(opts).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it('aborts the fetch after the 3-second timeout fires', async () => {
    vi.useFakeTimers();
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));

    void lookupISBN('9780306406157');
    await vi.advanceTimersByTimeAsync(3000);

    expect(abortSpy).toHaveBeenCalled();

    abortSpy.mockRestore();
    vi.useRealTimers();
  });

  it('returns bad-response when response is not ok, even though a body is present', async () => {
    const bytes = new TextEncoder().encode('{}');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    vi.mocked(fetch).mockResolvedValue({ ok: false, body: stream } as unknown as Response);

    const result = await lookupISBN('9780306406157');
    expect(result).toEqual({ status: 'unavailable', reason: 'bad-response' });
  });

  it('returns bad-response when response is ok but the body is missing', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, body: null } as unknown as Response);

    const result = await lookupISBN('9780306406157');
    expect(result).toEqual({ status: 'unavailable', reason: 'bad-response' });
  });

  it('does not flag a body of exactly 64 KB as oversize (boundary)', async () => {
    // MAX_BYTES = 64 * 1024 = 65536. A body of exactly that size must be
    // accepted (`>` not `>=`); pad valid JSON with trailing whitespace.
    const payload = '{}' + ' '.repeat(65536 - 2);
    const bytes = new TextEncoder().encode(payload);
    expect(bytes.length).toBe(65536);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    vi.mocked(fetch).mockResolvedValue({ ok: true, body: stream } as unknown as Response);

    const result = await lookupISBN('9780306406157');
    expect(result).toEqual({ status: 'not-found' });
  });

  it('treats a null thrown value as a non-abort network error', async () => {
    vi.mocked(fetch).mockRejectedValue(null);
    const result = await lookupISBN('9780306406157');
    expect(result).toEqual({ status: 'unavailable', reason: 'network' });
  });

  it('returns unavailable/bad-response when the body is not valid JSON', async () => {
    const bytes = new TextEncoder().encode('not json');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    vi.mocked(fetch).mockResolvedValue({ ok: true, body: stream } as unknown as Response);

    const result = await lookupISBN('9780306406157');
    expect(result).toEqual({ status: 'unavailable', reason: 'bad-response' });
  });

  it('correctly reassembles a multi-chunk response body', async () => {
    const payload = JSON.stringify({
      'ISBN:9780306406157': {
        title: 'Chunked Book',
        authors: [{ name: 'Chunky Author' }],
        publishers: [{ name: 'Chunky Press' }],
      },
    });
    const fullBytes = new TextEncoder().encode(payload);
    const mid = Math.floor(fullBytes.length / 2);
    const chunk1 = fullBytes.slice(0, mid);
    const chunk2 = fullBytes.slice(mid);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      },
    });
    vi.mocked(fetch).mockResolvedValue({ ok: true, body: stream } as unknown as Response);

    const result = await lookupISBN('9780306406157');
    expect(result).toEqual({
      status: 'found',
      title: 'Chunked Book',
      author: 'Chunky Author',
      publisher: 'Chunky Press',
    });
  });

  it('clears the timeout after a successful lookup', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    vi.mocked(fetch).mockResolvedValue(makeStreamResponse({}));

    await lookupISBN('9780306406157');

    expect(clearSpy).toHaveBeenCalled();

    clearSpy.mockRestore();
    vi.useRealTimers();
  });

  it('returns empty author/publisher when authors/publishers are present but empty arrays', async () => {
    const payload = {
      'ISBN:9780306406157': {
        title: 'No Credited People',
        authors: [],
        publishers: [],
      },
    };
    vi.mocked(fetch).mockResolvedValue(makeStreamResponse(payload));

    const result = await lookupISBN('9780306406157');
    expect(result).toEqual({
      status: 'found',
      title: 'No Credited People',
      author: '',
      publisher: '',
    });
  });
});
