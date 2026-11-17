/** A minimal fetch Response stand-in whose `json()` resolves to `body`. */
export function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}
