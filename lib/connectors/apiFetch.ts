// Thin transport wrapper around global `fetch`, shared by every marketplace
// connector (ebay.ts, etsy.ts, amazon.ts, ...). This module deliberately
// knows nothing about any platform's error shape or secret-bearing fields --
// each connector classifies/scrubs its own errors using scrub.ts after
// calling apiFetch(). apiFetch()'s only job is: build the request, apply a
// timeout, parse the response body, and retry exactly once on a transient
// (network/timeout) failure.

const DEFAULT_TIMEOUT_MS = 10_000;

export interface ApiFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown; // JSON-serialized if present
  timeoutMs?: number; // default 10000
}

export interface ApiFetchResult {
  status: number;
  ok: boolean;
  body: unknown; // parsed JSON, or raw text if not JSON
}

/**
 * Perform a single fetch attempt (no retry logic here -- that lives in
 * apiFetch() below) with an AbortController-based timeout. Returns the
 * parsed result on a normal HTTP response (2xx or not -- that's not a
 * transient failure). Throws on network error or timeout/abort, which is
 * the signal apiFetch() uses to decide whether to retry.
 */
async function attemptFetch(url: string, options: ApiFetchOptions): Promise<ApiFetchResult> {
  const { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const finalHeaders: Record<string, string> = { ...headers };
    let finalBody: string | undefined;
    if (body !== undefined) {
      finalHeaders['Content-Type'] = 'application/json';
      finalBody = JSON.stringify(body);
    }

    const response = await fetch(url, {
      method,
      headers: finalHeaders,
      body: finalBody,
      signal: controller.signal,
    });

    const text = await response.text();
    let parsedBody: unknown = text;
    if (text.length > 0) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        // Not JSON -- fall back to raw text, already assigned above.
      }
    }

    return {
      status: response.status,
      ok: response.ok,
      body: parsedBody,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch `url`, JSON-serializing `body` if present, with a timeout (default
 * 10s) enforced via AbortController. On a transient failure -- a network
 * error or a timeout/AbortError -- the request is retried exactly once
 * before giving up and (re)throwing. A normal non-2xx HTTP response is NOT a
 * transient failure and is returned as-is, with no retry.
 */
export async function apiFetch(url: string, options: ApiFetchOptions = {}): Promise<ApiFetchResult> {
  try {
    return await attemptFetch(url, options);
  } catch {
    // Transient failure (network error, timeout/AbortError) -- retry exactly
    // once. If the retry also fails, let that error propagate to the caller.
    return await attemptFetch(url, options);
  }
}
