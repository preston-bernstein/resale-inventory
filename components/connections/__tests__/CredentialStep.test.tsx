// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CredentialStep from '@/components/connections/CredentialStep';

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

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('eBay username'), IDENTIFIER);
  await user.type(screen.getByLabelText('API Key'), API_KEY);
  await user.type(screen.getByLabelText('API Secret'), API_SECRET);
}

describe('CredentialStep', () => {
  it('happy path: POSTs create then consent with the create response id and disclosureVersion prop, and reports a masked identifier', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/connections' && init?.method === 'POST') {
        return jsonResponse(CREATED);
      }
      if (url === `/api/connections/${CREATED.id}/consent` && init?.method === 'POST') {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const onSuccess = vi.fn();
    const user = userEvent.setup();
    render(<CredentialStep platform="ebay" disclosureVersion={3} onSuccess={onSuccess} />);

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Connect' }));

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

    expect(onSuccess).toHaveBeenCalledWith({
      platform: 'ebay',
      connectionId: CREATED.id,
      maskedIdentifier: MASKED_IDENTIFIER,
    });
  });

  it('stale disclosure-version retry reuses the SAME connection id from the original create response — never recreates the connection', async () => {
    let consentCallCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/connections' && init?.method === 'POST') {
        return jsonResponse(CREATED);
      }
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
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const onSuccess = vi.fn();
    const user = userEvent.setup();
    render(<CredentialStep platform="ebay" disclosureVersion={3} onSuccess={onSuccess} />);

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    // Retry banner appears after the 422 + disclosures/current re-fetch.
    await screen.findByRole('button', { name: 'Retry' });
    const banner = screen.getByText(/consent terms have been updated/i);
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).not.toContain(API_KEY);
    expect(banner.textContent).not.toContain(API_SECRET);

    // So far: create, first (422) consent, disclosures/current re-fetch.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onSuccess).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onSuccess).toHaveBeenCalledWith({
      platform: 'ebay',
      connectionId: CREATED.id,
      maskedIdentifier: MASKED_IDENTIFIER,
    });

    // The critical assertion: POST /api/connections happened exactly ONCE
    // across the whole flow, including the retry — the connection is never
    // recreated.
    const createCalls = fetchMock.mock.calls.filter(
      ([url, init]) => url === '/api/connections' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(createCalls).toHaveLength(1);

    // Both consent attempts (the original + the retry) targeted the SAME
    // connection id from the original create response.
    const consentCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.startsWith('/api/connections/') && url.endsWith('/consent'),
    );
    expect(consentCalls).toHaveLength(2);
    for (const [url] of consentCalls) {
      expect(url).toBe(`/api/connections/${CREATED.id}/consent`);
    }
  });

  it('never logs or exposes secret field values — not in the DOM, console, or the onSuccess callback', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/connections' && init?.method === 'POST') {
        return jsonResponse(CREATED);
      }
      if (url === `/api/connections/${CREATED.id}/consent` && init?.method === 'POST') {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const onSuccess = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <CredentialStep platform="ebay" disclosureVersion={3} onSuccess={onSuccess} />,
    );

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));

    function assertNeverLoggedSecret(spy: typeof consoleLogSpy) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          const asString = typeof arg === 'string' ? arg : JSON.stringify(arg);
          expect(asString ?? '').not.toContain(API_KEY);
          expect(asString ?? '').not.toContain(API_SECRET);
        }
      }
    }

    assertNeverLoggedSecret(consoleLogSpy);
    assertNeverLoggedSecret(consoleErrorSpy);

    // Secret (and raw identifier) values never appear as rendered DOM text —
    // only masked/derived data should ever reach the screen.
    expect(container.textContent).not.toContain(API_KEY);
    expect(container.textContent).not.toContain(API_SECRET);
    expect(container.textContent).not.toContain(IDENTIFIER);

    // onSuccess only ever receives the masked identifier — never the raw
    // identifier or any secret field value.
    const successArgs = onSuccess.mock.calls[0][0];
    expect(successArgs).toEqual({
      platform: 'ebay',
      connectionId: CREATED.id,
      maskedIdentifier: MASKED_IDENTIFIER,
    });
    const successArgsSerialized = JSON.stringify(successArgs);
    expect(successArgsSerialized).not.toContain(API_KEY);
    expect(successArgsSerialized).not.toContain(API_SECRET);
    expect(successArgsSerialized).not.toContain(IDENTIFIER);

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});
