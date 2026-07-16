// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import ConnectionsView from '@/components/connections/ConnectionsView';
import type { ConnectionMetadata } from '@/lib/connections';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers -- without this, each test's
// render stays mounted and later queries see duplicate content.
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

describe('ConnectionsView', () => {
  it('renders without error and starts in list mode showing the empty state', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse([] as ConnectionMetadata[])));

    render(<ConnectionsView tenantId="tenant-1" />);

    // No connections + cardsExpanded still false (initial state) -> EmptyState
    // renders inside the 'list' mode wrapper, not the card grid/status list.
    const listNode = screen.getByTestId('flow-list');
    expect(listNode).toBeInTheDocument();
    expect(screen.getByTestId('connections-empty-state')).toBeInTheDocument();
  });

  it('calls GET /api/connections on mount', () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([] as ConnectionMetadata[]));
    vi.stubGlobal('fetch', fetchMock);

    render(<ConnectionsView tenantId="tenant-1" />);

    expect(fetchMock).toHaveBeenCalledWith('/api/connections');
  });

  it('populates connections state once the fetch resolves', async () => {
    const connections: ConnectionMetadata[] = [
      {
        id: 'conn-1',
        platform: 'ebay',
        status: 'active',
        lastVerifiedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    // StatusList fires an additional per-connection consent fetch once
    // connections are non-empty; only the first (list) call matters here so
    // let subsequent calls fall through to the mock's default (undefined)
    // resolution, which StatusList already handles via its own try/catch.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(connections)));

    render(<ConnectionsView tenantId="tenant-1" />);

    // Non-empty connections -> real ConnectCardGrid + StatusList render
    // instead of EmptyState.
    await waitFor(() => expect(screen.getByTestId('connect-card-grid')).toBeInTheDocument());
    expect(screen.getByTestId('status-list')).toBeInTheDocument();
    expect(screen.queryByTestId('connections-empty-state')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, false, 500)));

    render(<ConnectionsView tenantId="tenant-1" />);

    expect(await screen.findByText('HTTP 500')).toBeInTheDocument();
  });
});
