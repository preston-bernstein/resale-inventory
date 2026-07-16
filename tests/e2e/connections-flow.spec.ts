import { test, expect } from '@playwright/test';
import { uniqueSuffix } from './helpers';

// ---------------------------------------------------------------------------
// SAFETY + WIRING (Task 14b, suspended-reactivate branch below): this spec
// file runs in a separate Node process from the webServer (`next dev`) that
// playwright.config.ts boots. To drive the Reactivate UI we need to put a
// connection into 'suspended' state directly via lib/connections.ts's
// recordSuspensionSignal -- there is no UI/API path a tenant can trigger that
// transition through (it's a backend kill-switch signal, normally fired by
// connector code). Doing that from THIS process means this process needs its
// own @/lib/db connection pointed at the exact same scratch SQLite file the
// webServer uses (path.resolve(repoRoot, '.playwright-scratch/inventory.db')
// -- see playwright.config.ts's `e2eDbPath`). Both @/lib/db and
// @/lib/connections read BOOKSELLER_DB_PATH as a load-time side effect
// (lib/db.ts's module-level `new Database(dbPath)` call), so the env var
// must be set before either module is ever evaluated.
//
// This can't be done with a plain top-of-file `import` for @/lib/db /
// @/lib/connections placed textually after the assignment below --
// Playwright's TS pipeline transforms via Babel
// (@babel/plugin-transform-modules-commonjs), which hoists every `import`
// declaration's compiled `require(...)` to the top of the file, executing
// before ANY of the file's own top-level statements, regardless of source
// position (verified directly against this repo's own bundled @babel/core).
// A literal `require(...)` call, by contrast, is not hoisted -- it executes
// exactly where it's written. So the env var is set via a plain `require`
// (not `import`) for 'path', and @/lib/db + @/lib/connections are pulled in
// below via plain `require()` calls too, deliberately, after this line.
// eslint-disable-next-line @typescript-eslint/no-require-imports
process.env.BOOKSELLER_DB_PATH = require('path').resolve(__dirname, '../../.playwright-scratch/inventory.db');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const db = (require('@/lib/db') as typeof import('@/lib/db')).default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { recordSuspensionSignal } = require('@/lib/connections') as typeof import('@/lib/connections');

// ---------------------------------------------------------------------------
// Connections flow — happy path (Task 14a).
//
// Drives the full credential-tier connect flow against the real running app
// + scratch DB: connect card -> consent -> credential -> masked confirmation
// -> first-win panel. Uses Depop, a "dry-run-until-credentialed" platform
// (README.md's Marketplace Connectors table) — its connector accepts fake
// credentials and runs in a safe dry-run mode without hitting a real
// marketplace, so this test never needs real env credentials.
//
// This suite runs fullyParallel: false, one worker, sharing one server/DB
// (and, since Task 22, one E2E tenant) across every spec file — tests run
// sequentially. Another spec file (or a prior run within this same file)
// may have already connected other platforms by the time this test runs, so
// this test does NOT assert the page-level empty state (ConnectionsView only
// renders EmptyState when `connections.length === 0 && !cardsExpanded` --
// any pre-existing connection skips straight to the card grid). Instead it
// waits for either the empty-state CTA or the Depop card itself, clicking
// the CTA only if the empty state is what rendered, then drives everything
// else off the Depop-specific testids, which are robust regardless of what
// else is connected.
// ---------------------------------------------------------------------------

test.describe('Connections flow — happy path', () => {
  test('connect Depop end-to-end: consent -> credential -> masked confirmation -> first-win panel', async ({ page }) => {
    const identifier = `e2e-depop-${uniqueSuffix()}`;
    const password = 'e2e-fake-password-not-real';

    await page.goto('/connections');

    const emptyStateButton = page.getByRole('button', { name: 'Connect a marketplace' });
    const depopCard = page.getByTestId('connect-card-depop');

    await test.step('reach the Depop connect card regardless of prior connection state', async () => {
      // Either the empty state (no connections at all yet) or the card grid
      // (some connections already exist) renders once the initial fetch
      // resolves -- wait for whichever one shows up.
      await expect(emptyStateButton.or(depopCard)).toBeVisible();

      if (await emptyStateButton.isVisible()) {
        await emptyStateButton.click();
      }

      await expect(depopCard).toBeVisible();
    });

    await test.step('click Depop\'s Connect button to enter the consent screen', async () => {
      await depopCard.getByRole('button', { name: 'Connect' }).click();
    });

    await test.step('consent screen renders with disclosure text, unchecked checkbox, disabled Continue', async () => {
      const checkbox = page.getByRole('checkbox', { name: 'I understand and accept these risks' });
      const continueButton = page.getByRole('button', { name: 'I understand, continue' });

      await expect(checkbox).toBeVisible();
      await expect(checkbox).not.toBeChecked();
      await expect(continueButton).toBeDisabled();

      // Disclosure content itself is visible (loaded from /api/disclosures/current).
      await expect(page.getByText(/Disclosure v\d+/)).toBeVisible();
    });

    await test.step('checking the box enables Continue; clicking it proceeds to the credential form', async () => {
      const checkbox = page.getByRole('checkbox', { name: 'I understand and accept these risks' });
      const continueButton = page.getByRole('button', { name: 'I understand, continue' });

      await checkbox.check();
      await expect(continueButton).toBeEnabled();
      await continueButton.click();
    });

    await test.step('credential form renders Depop\'s identifier + secret fields', async () => {
      await expect(page.getByLabel('Depop username')).toBeVisible();
      await expect(page.getByLabel('Password')).toBeVisible();
    });

    await test.step('fill fake credentials and submit', async () => {
      await page.getByLabel('Depop username').fill(identifier);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
    });

    await test.step('confirmation view renders with a masked identifier, never the raw fake one', async () => {
      const confirmation = page.getByTestId('connection-confirmation');
      await expect(confirmation).toBeVisible();
      await expect(confirmation).toContainText('Depop connected as @');

      const confirmationText = await confirmation.textContent();
      expect(confirmationText).not.toContain(identifier);
    });

    await test.step('first-win panel renders past the skeleton with health + readiness content', async () => {
      const panel = page.getByTestId('first-win-panel');
      await expect(page.getByTestId('first-win-skeleton')).toHaveCount(0);
      await expect(panel).toBeVisible();
      await expect(page.getByTestId('first-win-health')).toBeVisible();
      await expect(page.getByTestId('first-win-ready-count')).toBeVisible();
    });
  });
});

// ---------------------------------------------------------------------------
// Connections flow — suspended reactivate (Task 14b).
//
// Suspension itself (FR22/FR23) has no tenant-facing trigger -- it's a
// backend kill-switch connector code calls the moment a platform reports a
// ban signal, not something a UI/API action can drive. To exercise the
// Reactivate UI (FR28) this test connects Mercari through the real UI flow
// (mirroring Task 14a's Depop flow, but a different platform so it never
// collides with Task 14a's Depop connection), then reaches past the UI --
// straight into the same scratch SQLite DB the webServer is using -- to call
// recordSuspensionSignal() directly, exactly like the real connector code
// would. Only the suspend step bypasses the UI; the reactivate step is
// driven entirely through the browser, which is the actual thing this test
// verifies.
// ---------------------------------------------------------------------------

test.describe('Connections flow — suspended reactivate', () => {
  test('a suspended Mercari connection shows Reactivate; clicking it transitions to active', async ({
    page,
  }) => {
    const identifier = `e2e-mercari-${uniqueSuffix()}`;
    const password = 'e2e-fake-password-not-real';

    await page.goto('/connections');

    const emptyStateButton = page.getByRole('button', { name: 'Connect a marketplace' });
    const mercariCard = page.getByTestId('connect-card-mercari');

    await test.step('connect Mercari end-to-end via the UI, same step pattern as the Depop flow', async () => {
      await expect(emptyStateButton.or(mercariCard)).toBeVisible();

      if (await emptyStateButton.isVisible()) {
        await emptyStateButton.click();
      }

      await expect(mercariCard).toBeVisible();
      await mercariCard.getByRole('button', { name: 'Connect' }).click();

      const checkbox = page.getByRole('checkbox', { name: 'I understand and accept these risks' });
      const continueButton = page.getByRole('button', { name: 'I understand, continue' });
      await expect(checkbox).toBeVisible();
      await checkbox.check();
      await expect(continueButton).toBeEnabled();
      await continueButton.click();

      await expect(page.getByLabel('Mercari username')).toBeVisible();
      await expect(page.getByLabel('Password')).toBeVisible();
      await page.getByLabel('Mercari username').fill(identifier);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();

      const confirmation = page.getByTestId('connection-confirmation');
      await expect(confirmation).toBeVisible();
      await expect(confirmation).toContainText('Mercari connected as @');
    });

    let connectionId = '';
    let tenantId = '';

    await test.step('look up the newly-created Mercari connection directly in the scratch DB', async () => {
      const row = db
        .prepare(
          `SELECT id, tenant_id FROM platform_connections
           WHERE platform = 'mercari' ORDER BY created_at DESC LIMIT 1`,
        )
        .get() as { id: string; tenant_id: string } | undefined;

      expect(row, 'expected the Mercari connection just created via the UI to exist in the DB').toBeTruthy();
      connectionId = row!.id;
      tenantId = row!.tenant_id;
    });

    await test.step('suspend it directly (bypassing the UI -- there is no tenant-facing suspend action)', async () => {
      recordSuspensionSignal(tenantId, connectionId, 'e2e-test-suspension', 'suspended');
    });

    await test.step('reload so the UI re-fetches the connection list and shows the suspended status', async () => {
      await page.goto('/connections');

      const statusRow = page.getByTestId(`status-row-${connectionId}`);
      const statusBadge = page.getByTestId(`status-badge-${connectionId}`);

      await expect(statusRow).toBeVisible();
      await expect(statusBadge).toHaveText('suspended');
      await expect(statusBadge).toHaveClass(/bg-amber-100/);
      await expect(statusRow.getByRole('button', { name: 'Reactivate' })).toBeVisible();
    });

    await test.step('click Reactivate; the badge flips to active without a full page reload', async () => {
      const statusRow = page.getByTestId(`status-row-${connectionId}`);
      const statusBadge = page.getByTestId(`status-badge-${connectionId}`);

      await statusRow.getByRole('button', { name: 'Reactivate' }).click();

      await expect(statusBadge).toHaveText('active');
      await expect(statusBadge).toHaveClass(/bg-emerald-100/);
      await expect(statusRow.getByRole('button', { name: 'Reactivate' })).toHaveCount(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Connections flow — revoked reconnect (Task 14c).
//
// Like suspension, revocation itself has no tenant-facing trigger -- it's a
// backend kill-switch signal (recordSuspensionSignal with toStatus 'revoked'),
// not something a UI/API action can drive. To exercise the Reconnect UI this
// test connects Vinted through the real UI flow (mirroring Tasks 14a/14b, but
// a third platform so it never collides with their Depop/Mercari
// connections), then reaches past the UI -- straight into the same scratch
// SQLite DB the webServer is using -- to call recordSuspensionSignal()
// directly with toStatus 'revoked'. From there, the reconnect step is driven
// entirely through the browser: clicking "Reconnect" routes to the same
// consent screen a fresh connect would, and completing that flow again must
// hit POST /api/connections's documented delete-then-recreate behavior for a
// revoked platform -- the old revoked row is deleted and a brand-new row (new
// id, status 'active') is created. This test's core assertion is that the
// post-reconnect row's id differs from the original revoked connection's id.
// ---------------------------------------------------------------------------

test.describe('Connections flow — revoked reconnect', () => {
  test('a revoked Vinted connection shows Reconnect; completing it creates a new connection with a new id', async ({
    page,
  }) => {
    const identifier = `e2e-vinted-${uniqueSuffix()}`;
    const password = 'e2e-fake-password-not-real';

    await page.goto('/connections');

    const emptyStateButton = page.getByRole('button', { name: 'Connect a marketplace' });
    const vintedCard = page.getByTestId('connect-card-vinted');

    await test.step('connect Vinted end-to-end via the UI, same step pattern as the Depop/Mercari flows', async () => {
      await expect(emptyStateButton.or(vintedCard)).toBeVisible();

      if (await emptyStateButton.isVisible()) {
        await emptyStateButton.click();
      }

      await expect(vintedCard).toBeVisible();
      await vintedCard.getByRole('button', { name: 'Connect' }).click();

      const checkbox = page.getByRole('checkbox', { name: 'I understand and accept these risks' });
      const continueButton = page.getByRole('button', { name: 'I understand, continue' });
      await expect(checkbox).toBeVisible();
      await checkbox.check();
      await expect(continueButton).toBeEnabled();
      await continueButton.click();

      await expect(page.getByLabel('Vinted username')).toBeVisible();
      await expect(page.getByLabel('Password')).toBeVisible();
      await page.getByLabel('Vinted username').fill(identifier);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();

      const confirmation = page.getByTestId('connection-confirmation');
      await expect(confirmation).toBeVisible();
      await expect(confirmation).toContainText('Vinted connected as @');
    });

    let originalConnectionId = '';
    let tenantId = '';

    await test.step('look up the newly-created Vinted connection directly in the scratch DB', async () => {
      const row = db
        .prepare(
          `SELECT id, tenant_id FROM platform_connections
           WHERE platform = 'vinted' ORDER BY created_at DESC LIMIT 1`,
        )
        .get() as { id: string; tenant_id: string } | undefined;

      expect(row, 'expected the Vinted connection just created via the UI to exist in the DB').toBeTruthy();
      originalConnectionId = row!.id;
      tenantId = row!.tenant_id;
    });

    await test.step('revoke it directly (bypassing the UI -- there is no tenant-facing revoke action)', async () => {
      recordSuspensionSignal(tenantId, originalConnectionId, 'e2e-test-revocation', 'revoked');
    });

    await test.step('reload so the UI re-fetches the connection list and shows the revoked status', async () => {
      await page.goto('/connections');

      const statusRow = page.getByTestId(`status-row-${originalConnectionId}`);
      const statusBadge = page.getByTestId(`status-badge-${originalConnectionId}`);

      await expect(statusRow).toBeVisible();
      await expect(statusBadge).toHaveText('revoked');
      await expect(statusBadge).toHaveClass(/bg-rose-100/);
      await expect(statusRow.getByRole('button', { name: 'Reconnect' })).toBeVisible();
      await expect(statusRow.getByRole('button', { name: 'Reactivate' })).toHaveCount(0);
    });

    await test.step('click Reconnect; it routes to the consent screen for Vinted', async () => {
      const statusRow = page.getByTestId(`status-row-${originalConnectionId}`);
      await statusRow.getByRole('button', { name: 'Reconnect' }).click();

      const checkbox = page.getByRole('checkbox', { name: 'I understand and accept these risks' });
      const continueButton = page.getByRole('button', { name: 'I understand, continue' });
      await expect(checkbox).toBeVisible();
      await expect(checkbox).not.toBeChecked();
      await expect(continueButton).toBeDisabled();
    });

    await test.step('complete the consent + credential flow again with new fake credentials', async () => {
      const reconnectedIdentifier = `${identifier}-reconnected`;
      const reconnectedPassword = `${password}-reconnected`;

      const checkbox = page.getByRole('checkbox', { name: 'I understand and accept these risks' });
      const continueButton = page.getByRole('button', { name: 'I understand, continue' });
      await checkbox.check();
      await expect(continueButton).toBeEnabled();
      await continueButton.click();

      await expect(page.getByLabel('Vinted username')).toBeVisible();
      await expect(page.getByLabel('Password')).toBeVisible();
      await page.getByLabel('Vinted username').fill(reconnectedIdentifier);
      await page.getByLabel('Password').fill(reconnectedPassword);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();

      const confirmation = page.getByTestId('connection-confirmation');
      await expect(confirmation).toBeVisible();
      await expect(confirmation).toContainText('Vinted connected as @');
    });

    await test.step('the reconnected row in the DB has a NEW id (old revoked row deleted, new one created) and is active', async () => {
      const row = db
        .prepare(
          `SELECT id, status FROM platform_connections
           WHERE platform = 'vinted' ORDER BY created_at DESC LIMIT 1`,
        )
        .get() as { id: string; status: string } | undefined;

      expect(row, 'expected the reconnected Vinted connection to exist in the DB').toBeTruthy();
      expect(row!.id).not.toBe(originalConnectionId);
      expect(row!.status).toBe('active');
    });
  });
});
