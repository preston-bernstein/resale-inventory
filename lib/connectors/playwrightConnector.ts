import {
  withSession,
  validateSessionReadOnly,
  isElementVisible,
  type SessionHooks,
  type PlaywrightPageLike,
} from '@/lib/connectors/playwrightSession';
import { enforcePacing, type PacedPlatform } from '@/lib/connectors/pacing';
import { assertCategorySupported, type SupportedPlatform } from '@/lib/constants';
import { formatPriceDollars } from '@/lib/connectors/listingContent';
import type {
  Connector,
  ListingInput,
  CreateListingResult,
  UpdateListingResult,
  MarkSoldResult,
  DelistResult,
  HealthResult,
} from '@/lib/connectors/types';

// The 5 Connector methods shared by every Playwright-driven marketplace
// (depop, grailed, mercari, poshmark, swappa, vinted). Each site supplies its
// URLs, its selectors and its create-listing form; this file owns the session
// wiring, the not-found handling and the order of the checks.
//
// Selector safety: every selector is a literal data-testid string. Listing
// content only flows into value-based APIs (`fill`), never into a selector.
//
// No over-scraping: each action visits exactly the one page it needs.

export interface ListingSelectors {
  notFound: string;
  titleInput: string;
  priceInput: string;
  saveButton: string;
  markSoldButton: string;
  delistButton: string;
}

export interface PlaywrightSite {
  platform: SupportedPlatform;
  buildHooks: (tenantId: string, connectionId: string) => SessionHooks;
  detailPageUrl: (externalListingId: string) => string;
  editPageUrl: (externalListingId: string) => string;
  selectors: ListingSelectors;
}

/**
 * Checks that run before any browser action. A ConnectorRateLimitedError (or
 * any other error) thrown here must propagate untouched, so no browser context
 * is opened for a refused call.
 */
export interface SessionGuards {
  beforeCreate: (input: ListingInput) => void;
  beforeMutation: (connectionId: string) => void;
}

type ListingPatch = Partial<Pick<ListingInput, 'title' | 'priceCents' | 'details'>>;

/**
 * `page` is typed `unknown` by withSession/validateSessionReadOnly (see
 * playwrightSession.ts) -- cast to the shared PlaywrightPageLike shape at the
 * point of use, rather than redeclaring the same Page subset in every file.
 */
export function asPage(page: unknown): PlaywrightPageLike {
  return page as PlaywrightPageLike;
}

/** Guards for a platform whose only ban-risk mitigation is enforcePacing's in-memory window. */
export function pacedGuards(platform: PacedPlatform): SessionGuards {
  return {
    beforeCreate: (input) => enforcePacing(platform, input.connectionId),
    beforeMutation: (connectionId) => enforcePacing(platform, connectionId),
  };
}

/** Guards for a platform that paces itself elsewhere: `beforeCreate` is its own pre-check. */
export function unpacedGuards(beforeCreate: (input: ListingInput) => void): SessionGuards {
  return { beforeCreate, beforeMutation: () => undefined };
}

/**
 * True if the current page shows the site's "listing not found" state -- e.g.
 * the listing was already deleted, sold and removed, or externalListingId is
 * stale. Checked via a locator's visibility rather than raw content matching:
 * it is a single, stable, expected element.
 */
function isListingMissing(site: PlaywrightSite, page: PlaywrightPageLike): Promise<boolean> {
  return isElementVisible(page, site.selectors.notFound);
}

async function updateListingAction(
  site: PlaywrightSite,
  page: PlaywrightPageLike,
  externalListingId: string,
  patch: ListingPatch,
): Promise<UpdateListingResult> {
  const { selectors } = site;
  await page.goto(site.editPageUrl(externalListingId));

  if (await isListingMissing(site, page)) {
    return { ok: false, reason: 'not_found' };
  }

  if (patch.title !== undefined) {
    await page.fill(selectors.titleInput, patch.title);
  }
  if (patch.priceCents !== undefined) {
    await page.fill(selectors.priceInput, formatPriceDollars(patch.priceCents));
  }
  // patch.details (size/brand/condition/etc) maps onto the category-specific
  // fields filled at creation time. It stays a TODO against a live account:
  // an existing listing's edit-form selectors may differ from the create form.

  await page.click(selectors.saveButton);
  return { ok: true };
}

/** Open the listing's detail page and click one button, or report not_found. */
async function clickOnDetailPage(
  site: PlaywrightSite,
  page: PlaywrightPageLike,
  externalListingId: string,
  button: string,
): Promise<MarkSoldResult | DelistResult> {
  await page.goto(site.detailPageUrl(externalListingId));

  if (await isListingMissing(site, page)) {
    return { ok: false, reason: 'not_found' };
  }

  await page.click(button);
  return { ok: true };
}

function runInSession<T>(
  site: PlaywrightSite,
  tenantId: string,
  connectionId: string,
  action: (page: PlaywrightPageLike) => Promise<T>,
): Promise<T> {
  return withSession(tenantId, connectionId, (page) => action(asPage(page)), site.buildHooks(tenantId, connectionId));
}

/**
 * Build the Connector for one site. `createAction` is the site's own
 * create-listing form flow; update, mark-sold, delist and the health check
 * are the same on every site.
 */
export function buildPlaywrightConnector(
  site: PlaywrightSite,
  createAction: (page: PlaywrightPageLike, input: ListingInput) => Promise<CreateListingResult>,
  guards: SessionGuards,
): Connector {
  const { platform, selectors } = site;

  return {
    async createListing(input) {
      assertCategorySupported(platform, input.category);
      guards.beforeCreate(input);

      return runInSession(site, input.tenantId, input.connectionId, (page) => createAction(page, input));
    },

    async updateListing(externalListingId, tenantId, connectionId, patch) {
      guards.beforeMutation(connectionId);

      return runInSession(site, tenantId, connectionId, (page) =>
        updateListingAction(site, page, externalListingId, patch),
      );
    },

    async markSold(externalListingId, tenantId, connectionId) {
      guards.beforeMutation(connectionId);

      return runInSession(site, tenantId, connectionId, (page) =>
        clickOnDetailPage(site, page, externalListingId, selectors.markSoldButton),
      );
    },

    async delist(externalListingId, tenantId, connectionId) {
      guards.beforeMutation(connectionId);

      return runInSession(site, tenantId, connectionId, (page) =>
        clickOnDetailPage(site, page, externalListingId, selectors.delistButton),
      );
    },

    /**
     * Read-only session health check -- calls validateSessionReadOnly, NEVER
     * withSession and NEVER the guards, so a health check can neither trigger
     * a fresh login attempt nor consume a pacing window. A health probe is
     * not a mutating marketplace action.
     */
    async checkConnectionHealth(tenantId, connectionId): Promise<HealthResult> {
      return validateSessionReadOnly(tenantId, connectionId, site.buildHooks(tenantId, connectionId));
    },
  };
}
