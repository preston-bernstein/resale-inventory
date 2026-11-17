import { describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { jsonResponse } from '@/tests/jsonResponse';

type Responder = () => Response | Promise<Response>;
export type User = ReturnType<typeof userEvent.setup>;

/**
 * This app's field labels are bare <label> elements with no for/id
 * association to their input — walk from the label text to the nearest
 * sibling input/select/textarea instead of relying on getByLabelText.
 */
export function fieldByLabel(labelText: string): HTMLElement {
  const labels = Array.from(document.querySelectorAll('label'));
  const label = labels.find((l) => l.textContent?.trim().startsWith(labelText));
  if (!label) throw new Error(`No label found starting with "${labelText}"`);
  const el = label.parentElement?.querySelector('input, select, textarea');
  if (!el) throw new Error(`No form control found for label "${labelText}"`);
  return el as HTMLElement;
}

export interface FormRoutes {
  /** Answers /api/isbn/ lookups; without it they 404. */
  isbn?: Responder;
  /** Answers POST /api/items; without it the POST 404s. */
  items?: Responder;
}

/** Default fetch mock: the suggestions endpoint (hit on mount) always resolves. */
export function stubItemFormFetch(routes: FormRoutes = {}) {
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/items/suggestions')) {
      return jsonResponse({ values: [] });
    }
    if (url.startsWith('/api/isbn/') && routes.isbn) {
      return routes.isbn();
    }
    if (url === '/api/items' && routes.items) {
      return routes.items();
    }
    return jsonResponse({}, false, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export type FetchMock = ReturnType<typeof stubItemFormFetch>;

function itemsPostCall(fetchMock: FetchMock) {
  return fetchMock.mock.calls.find((c) => String(c[0]) === '/api/items');
}

export function expectNoItemsPost(fetchMock: FetchMock) {
  expect(itemsPostCall(fetchMock)).toBeUndefined();
}

/** The request the form POSTed to /api/items, with its JSON body parsed. */
export function postedItem(fetchMock: FetchMock) {
  const postCall = itemsPostCall(fetchMock);
  if (!postCall) throw new Error('expected the form to POST to /api/items');
  const init = postCall[1] as RequestInit;
  return { init, body: JSON.parse(init.body as string) as Record<string, unknown> };
}

/** Renders `form`, runs `fill`, then clicks the submit button named `buttonName`. */
export async function fillAndSubmit(
  form: ReactElement,
  buttonName: string,
  fill: (user: User) => Promise<void>,
) {
  const user = userEvent.setup();
  render(form);
  await fill(user);
  await user.click(screen.getByRole('button', { name: buttonName }));
}

export interface SubmissionErrorSuite {
  /** Form name, used in the describe title. */
  name: string;
  /** Renders the form with valid required fields and clicks submit. */
  submit: () => Promise<void>;
  /** The router.push mock the form's test file registered. */
  pushMock: Mock;
  /** One server-side field error to return with a 422 and where it should surface. */
  fieldError: { field: string; message: string };
}

/**
 * Server and network failure handling shared by every add-item form: a 422
 * puts field messages next to the fields, other failures show the server's
 * message or a generic one, and none of them redirect.
 */
export function describeSubmissionErrors({ name, submit, pushMock, fieldError }: SubmissionErrorSuite) {
  describe(`${name} — submission errors`, () => {
    it('surfaces field-level errors from a 422 response without redirecting', async () => {
      stubItemFormFetch({
        items: () => jsonResponse({ fields: { [fieldError.field]: fieldError.message } }, false, 422),
      });

      await submit();

      expect(await screen.findByText(fieldError.message)).toBeInTheDocument();
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('surfaces a generic submission error when the server returns a non-201/422 status with an error message', async () => {
      stubItemFormFetch({ items: () => jsonResponse({ error: 'Database is on fire.' }, false, 500) });

      await submit();

      expect(await screen.findByText('Database is on fire.')).toBeInTheDocument();
    });

    it('falls back to a generic "Submission failed." message when the server gives no error body', async () => {
      stubItemFormFetch({ items: () => jsonResponse({}, false, 500) });

      await submit();

      expect(await screen.findByText('Submission failed.')).toBeInTheDocument();
    });

    it('shows a network error message when fetch rejects', async () => {
      stubItemFormFetch({
        items: () => {
          throw new Error('boom');
        },
      });

      await submit();

      expect(await screen.findByText('Network error — please try again.')).toBeInTheDocument();
    });
  });
}
