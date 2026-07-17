// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StatusList from '@/components/connections/StatusList';
import type { ConnectionMetadata } from '@/lib/connections';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers -- without this, each test's
// render stays mounted and later queries see duplicate content (same
// pattern as ConnectionsView.test.tsx).
afterEach(cleanup);

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function makeConnection(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  return {
    id: 'conn-1',
    platform: 'ebay',
    status: 'active',
    lastVerifiedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Consent fetches always resolve immediately with has_valid_consent: true
// unless a test overrides the mock -- keeps the "no stale-consent banner"
// case simple while still letting individual tests stub a false/consent-
// needed response.
function stubFetch(consentByConnectionId: Record<string, boolean> = {}, reactivateImpl?: () => Response) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/consent')) {
      const id = url.split('/')[3];
      return Promise.resolve(jsonResponse({ has_valid_consent: consentByConnectionId[id] ?? true }));
    }
    if (typeof url === 'string' && url.includes('/reactivate') && init?.method === 'POST') {
      return Promise.resolve(reactivateImpl ? reactivateImpl() : jsonResponse({}));
    }
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('StatusList', () => {
  it('renders one StatusRow per connection with the right status badge color classes', async () => {
    stubFetch();
    const connections = [
      makeConnection({ id: 'conn-active', status: 'active' }),
      makeConnection({ id: 'conn-suspended', status: 'suspended', platform: 'etsy' }),
      makeConnection({ id: 'conn-revoked', status: 'revoked', platform: 'amazon' }),
    ];

    render(
      <StatusList connections={connections} onReconnect={() => {}} onResumeConsent={() => {}} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status-row-conn-active')).toBeInTheDocument();
      expect(screen.getByTestId('status-row-conn-suspended')).toBeInTheDocument();
      expect(screen.getByTestId('status-row-conn-revoked')).toBeInTheDocument();
    });

    expect(screen.getByTestId('status-badge-conn-active').className).toMatch(/emerald/);
    expect(screen.getByTestId('status-badge-conn-suspended').className).toMatch(/amber/);
    expect(screen.getByTestId('status-badge-conn-revoked').className).toMatch(/rose/);
  });

  it('shows operability tier as blue informational text for every row', async () => {
    stubFetch();
    const connections = [makeConnection({ id: 'conn-1', platform: 'ebay', status: 'active' })];

    render(
      <StatusList connections={connections} onReconnect={() => {}} onResumeConsent={() => {}} />,
    );

    await waitFor(() => {
      const tierNode = screen.getByTestId('operability-tier-conn-1');
      expect(tierNode.className).toMatch(/sky/);
      expect(tierNode).toHaveTextContent('sandbox-tested');
    });
  });

  it('fetches GET /api/connections/:id/consent for each connection on mount', () => {
    const fetchMock = stubFetch();
    const connections = [
      makeConnection({ id: 'conn-a' }),
      makeConnection({ id: 'conn-b', platform: 'etsy' }),
    ];

    render(
      <StatusList connections={connections} onReconnect={() => {}} onResumeConsent={() => {}} />,
    );

    expect(fetchMock).toHaveBeenCalledWith('/api/connections/conn-a/consent');
    expect(fetchMock).toHaveBeenCalledWith('/api/connections/conn-b/consent');
  });

  it('renders a distinct blue stale-consent indicator when active but has_valid_consent is false, with a path back into consent', async () => {
    stubFetch({ 'conn-1': false });
    const onResumeConsent = vi.fn();
    const connections = [makeConnection({ id: 'conn-1', platform: 'ebay', status: 'active' })];

    render(
      <StatusList
        connections={connections}
        onReconnect={() => {}}
        onResumeConsent={onResumeConsent}
      />,
    );

    const banner = await screen.findByTestId('stale-consent-conn-1');
    expect(banner.className).toMatch(/sky/);

    await userEvent.click(screen.getByRole('button', { name: /finish connecting/i }));
    expect(onResumeConsent).toHaveBeenCalledWith('conn-1', 'ebay');
  });

  it('does not render the stale-consent indicator once consent is valid', async () => {
    stubFetch({ 'conn-1': true });
    const connections = [makeConnection({ id: 'conn-1', status: 'active' })];

    render(
      <StatusList connections={connections} onReconnect={() => {}} onResumeConsent={() => {}} />,
    );

    await waitFor(() => expect(screen.getByTestId('status-row-conn-1')).toBeInTheDocument());
    expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
  });

  it('calls onReconnect with the platform when a revoked row reconnects', async () => {
    stubFetch();
    const onReconnect = vi.fn();
    const connections = [makeConnection({ id: 'conn-1', platform: 'amazon', status: 'revoked' })];

    render(
      <StatusList connections={connections} onReconnect={onReconnect} onResumeConsent={() => {}} />,
    );

    await userEvent.click(await screen.findByRole('button', { name: /reconnect/i }));
    expect(onReconnect).toHaveBeenCalledWith('amazon');
  });

  it('reactivates a suspended row and calls onStatusChange on success', async () => {
    stubFetch();
    const onStatusChange = vi.fn();
    const connections = [makeConnection({ id: 'conn-1', platform: 'ebay', status: 'suspended' })];

    render(
      <StatusList
        connections={connections}
        onReconnect={() => {}}
        onResumeConsent={() => {}}
        onStatusChange={onStatusChange}
      />,
    );

    await userEvent.click(await screen.findByRole('button', { name: /^reactivate$/i }));

    await waitFor(() => expect(onStatusChange).toHaveBeenCalled());
  });

  it('surfaces a 409 reactivate conflict inline instead of failing silently', async () => {
    stubFetch({}, () => jsonResponse({ error: 'not_suspended' }, false, 409));
    const onStatusChange = vi.fn();
    const connections = [makeConnection({ id: 'conn-1', platform: 'ebay', status: 'suspended' })];

    render(
      <StatusList
        connections={connections}
        onReconnect={() => {}}
        onResumeConsent={() => {}}
        onStatusChange={onStatusChange}
      />,
    );

    await userEvent.click(await screen.findByRole('button', { name: /^reactivate$/i }));

    const errorNode = await screen.findByTestId('reactivate-error-conn-1');
    expect(errorNode).toBeInTheDocument();
    expect(onStatusChange).not.toHaveBeenCalled();
  });
});
