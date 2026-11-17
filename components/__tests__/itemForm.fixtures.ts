import { vi } from 'vitest';

/**
 * This app's field labels are bare <label> elements with no for/id
 * association to their input — walk from the label text to the nearest
 * sibling input/select/textarea instead of relying on getByLabelText.
 */
export function fieldByLabel(labelText: string): HTMLElement {
  const labels = Array.from(document.querySelectorAll('label'));
  const label = labels.find(l => l.textContent?.trim().startsWith(labelText));
  if (!label) throw new Error(`No label found starting with "${labelText}"`);
  const el = label.parentElement?.querySelector('input, select, textarea');
  if (!el) throw new Error(`No form control found for label "${labelText}"`);
  return el as HTMLElement;
}

export function jsonResponse(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface FetchStubRoutes {
  /** Answer for POST /api/items; an Error is thrown instead of returned. */
  items?: Response | Error;
  /** Answer for GET /api/isbn/:isbn; an Error is thrown instead of returned. */
  isbn?: Response | Error;
  /** Answer for any other URL; defaults to a 404. */
  fallback?: (url: string) => Response | Promise<Response>;
}

function answer(result: Response | Error): Response {
  if (result instanceof Error) throw result;
  return result;
}

/**
 * Stubs fetch for the "add item" forms: the suggestions endpoint (hit on
 * mount) always resolves with no values, the routes given answer as
 * configured, and everything else is a 404.
 */
export function stubFetch(routes: FetchStubRoutes = {}) {
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/items/suggestions')) return jsonResponse(200, { values: [] });
    if (routes.isbn && url.startsWith('/api/isbn/')) return answer(routes.isbn);
    if (routes.items && url === '/api/items') return answer(routes.items);
    return routes.fallback ? routes.fallback(url) : jsonResponse(404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
