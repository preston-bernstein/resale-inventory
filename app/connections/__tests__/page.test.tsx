// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConnectionsView from '@/components/connections/ConnectionsView';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers -- without this, each test's
// render stays mounted and later queries see duplicate content.
afterEach(cleanup);

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

// Full happy-path fixture data for the wired flow: empty state -> connect
// cards -> consent -> credentials -> masked confirmation, driven through the
// real ConnectionsView state machine (app/connections/page.tsx itself is a
// server component using next/headers cookies(), which jsdom can't execute,
// so ConnectionsView is the correct component under test here -- same
// approach as components/connections/__tests__/ConnectionsView.test.tsx).
const CREATED_CONNECTION = {
  id: 'conn-123',
  platform: 'depop',
  status: 'active',
  lastVerifiedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/**
 * A single fetch mock that inspects URL + method and returns the right
 * canned response for each of the 4 (really 5, counting FirstWinPanel's
 * own fetch) endpoints touched by the full flow. Throws on anything
 * unexpected so a wiring regression surfaces as a loud test failure rather
 * than a silent undefined response.
 */
function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url === '/api/connections' && method === 'GET') {
      return jsonResponse([]);
    }
    if (url === '/api/disclosures/current' && method === 'GET') {
      return jsonResponse({ version: 3, content: 'Selling on Depop carries risk X, Y, Z.' });
    }
    if (url === '/api/connections' && method === 'POST') {
      return jsonResponse(CREATED_CONNECTION, true, 201);
    }
    if (url === '/api/connections/conn-123/consent' && method === 'POST') {
      return jsonResponse({ disclosure_version: 3, consented_at: '2026-01-01T00:00:00.000Z' }, true, 201);
    }
    if (url === '/api/connections/conn-123/first-win' && method === 'GET') {
      return jsonResponse({ healthy: false, detail: 'dry-run: no items yet', readyCount: 0 });
    }

    throw new Error(`Unexpected fetch call in test: ${method} ${url}`);
  });
}

describe('ConnectionsView full flow (app/connections page integration)', () => {
  it('drives empty state -> connect cards -> consent -> credentials -> masked confirmation with correct network ordering', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<ConnectionsView tenantId="tenant-1" />);

    // 1. GET /api/connections on mount -> empty state (AC-adjacent: nothing
    // renders before the connections list is known).
    await waitFor(() => expect(screen.getByTestId('connections-empty-state')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/connections');

    await user.click(screen.getByRole('button', { name: 'Connect a marketplace' }));

    // Connect cards render; pick depop, a credential-tier platform (not an
    // OAuth-labeled card), since credential-tier is the central risk-framing
    // surface for this feature.
    await waitFor(() => expect(screen.getByTestId('connect-card-grid')).toBeInTheDocument());
    const depopCard = screen.getByTestId('connect-card-depop');
    await user.click(within(depopCard).getByRole('button', { name: 'Connect' }));

    // 2. GET /api/disclosures/current fires for the consent screen. Per AC5,
    // no create call must have happened yet at this point.
    await waitFor(() =>
      expect(screen.getByText('I understand and accept these risks')).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/disclosures/current');
    expect(
      fetchMock.mock.calls.some(
        (call) => String(call[0]) === '/api/connections' && (call[1] as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(false);

    // AC7: the checkbox must start unchecked -- continuing is blocked until
    // the user affirmatively checks it themselves.
    const consentCheckbox = screen.getByRole('checkbox');
    expect(consentCheckbox).not.toBeChecked();
    const continueButton = screen.getByRole('button', { name: 'I understand, continue' });
    expect(continueButton).toBeDisabled();

    await user.click(consentCheckbox);
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);

    // Credential step renders depop's identifier + secret fields per
    // credentialFieldSpecs (username + password).
    const identifierInput = await screen.findByLabelText('Depop username');
    const passwordInput = screen.getByLabelText('Password');

    const rawIdentifier = 'myusername';
    const rawSecret = 'supersecret123';
    await user.type(identifierInput, rawIdentifier);
    await user.type(passwordInput, rawSecret);

    await user.click(screen.getByRole('button', { name: 'Connect' }));

    // 3 & 4: POST /api/connections, then POST /api/connections/:id/consent
    // using the id from the create response (AC8: correct
    // disclosure_version handling round-trips through this same call).
    await waitFor(() => expect(screen.getByTestId('connection-confirmation')).toBeInTheDocument());

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/connections',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          platform: 'depop',
          credential: { username: rawIdentifier, password: rawSecret },
        }),
      }),
    );

    const fourthCallUrl = String(fetchMock.mock.calls[3][0]);
    expect(fourthCallUrl).toContain('conn-123');
    expect(fourthCallUrl).toBe('/api/connections/conn-123/consent');
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      '/api/connections/conn-123/consent',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ disclosure_version: 3 }),
      }),
    );

    // 5. AC12: the masked identifier shown is derived client-side from the
    // value the user typed -- no round trip to fetch it back, and the raw
    // identifier/secret must never appear verbatim anywhere in the
    // confirmation's rendered text.
    const confirmation = screen.getByTestId('connection-confirmation');
    const confirmationText = confirmation.textContent ?? '';

    expect(confirmationText).toContain('Connected!');
    expect(confirmationText).toContain('m***e'); // maskIdentifier('myusername') -> first + *** + last
    expect(confirmationText).not.toContain(rawIdentifier);
    expect(confirmationText).not.toContain(rawSecret);

    // FirstWinPanel (rendered inside ConnectionConfirmation) fires its own
    // GET .../first-win on mount -- let it settle so the test doesn't tear
    // down mid-flight and doesn't throw an unhandled rejection.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]) === '/api/connections/conn-123/first-win'),
      ).toBe(true),
    );

    // (a) FirstWinPanel's content must actually RENDER in this same view --
    // not just that the fetch fired (checked above). No extra navigation
    // happens to see it: it's already on screen alongside the confirmation.
    await waitFor(() => expect(screen.getByTestId('first-win-health')).toBeInTheDocument());
    expect(screen.getByTestId('first-win-ready-count')).toBeInTheDocument();
  });
});

// Fixture for an already-existing connection, used by (b) and (c) below.
// status 'active' on a real SupportedPlatform (poshmark, per lib/constants.ts)
// so it renders through both ConnectCardGrid and StatusList per
// ConnectionsView's `connections.length > 0` branch.
const EXISTING_CONNECTION = {
  id: 'conn-existing',
  platform: 'poshmark',
  status: 'active',
  lastVerifiedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2025-12-01T00:00:00.000Z',
  updatedAt: '2025-12-01T00:00:00.000Z',
};

/**
 * Fetch mock for the "revisit/remount with an existing connection" scenarios
 * (b) and (c). Distinct from makeFetchMock() above since the initial GET
 * /api/connections here returns a non-empty list, and the per-connection GET
 * .../consent (never hit by the happy-path mock, since that flow starts from
 * zero connections) is the whole point of these tests. `hasValidConsent` lets
 * (b) and (c) share this one function while returning opposite consent
 * states.
 */
function makeExistingConnectionFetchMock(hasValidConsent: boolean) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url === '/api/connections' && method === 'GET') {
      return jsonResponse([EXISTING_CONNECTION]);
    }
    if (url === '/api/connections/conn-existing/consent' && method === 'GET') {
      return jsonResponse({
        has_valid_consent: hasValidConsent,
        current_version: 1,
        consented_version: hasValidConsent ? 1 : null,
        consented_at: hasValidConsent ? '2025-12-01T00:00:00.000Z' : null,
      });
    }
    if (url === '/api/disclosures/current' && method === 'GET') {
      return jsonResponse({ version: 1, content: 'Selling on Poshmark carries risk X, Y, Z.' });
    }

    throw new Error(`Unexpected fetch call in test: ${method} ${url}`);
  });
}

describe('ConnectionsView status list (revisit/remount) integration', () => {
  it('(b) shows an existing connection in the status list, alongside the connect cards, on a fresh mount', async () => {
    const fetchMock = makeExistingConnectionFetchMock(true);
    vi.stubGlobal('fetch', fetchMock);

    render(<ConnectionsView tenantId="tenant-1" />);

    // Status list renders once the initial GET /api/connections resolves
    // with a non-empty list -- no navigation needed, it's the default list
    // view (ConnectionsView renders ConnectCardGrid + StatusList together
    // whenever connections.length > 0).
    await waitFor(() => expect(screen.getByTestId('status-row-conn-existing')).toBeInTheDocument());

    // Connect cards render in the SAME view, not instead of the status list.
    expect(screen.getByTestId('connect-card-grid')).toBeInTheDocument();

    const badge = screen.getByTestId('status-badge-conn-existing');
    expect(badge).toHaveTextContent('active');

    // Consent fetch for this connection resolved with valid consent, so no
    // stale-consent indicator should render.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]) === '/api/connections/conn-existing/consent'),
      ).toBe(true),
    );
    expect(screen.queryByTestId('stale-consent-conn-existing')).not.toBeInTheDocument();
  });
});

describe('ConnectionsView stale-consent indicator integration', () => {
  it('(c) renders the distinct stale-consent indicator for an active-but-unconsented connection, with a path back into the consent flow', async () => {
    const fetchMock = makeExistingConnectionFetchMock(false);
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<ConnectionsView tenantId="tenant-1" />);

    await waitFor(() => expect(screen.getByTestId('status-row-conn-existing')).toBeInTheDocument());

    // has_valid_consent: false on an 'active' connection -> the distinct
    // stale-consent indicator (blue, informational styling per StatusRow's
    // convention -- never a green/yellow/red status color) with its "Finish
    // connecting" button.
    const staleIndicator = await screen.findByTestId('stale-consent-conn-existing');
    const finishButton = within(staleIndicator).getByRole('button', { name: 'Finish connecting' });

    // The underlying status badge is unaffected -- still shows 'active'.
    expect(screen.getByTestId('status-badge-conn-existing')).toHaveTextContent('active');

    await user.click(finishButton);

    // Clicking routes to the ConsentScreen for that connection's platform
    // (per ConnectionsView's known-limitation wiring: onResumeConsent ->
    // setFlow({ mode: 'consent', platform }), the same path as a fresh
    // reconnect). Assert only that the consent screen for 'poshmark'
    // becomes visible -- no submit, no assertion about what happens past
    // that (a 409 on create is a known, out-of-scope limitation here).
    await waitFor(() =>
      expect(screen.getByText('I understand and accept these risks')).toBeInTheDocument(),
    );
    expect(screen.getByText(/Selling on Poshmark carries risk/)).toBeInTheDocument();
  });
});
