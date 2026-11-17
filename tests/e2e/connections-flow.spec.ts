import { test, expect, type Page } from '@playwright/test';
// Must stay the first import: it sets BOOKSELLER_DB_PATH before @/lib/db loads.
import './scratchDbEnv';
import db from '@/lib/db';
import { recordSuspensionSignal } from '@/lib/connections';
import { uniqueSuffix } from './itemFlows';

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
// else off the Depop-specific testids, which stay reliable regardless of what
// else is connected.
// ---------------------------------------------------------------------------

const FAKE_PASSWORD = 'e2e-fake-password-not-real';

type PlatformLabel = { slug: string; label: string };

const consentCheckbox = (page: Page) =>
  page.getByRole('checkbox', { name: 'I understand and accept these risks' });
const consentContinueButton = (page: Page) => page.getByRole('button', { name: 'I understand, continue' });

/**
 * Opens /connections and reaches the platform's connect card, then clicks its
 * Connect button. Either the empty state (no connections at all yet) or the
 * card grid (some connections already exist) renders once the initial fetch
 * resolves -- wait for whichever one shows up.
 */
async function openConsentFor(page: Page, platform: PlatformLabel): Promise<void> {
  await page.goto('/connections');

  const emptyStateButton = page.getByRole('button', { name: 'Connect a marketplace' });
  const card = page.getByTestId(`connect-card-${platform.slug}`);

  await expect(emptyStateButton.or(card)).toBeVisible();
  if (await emptyStateButton.isVisible()) {
    await emptyStateButton.click();
  }
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Connect' }).click();
}

/** Ticks the consent checkbox and continues to the credential form. */
async function acceptConsent(page: Page): Promise<void> {
  await consentCheckbox(page).check();
  await expect(consentContinueButton(page)).toBeEnabled();
  await consentContinueButton(page).click();
}

/** Fills the credential form for `platform` and submits it. */
async function submitCredentials(
  page: Page,
  platform: PlatformLabel,
  credentials: { identifier: string; password: string },
): Promise<void> {
  await expect(page.getByLabel(`${platform.label} username`)).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await page.getByLabel(`${platform.label} username`).fill(credentials.identifier);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
}

async function expectConfirmation(page: Page, platform: PlatformLabel): Promise<void> {
  const confirmation = page.getByTestId('connection-confirmation');
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText(`${platform.label} connected as @`);
}

/** Connects `platform` end-to-end through the real UI with fake credentials. */
async function connectViaUi(page: Page, platform: PlatformLabel, identifier: string): Promise<void> {
  await openConsentFor(page, platform);
  await expect(consentCheckbox(page)).toBeVisible();
  await acceptConsent(page);
  await submitCredentials(page, platform, { identifier, password: FAKE_PASSWORD });
  await expectConfirmation(page, platform);
}

/** Reloads /connections and checks the row's badge text and color class. Returns the row locator. */
async function expectStatusRow(page: Page, connectionId: string, status: string, badgeClass: RegExp) {
  await page.goto('/connections');

  const statusRow = page.getByTestId(`status-row-${connectionId}`);
  const statusBadge = page.getByTestId(`status-badge-${connectionId}`);

  await expect(statusRow).toBeVisible();
  await expect(statusBadge).toHaveText(status);
  await expect(statusBadge).toHaveClass(badgeClass);
  return statusRow;
}

/** The newest platform_connections row for `platform`, read straight from the scratch DB. */
function latestConnection(platform: string): { id: string; tenant_id: string; status: string } {
  const row = db
    .prepare(
      `SELECT id, tenant_id, status FROM platform_connections
       WHERE platform = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(platform) as { id: string; tenant_id: string; status: string } | undefined;

  expect(row, `expected a ${platform} connection to exist in the DB`).toBeTruthy();
  return row!;
}

const DEPOP: PlatformLabel = { slug: 'depop', label: 'Depop' };

test.describe('Connections flow — happy path', () => {
  test('connect Depop end-to-end: consent -> credential -> masked confirmation -> first-win panel', async ({ page }) => {
    const identifier = `e2e-depop-${uniqueSuffix()}`;

    await test.step('reach the Depop connect card regardless of prior connection state, then enter the consent screen', () =>
      openConsentFor(page, DEPOP));

    await test.step('consent screen renders with disclosure text, unchecked checkbox, disabled Continue', async () => {
      await expect(consentCheckbox(page)).toBeVisible();
      await expect(consentCheckbox(page)).not.toBeChecked();
      await expect(consentContinueButton(page)).toBeDisabled();

      // Disclosure content itself is visible (loaded from /api/disclosures/current).
      await expect(page.getByText(/Disclosure v\d+/)).toBeVisible();
    });

    await test.step('checking the box enables Continue; clicking it proceeds to the credential form', () =>
      acceptConsent(page));

    await test.step('credential form renders Depop\'s identifier + secret fields', async () => {
      await expect(page.getByLabel('Depop username')).toBeVisible();
      await expect(page.getByLabel('Password')).toBeVisible();
    });

    await test.step('fill fake credentials and submit', () =>
      submitCredentials(page, DEPOP, { identifier, password: FAKE_PASSWORD }));

    await test.step('confirmation view renders with a masked identifier, never the raw fake one', async () => {
      await expectConfirmation(page, DEPOP);
      const confirmationText = await page.getByTestId('connection-confirmation').textContent();
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

const MERCARI: PlatformLabel = { slug: 'mercari', label: 'Mercari' };

test.describe('Connections flow — suspended reactivate', () => {
  test('a suspended Mercari connection shows Reactivate; clicking it transitions to active', async ({
    page,
  }) => {
    await test.step('connect Mercari end-to-end via the UI, same step pattern as the Depop flow', () =>
      connectViaUi(page, MERCARI, `e2e-mercari-${uniqueSuffix()}`));

    let connectionId = '';

    await test.step('look up the newly-created Mercari connection directly in the scratch DB', async () => {
      connectionId = latestConnection('mercari').id;
    });

    await test.step('suspend it directly (bypassing the UI -- there is no tenant-facing suspend action)', async () => {
      const { tenant_id: tenantId } = latestConnection('mercari');
      recordSuspensionSignal(tenantId, connectionId, 'e2e-test-suspension', 'suspended');
    });

    await test.step('reload so the UI re-fetches the connection list and shows the suspended status', async () => {
      const statusRow = await expectStatusRow(page, connectionId, 'suspended', /bg-amber-100/);
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

const VINTED: PlatformLabel = { slug: 'vinted', label: 'Vinted' };

test.describe('Connections flow — revoked reconnect', () => {
  test('a revoked Vinted connection shows Reconnect; completing it creates a new connection with a new id', async ({
    page,
  }) => {
    const identifier = `e2e-vinted-${uniqueSuffix()}`;

    await test.step('connect Vinted end-to-end via the UI, same step pattern as the Depop/Mercari flows', () =>
      connectViaUi(page, VINTED, identifier));

    let original = { id: '', tenant_id: '' };

    await test.step('look up the newly-created Vinted connection directly in the scratch DB', async () => {
      original = latestConnection('vinted');
    });

    await test.step('revoke it directly (bypassing the UI -- there is no tenant-facing revoke action)', async () => {
      recordSuspensionSignal(original.tenant_id, original.id, 'e2e-test-revocation', 'revoked');
    });

    await test.step('reload so the UI re-fetches the connection list and shows the revoked status', async () => {
      const statusRow = await expectStatusRow(page, original.id, 'revoked', /bg-rose-100/);
      await expect(statusRow.getByRole('button', { name: 'Reconnect' })).toBeVisible();
      await expect(statusRow.getByRole('button', { name: 'Reactivate' })).toHaveCount(0);
    });

    await test.step('click Reconnect; it routes to the consent screen for Vinted', async () => {
      const statusRow = page.getByTestId(`status-row-${original.id}`);
      await statusRow.getByRole('button', { name: 'Reconnect' }).click();

      await expect(consentCheckbox(page)).toBeVisible();
      await expect(consentCheckbox(page)).not.toBeChecked();
      await expect(consentContinueButton(page)).toBeDisabled();
    });

    await test.step('complete the consent + credential flow again with new fake credentials', async () => {
      await acceptConsent(page);
      await submitCredentials(page, VINTED, {
        identifier: `${identifier}-reconnected`,
        password: `${FAKE_PASSWORD}-reconnected`,
      });
      await expectConfirmation(page, VINTED);
    });

    await test.step('the reconnected row in the DB has a NEW id (old revoked row deleted, new one created) and is active', async () => {
      const row = latestConnection('vinted');
      expect(row.id).not.toBe(original.id);
      expect(row.status).toBe('active');
    });
  });
});
