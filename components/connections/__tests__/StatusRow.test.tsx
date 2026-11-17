// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import userEvent from '@testing-library/user-event';
import StatusRow from '../StatusRow';
import type { ConnectionMetadata } from '@/lib/connections';

// Without test.globals: true in vitest.config.ts, cleanup must be called
// manually after each test to avoid render state leaking between tests.
afterEach(cleanup);

afterEach(() => {
  vi.unstubAllGlobals();
});

function createMockConnection(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
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

function renderStatusRow(
  connection: ConnectionMetadata,
  props: Partial<ComponentProps<typeof StatusRow>> = {},
) {
  return render(
    createElement(StatusRow, {
      connection,
      hasValidConsent: true,
      operabilityTier: 'sandbox-tested',
      onReconnect: vi.fn(),
      onResumeConsent: vi.fn(),
      onStatusChange: vi.fn(),
      ...props,
    }),
  );
}

async function clickReactivate(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);

  const onStatusChange = vi.fn();
  renderStatusRow(createMockConnection({ status: 'suspended' }), { onStatusChange });

  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Reactivate' }));
  return onStatusChange;
}

function renderRow(conn: Partial<ConnectionMetadata>) {
  return render(
    <StatusRow
      connection={createMockConnection(conn)}
      hasValidConsent={true}
      operabilityTier="live"
      onReconnect={vi.fn()}
      onResumeConsent={vi.fn()}
      onStatusChange={vi.fn()}
    />,
  );
}

describe('StatusRow', () => {
  describe('badge color mapping', () => {
    it('renders green badge for active status', () => {
      const connection = createMockConnection({ status: 'active' });
      renderStatusRow(connection);

      const badge = screen.getByTestId('status-badge-conn-1');
      expect(badge).toHaveTextContent('active');
      expect(badge).toHaveClass('bg-emerald-100', 'text-emerald-800');
    });

    it('renders yellow badge for suspended status', () => {
      const connection = createMockConnection({ status: 'suspended' });
      renderStatusRow(connection);

      const badge = screen.getByTestId('status-badge-conn-1');
      expect(badge).toHaveTextContent('suspended');
      expect(badge).toHaveClass('bg-amber-100', 'text-amber-800');
    });
  });
});

describe('StatusRow', () => {
  describe('badge color mapping', () => {
    it('renders red badge for revoked status', () => {
      const connection = createMockConnection({ status: 'revoked' });
      renderStatusRow(connection);

      const badge = screen.getByTestId('status-badge-conn-1');
      expect(badge).toHaveTextContent('revoked');
      expect(badge).toHaveClass('bg-rose-100', 'text-rose-800');
    });
  });
});

describe('StatusRow', () => {
  describe('operability tier', () => {
    it('renders blue informational badge regardless of status', () => {
      const connection = createMockConnection({ status: 'active' });
      renderStatusRow(connection);

      const tierBadge = screen.getByTestId('operability-tier-conn-1');
      expect(tierBadge).toHaveTextContent('sandbox-tested');
      expect(tierBadge).toHaveClass('bg-sky-100', 'text-sky-800');
    });

    it('renders operability tier for suspended status', () => {
      const connection = createMockConnection({ status: 'suspended' });
      renderStatusRow(connection);

      const tierBadge = screen.getByTestId('operability-tier-conn-1');
      expect(tierBadge).toHaveTextContent('sandbox-tested');
      expect(tierBadge).toHaveClass('bg-sky-100', 'text-sky-800');
    });
  });
});

describe('StatusRow', () => {
  describe('operability tier', () => {
    it('renders operability tier for revoked status', () => {
      const connection = createMockConnection({ status: 'revoked' });
      renderStatusRow(connection);

      const tierBadge = screen.getByTestId('operability-tier-conn-1');
      expect(tierBadge).toHaveTextContent('sandbox-tested');
      expect(tierBadge).toHaveClass('bg-sky-100', 'text-sky-800');
    });
  });
});

describe('StatusRow', () => {
  describe('stale-consent indicator', () => {
    it('does not render when status is active and hasValidConsent is true', () => {
      const connection = createMockConnection({ status: 'active' });
      renderStatusRow(connection);

      expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
    });

    it('does not render when status is active and hasValidConsent is null', () => {
      const connection = createMockConnection({ status: 'active' });
      renderStatusRow(connection, { hasValidConsent: null });

      expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
    });
  });
});

describe('StatusRow', () => {
  describe('stale-consent indicator', () => {
    it('renders when status is active and hasValidConsent is false', () => {
      const connection = createMockConnection({ status: 'active' });
      renderStatusRow(connection, { hasValidConsent: false });

      const staleBanner = screen.getByTestId('stale-consent-conn-1');
      expect(staleBanner).toBeInTheDocument();
      expect(staleBanner).toHaveTextContent('Consent needed to resume automation.');
    });

    it('renders as distinct blue informational banner', () => {
      const connection = createMockConnection({ status: 'active' });
      renderStatusRow(connection, { hasValidConsent: false });

      const staleBanner = screen.getByTestId('stale-consent-conn-1');
      expect(staleBanner).toHaveClass('bg-sky-50', 'text-sky-800', 'border-sky-200');
    });
  });
});

describe('StatusRow', () => {
  describe('stale-consent indicator', () => {
    it('Finish connecting button calls onResumeConsent', async () => {
      const onResumeConsent = vi.fn();
      const connection = createMockConnection({ status: 'active' });
      renderStatusRow(connection, { hasValidConsent: false, onResumeConsent });

      const user = userEvent.setup();
      const finishButton = screen.getByRole('button', { name: 'Finish connecting' });
      await user.click(finishButton);

      expect(onResumeConsent).toHaveBeenCalledTimes(1);
    });

    it('does not render for suspended status even with hasValidConsent false', () => {
      const connection = createMockConnection({ status: 'suspended' });
      renderStatusRow(connection, { hasValidConsent: false });

      expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
    });
  });
});

describe('StatusRow', () => {
  describe('stale-consent indicator', () => {
    it('does not render for revoked status even with hasValidConsent false', () => {
      const connection = createMockConnection({ status: 'revoked' });
      renderStatusRow(connection, { hasValidConsent: false });

      expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
    });
  });
});

describe('StatusRow', () => {
  describe('reactivate (suspended status)', () => {
    it('renders Reactivate button when status is suspended', () => {
      const connection = createMockConnection({ status: 'suspended' });
      renderStatusRow(connection);

      expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    });

    it('calls POST /api/connections/{id}/reactivate when Reactivate is clicked', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
      await clickReactivate(fetchMock);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/api/connections/conn-1/reactivate', {
          method: 'POST',
        });
      });
    });
  });
});

describe('StatusRow', () => {
  describe('reactivate (suspended status)', () => {
    it('calls onStatusChange on successful reactivate', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
      const onStatusChange = await clickReactivate(fetchMock);

      await waitFor(() => {
        expect(onStatusChange).toHaveBeenCalledTimes(1);
      });
    });
  });
});

describe('StatusRow', () => {
  describe('reactivate (suspended status)', () => {
    it('surfaces 409 error inline without calling onStatusChange', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({}),
      });
      const onStatusChange = await clickReactivate(fetchMock);

      await waitFor(() => {
        const errorAlert = screen.getByTestId('reactivate-error-conn-1');
        expect(errorAlert).toBeInTheDocument();
        expect(errorAlert).toHaveAttribute('role', 'alert');
        expect(errorAlert).toHaveTextContent('already be active, or revoked');
      });

      expect(onStatusChange).not.toHaveBeenCalled();
    });
  });
});

describe('StatusRow', () => {
  describe('reactivate (suspended status)', () => {
    it('surfaces non-409 HTTP error inline without calling onStatusChange', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });
      const onStatusChange = await clickReactivate(fetchMock);

      await waitFor(() => {
        const errorAlert = screen.getByTestId('reactivate-error-conn-1');
        expect(errorAlert).toBeInTheDocument();
        expect(errorAlert).toHaveTextContent('HTTP 500');
      });

      expect(onStatusChange).not.toHaveBeenCalled();
    });
  });
});

describe('StatusRow', () => {
  describe('reactivate (suspended status)', () => {
    it('surfaces network error inline without calling onStatusChange', async () => {
      const fetchMock = vi.fn().mockRejectedValueOnce(new Error('Network error'));
      const onStatusChange = await clickReactivate(fetchMock);

      await waitFor(() => {
        const errorAlert = screen.getByTestId('reactivate-error-conn-1');
        expect(errorAlert).toBeInTheDocument();
        expect(errorAlert).toHaveTextContent('check your connection');
      });

      expect(onStatusChange).not.toHaveBeenCalled();
    });
  });
});

describe('StatusRow', () => {
  describe('reactivate (suspended status)', () => {
    it('disables Reactivate button while reactivating', async () => {
      let resolveFetch: ((v: Response) => void) | undefined;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(fetchPromise));

      const connection = createMockConnection({ status: 'suspended' });
      renderStatusRow(connection);

      const user = userEvent.setup();
      const button = screen.getByRole('button', { name: 'Reactivate' });
      expect(button).not.toBeDisabled();

      await user.click(button);

      expect(button).toBeDisabled();
      expect(button).toHaveTextContent('Reactivating…');

      resolveFetch?.({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      } as Response);

      await waitFor(() => {
        expect(button).not.toBeDisabled();
        expect(button).toHaveTextContent('Reactivate');
      });
    });
  });
});

describe('StatusRow', () => {
  describe('reactivate (suspended status)', () => {
    it('does not render Reactivate button for active status', () => {
      const connection = createMockConnection({ status: 'active' });
      renderStatusRow(connection);

      expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
    });

    it('does not render Reactivate button for revoked status', () => {
      const connection = createMockConnection({ status: 'revoked' });
      renderStatusRow(connection);

      expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
    });
  });
});

describe('StatusRow', () => {
  describe('revoked status', () => {
    it('renders Reconnect button when status is revoked', () => {
      const connection = createMockConnection({ status: 'revoked' });
      renderStatusRow(connection);

      expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    });

    it('calls onReconnect when Reconnect button is clicked', async () => {
      const onReconnect = vi.fn();
      const connection = createMockConnection({ status: 'revoked' });
      renderStatusRow(connection, { onReconnect });

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Reconnect' }));

      expect(onReconnect).toHaveBeenCalledTimes(1);
    });
  });
});

describe('StatusRow', () => {
  describe('revoked status', () => {
    it('does not render Reactivate button for revoked status', () => {
      const connection = createMockConnection({ status: 'revoked' });
      renderStatusRow(connection);

      expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
    });
  });
});

describe('StatusRow', () => {
  describe('integration scenarios', () => {
    it('renders all expected elements for active status with valid consent', () => {
      const connection = createMockConnection({
        status: 'active',
        platform: 'amazon',
      });
      renderStatusRow(connection, { operabilityTier: 'production-ready' });

      expect(screen.getByText('amazon')).toBeInTheDocument();
      expect(screen.getByTestId('status-badge-conn-1')).toHaveTextContent('active');
      expect(screen.getByTestId('operability-tier-conn-1')).toHaveTextContent('production-ready');
      expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
    });

    it('renders all expected elements for suspended status', () => {
      const connection = createMockConnection({
        status: 'suspended',
        platform: 'poshmark',
      });
      renderStatusRow(connection, { operabilityTier: 'beta-tested' });

      expect(screen.getByText('poshmark')).toBeInTheDocument();
      expect(screen.getByTestId('status-badge-conn-1')).toHaveTextContent('suspended');
      expect(screen.getByTestId('operability-tier-conn-1')).toHaveTextContent('beta-tested');
      expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    });
  });
});

describe('StatusRow', () => {
  describe('integration scenarios', () => {
    it('renders all expected elements for active status with stale consent', () => {
      const connection = createMockConnection({
        status: 'active',
        platform: 'mercari',
      });
      renderStatusRow(connection, { hasValidConsent: false });

      expect(screen.getByText('mercari')).toBeInTheDocument();
      expect(screen.getByTestId('status-badge-conn-1')).toHaveTextContent('active');
      expect(screen.getByTestId('operability-tier-conn-1')).toHaveTextContent('sandbox-tested');
      expect(screen.getByTestId('stale-consent-conn-1')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
    });
  });
});

describe('StatusRow', () => {
  describe('Etsy account link', () => {
    it('shows a Link Etsy account button on an active Etsy connection only', () => {
      renderRow({ platform: 'etsy' });
      expect(screen.getByRole('button', { name: 'Link Etsy account' })).toBeInTheDocument();
      cleanup();
      renderRow({ platform: 'ebay' });
      expect(screen.queryByRole('button', { name: 'Link Etsy account' })).toBeNull();
    });

    it('POSTs to the authorize route and sends the browser to the returned Etsy URL', async () => {
      const assign = vi.fn();
      vi.stubGlobal('location', { assign });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ authorizeUrl: 'https://www.etsy.com/oauth/connect?x=1' }),
      });
      vi.stubGlobal('fetch', fetchMock);
      renderRow({ id: 'conn-9', platform: 'etsy' });

      await userEvent.click(screen.getByRole('button', { name: 'Link Etsy account' }));

      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith('https://www.etsy.com/oauth/connect?x=1'),
      );
      expect(fetchMock).toHaveBeenCalledWith('/api/connections/conn-9/etsy/authorize', {
        method: 'POST',
      });
    });

    it('tells the user when Etsy is not configured', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ error: 'connector_not_configured' }),
        }),
      );
      renderRow({ id: 'conn-9', platform: 'etsy' });

      await userEvent.click(screen.getByRole('button', { name: 'Link Etsy account' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/not set up/i);
    });
  });
});
