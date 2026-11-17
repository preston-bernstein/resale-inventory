// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CredentialStep from '@/components/connections/CredentialStep';
import { jsonResponse } from '@/tests/jsonResponse';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers — without this, each test's
// render stays mounted and later queries see duplicate content.
afterEach(cleanup);

afterEach(() => {
  vi.unstubAllGlobals();
});

const CREATED = {
  id: 'conn-1',
  platform: 'ebay',
  status: 'pending',
  lastVerifiedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// eBay's credentialFieldSpecs entry: identifierKey 'username', secretFields
// 'apiKey' + 'apiSecret'.
const IDENTIFIER = 'bookseller123';
const API_KEY = 'super-secret-api-key-value';
const API_SECRET = 'super-secret-api-secret-value';
// maskIdentifier('bookseller123') -> first char + fixed 3-asterisk middle + last char.
const MASKED_IDENTIFIER = 'b***3';


async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('eBay username'), IDENTIFIER);
  await user.type(screen.getByLabelText('API Key'), API_KEY);
  await user.type(screen.getByLabelText('API Secret'), API_SECRET);
}

type User = ReturnType<typeof userEvent.setup>;
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

/**
 * Fetch mock for the create + consent sequence. `override` runs first and may
 * answer a request itself (returning undefined falls through to the default
 * create/consent success responses). Any other URL throws.
 */
function stubConnectFetch(override: Handler = () => undefined) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const overridden = override(url, init);
    if (overridden) return overridden;
    if (url === '/api/connections' && init?.method === 'POST') {
      return jsonResponse(CREATED);
    }
    if (url === `/api/connections/${CREATED.id}/consent` && init?.method === 'POST') {
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Renders the eBay step, fills it in and clicks Connect. */
async function submitEbayForm(onSuccess: () => void) {
  const user: User = userEvent.setup();
  const view = render(<CredentialStep platform="ebay" disclosureVersion={3} onSuccess={onSuccess} />);
  await fillForm(user);
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  return { user, container: view.container };
}

const EXPECTED_SUCCESS = {
  platform: 'ebay',
  connectionId: CREATED.id,
  maskedIdentifier: MASKED_IDENTIFIER,
};

function isCreateCall([url, init]: [string, RequestInit?]) {
  return url === '/api/connections' && init?.method === 'POST';
}

function assertNeverLoggedSecret(spy: { mock: { calls: unknown[][] } }) {
  for (const call of spy.mock.calls) {
    for (const arg of call) {
      const asString = typeof arg === 'string' ? arg : JSON.stringify(arg);
      expect(asString ?? '').not.toContain(API_KEY);
      expect(asString ?? '').not.toContain(API_SECRET);
    }
  }
}

function expectNoSecretIn(text: string, secrets: string[]) {
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
}

function expectConnectionNeverRecreated(fetchMock: ReturnType<typeof stubConnectFetch>) {
  // The critical assertion: POST /api/connections happened exactly ONCE
  // across the whole flow, including the retry — the connection is never
  // recreated.
  expect(fetchMock.mock.calls.filter(isCreateCall)).toHaveLength(1);

  // Both consent attempts (the original + the retry) targeted the SAME
  // connection id from the original create response.
  const consentCalls = fetchMock.mock.calls.filter(
    ([url]) => typeof url === 'string' && url.startsWith('/api/connections/') && url.endsWith('/consent'),
  );
  expect(consentCalls).toHaveLength(2);
  for (const [url] of consentCalls) {
    expect(url).toBe(`/api/connections/${CREATED.id}/consent`);
  }
}

describe('CredentialStep — happy path', () => {
  it('happy path: POSTs create then consent with the create response id and disclosureVersion prop, and reports a masked identifier', async () => {
    const fetchMock = stubConnectFetch();
    const onSuccess = vi.fn();

    await submitEbayForm(onSuccess);

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [createUrl, createInit] = fetchMock.mock.calls[0];
    expect(createUrl).toBe('/api/connections');
    expect(JSON.parse(createInit!.body as string)).toEqual({
      platform: 'ebay',
      credential: { username: IDENTIFIER, apiKey: API_KEY, apiSecret: API_SECRET },
    });

    const [consentUrl, consentInit] = fetchMock.mock.calls[1];
    expect(consentUrl).toBe(`/api/connections/${CREATED.id}/consent`);
    expect(JSON.parse(consentInit!.body as string)).toEqual({ disclosure_version: 3 });

    expect(onSuccess).toHaveBeenCalledWith(EXPECTED_SUCCESS);
  });
});

describe('CredentialStep — stale disclosure retry', () => {
  it('stale disclosure-version retry reuses the SAME connection id from the original create response — never recreates the connection', async () => {
    let consentCallCount = 0;
    const fetchMock = stubConnectFetch((url, init) => {
      if (url === `/api/connections/${CREATED.id}/consent` && init?.method === 'POST') {
        consentCallCount += 1;
        if (consentCallCount === 1) {
          return jsonResponse({ error: 'stale_disclosure_version' }, false, 422);
        }
        const body = JSON.parse(init!.body as string);
        expect(body).toEqual({ disclosure_version: 9 });
        return jsonResponse({ ok: true });
      }
      if (url === '/api/disclosures/current') {
        return jsonResponse({ version: 9 });
      }
      return undefined;
    });
    const onSuccess = vi.fn();

    const { user } = await submitEbayForm(onSuccess);

    // Retry banner appears after the 422 + disclosures/current re-fetch.
    await screen.findByRole('button', { name: 'Retry' });
    const banner = screen.getByText(/consent terms have been updated/i);
    expect(banner).toBeInTheDocument();
    expectNoSecretIn(banner.textContent ?? '', [API_KEY, API_SECRET]);

    // So far: create, first (422) consent, disclosures/current re-fetch.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onSuccess).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onSuccess).toHaveBeenCalledWith(EXPECTED_SUCCESS);

    expectConnectionNeverRecreated(fetchMock);
  });
});

describe('CredentialStep — secret handling', () => {
  it('never logs or exposes secret field values — not in the DOM, console, or the onSuccess callback', async () => {
    stubConnectFetch();

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const onSuccess = vi.fn();
    const { container } = await submitEbayForm(onSuccess);

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));

    assertNeverLoggedSecret(consoleLogSpy);
    assertNeverLoggedSecret(consoleErrorSpy);

    // Secret (and raw identifier) values never appear as rendered DOM text —
    // only masked/derived data should ever reach the screen.
    expectNoSecretIn(container.textContent ?? '', [API_KEY, API_SECRET, IDENTIFIER]);

    // onSuccess only ever receives the masked identifier — never the raw
    // identifier or any secret field value.
    const successArgs = onSuccess.mock.calls[0][0];
    expect(successArgs).toEqual(EXPECTED_SUCCESS);
    expectNoSecretIn(JSON.stringify(successArgs), [API_KEY, API_SECRET, IDENTIFIER]);

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});
