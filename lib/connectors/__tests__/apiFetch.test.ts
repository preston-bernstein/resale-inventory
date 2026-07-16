import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch } from '../apiFetch';

// Minimal stand-in for the subset of the real `Response` shape apiFetch.ts
// actually reads: `status`, `ok`, and an async `text()`. Building this by
// hand (rather than a real Response) keeps each test's intent obvious.
function jsonResponse(status: number, bodyObj: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(bodyObj),
  } as unknown as Response;
}

function textResponse(status: number, text: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
  } as unknown as Response;
}

// A fetch mock that never resolves on its own -- it only settles (by
// rejecting with an AbortError) once the caller's AbortSignal fires. This
// mirrors real `fetch`'s behavior when a request is aborted mid-flight, and
// is what lets the timeoutMs-driven AbortController in apiFetch.ts actually
// exercise the timeout path in a test.
function neverResolvingFetch(
  _input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('parses a successful JSON response into {status, ok: true, body}', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { hello: 'world' }));

    const result = await apiFetch('https://example.com/api', { method: 'GET' });

    expect(result).toEqual({ status: 200, ok: true, body: { hello: 'world' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to raw text when the response body is not valid JSON', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse(200, 'not json at all'));

    const result = await apiFetch('https://example.com/api', { method: 'GET' });

    expect(result).toEqual({ status: 200, ok: true, body: 'not json at all' });
  });

  it('returns a non-2xx response normally, without retrying or throwing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }));

    const result = await apiFetch('https://example.com/api', { method: 'GET' });

    expect(result).toEqual({ status: 404, ok: false, body: { error: 'not found' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('JSON-serializes `body` and sets Content-Type: application/json when body is present', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await apiFetch('https://example.com/api', {
      method: 'POST',
      body: { foo: 'bar' },
    });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.body).toBe(JSON.stringify({ foo: 'bar' }));
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('retries exactly once on a network error, and throws if the retry also fails', async () => {
    const networkError = new Error('network down');
    vi.mocked(fetch).mockRejectedValueOnce(networkError).mockRejectedValueOnce(networkError);

    await expect(apiFetch('https://example.com/api', { method: 'GET' })).rejects.toThrow(
      'network down',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('recovers if the retry succeeds after an initial network error', async () => {
    const networkError = new Error('network down');
    vi.mocked(fetch)
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(jsonResponse(200, { recovered: true }));

    const result = await apiFetch('https://example.com/api', { method: 'GET' });

    expect(result).toEqual({ status: 200, ok: true, body: { recovered: true } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries exactly once on a timeout, and throws if the retry also times out', async () => {
    vi.mocked(fetch).mockImplementation(neverResolvingFetch);

    await expect(
      apiFetch('https://example.com/api', { method: 'GET', timeoutMs: 20 }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('defaults to method GET when no method is supplied', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, {}));

    await apiFetch('https://example.com/api');

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.method).toBe('GET');
  });

  it('preserves caller-supplied headers alongside the auto-added Content-Type, rather than discarding them', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, {}));

    await apiFetch('https://example.com/api', {
      method: 'POST',
      headers: { Authorization: 'Bearer xyz', 'X-Custom': 'value' },
      body: { foo: 'bar' },
    });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer xyz');
    expect(headers['X-Custom']).toBe('value');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('when body is omitted entirely, sends no body and never adds a Content-Type header', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, {}));

    await apiFetch('https://example.com/api', { method: 'GET' });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('does not attempt to JSON.parse an empty response body, and returns it as the empty string', async () => {
    const parseSpy = vi.spyOn(JSON, 'parse');
    vi.mocked(fetch).mockResolvedValueOnce(textResponse(204, ''));

    const result = await apiFetch('https://example.com/api', { method: 'DELETE' });

    expect(result).toEqual({ status: 204, ok: true, body: '' });
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it('clears the timeout handle after a successful response, so it never fires and aborts a later, unrelated request', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await apiFetch('https://example.com/api', { method: 'GET' });

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    clearTimeoutSpy.mockRestore();
  });
});
