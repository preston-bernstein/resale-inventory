// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmptyState from '@/components/connections/EmptyState';
import ConnectCard from '@/components/connections/ConnectCard';
import ConnectCardGrid from '@/components/connections/ConnectCardGrid';
import type { ConnectionMetadata } from '@/lib/connections';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers -- without this, each test's
// render stays mounted and later queries see duplicate content (matches the
// convention established in ConnectionsView.test.tsx).
afterEach(cleanup);

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

describe('EmptyState', () => {
  it('renders a single CTA and nothing else that looks like a card grid', () => {
    render(<EmptyState onExpand={() => {}} />);

    expect(screen.getByTestId('connections-empty-state')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect a marketplace/i })).toBeInTheDocument();
    expect(screen.queryByTestId('connect-card-grid')).not.toBeInTheDocument();
  });

  it('calls onExpand when the CTA is clicked', async () => {
    const user = userEvent.setup();
    const onExpand = vi.fn();
    render(<EmptyState onExpand={onExpand} />);

    await user.click(screen.getByRole('button', { name: /connect a marketplace/i }));

    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectCard', () => {
  it.each(['active', 'suspended'] as const)('is disabled and inert when status is %s', (status) => {
    const onSelect = vi.fn();
    render(
      <ConnectCard platform="ebay" tier="oauth" connection={makeConnection({ status })} onSelect={onSelect} />,
    );

    expect(screen.queryByRole('button', { name: /connect/i })).not.toBeInTheDocument();
  });

  it('is enabled when there is no connection', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ConnectCard platform="etsy" tier="oauth" connection={undefined} onSelect={onSelect} />);

    const button = screen.getByRole('button', { name: /connect/i });
    expect(button).not.toBeDisabled();

    await user.click(button);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('is enabled when status is revoked, and clicking calls onSelect', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ConnectCard
        platform="poshmark"
        tier="credential"
        connection={makeConnection({ platform: 'poshmark', status: 'revoked' })}
        onSelect={onSelect}
      />,
    );

    const button = screen.getByRole('button', { name: /connect/i });
    expect(button).not.toBeDisabled();

    await user.click(button);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('shows "Not connected" when there is no connection', () => {
    render(<ConnectCard platform="depop" tier="credential" connection={undefined} onSelect={() => {}} />);

    expect(screen.getByTestId('connect-card-status-depop')).toHaveTextContent('Not connected');
  });

  it('shows the current status when a connection exists', () => {
    render(
      <ConnectCard
        platform="mercari"
        tier="credential"
        connection={makeConnection({ platform: 'mercari', status: 'suspended' })}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByTestId('connect-card-status-mercari')).toHaveTextContent(/suspended/i);
  });
});

describe('ConnectCardGrid', () => {
  it('renders exactly 8 cards split into an OAuth group of 3 and a Credential group of 5', () => {
    render(<ConnectCardGrid connections={[]} onSelectPlatform={() => {}} />);

    const oauthPlatforms = ['ebay', 'etsy', 'amazon'];
    const credentialPlatforms = ['poshmark', 'depop', 'mercari', 'vinted', 'grailed'];

    for (const platform of [...oauthPlatforms, ...credentialPlatforms]) {
      expect(screen.getByTestId(`connect-card-${platform}`)).toBeInTheDocument();
    }

    const grid = screen.getByTestId('connect-card-grid');
    expect(within(grid).getAllByRole('button', { name: /connect/i })).toHaveLength(8);
  });

  it('passes each platform its matching connection (found by platform) so disabled state is per-card', () => {
    const connections: ConnectionMetadata[] = [
      makeConnection({ id: 'c1', platform: 'ebay', status: 'active' }),
      makeConnection({ id: 'c2', platform: 'poshmark', status: 'revoked' }),
    ];

    render(<ConnectCardGrid connections={connections} onSelectPlatform={() => {}} />);

    const ebayCard = screen.getByTestId('connect-card-ebay');
    expect(within(ebayCard).queryByRole('button', { name: /connect/i })).not.toBeInTheDocument();

    const poshmarkCard = screen.getByTestId('connect-card-poshmark');
    expect(within(poshmarkCard).getByRole('button', { name: /connect/i })).toBeInTheDocument();

    const etsyCard = screen.getByTestId('connect-card-etsy');
    expect(within(etsyCard).getByRole('button', { name: /connect/i })).toBeInTheDocument();
  });

  it('calls onSelectPlatform with the clicked platform', async () => {
    const user = userEvent.setup();
    const onSelectPlatform = vi.fn();
    render(<ConnectCardGrid connections={[]} onSelectPlatform={onSelectPlatform} />);

    const grailedCard = screen.getByTestId('connect-card-grailed');
    await user.click(within(grailedCard).getByRole('button', { name: /connect/i }));

    expect(onSelectPlatform).toHaveBeenCalledWith('grailed');
  });
});
