import {
  buildSessionHooks,
  fillClothingFields,
  uploadSortedPhotos,
  type SessionHooks,
  type PlaywrightPageLike,
} from '@/lib/connectors/playwrightSession';
import {
  asPage,
  buildPlaywrightConnector,
  pacedGuards,
  type PlaywrightSite,
} from '@/lib/connectors/playwrightConnector';
import type { ClothingDetails, ElectronicsDetails } from '@/lib/types';
import type {
  Connector,
  ListingInput,
  CreateListingResult,
} from '@/lib/connectors/types';
import { buildListingDescription, formatPriceDollars } from '@/lib/connectors/listingContent';

// Mercari connector. It drives Mercari through the shared Playwright module;
// see playwrightConnector.ts for the 5 Connector methods, the guards and the
// selector rules.
//
// Mercari publishes no relist-cooldown or share-cap policy, so there is no
// durable ban-risk state. The one mitigation is enforcePacing('mercari',
// connectionId), which runs before any browser action in the 4 mutating
// methods.
//
// No live Mercari seller account exists, so every selector below is a best-effort
// guess for a maintainer with account access to correct.

const MERCARI_BASE_URL = 'https://www.mercari.com';

/**
 * True if the current page looks like an authenticated Mercari seller view
 * (account/sell-dashboard chrome visible), rather than a login/signin
 * redirect. Real selector TBD against a live account -- placeholder checks
 * for a "My Page"/account nav element assumed to exist on Mercari's
 * authenticated header. Any failure reading the page (closed page,
 * navigation error) is treated as "not authenticated" rather than thrown,
 * matching playwrightSession.ts's SessionHooks#validateSession contract (a
 * boolean, never a throw).
 */
async function isAuthenticatedMercariSession(page: PlaywrightPageLike): Promise<boolean> {
  try {
    return await page.isVisible('[data-testid="account-nav-link"]');
  } catch {
    return false;
  }
}

/**
 * Mercari login flow -- exactly one navigate+submit attempt, invoked by
 * withSession() only when the persisted session fails validation.
 * validateSessionReadOnly() never calls this (see playwrightSession.ts).
 * Fills the credential VALUE only, never interpolated into a selector.
 *
 * NOTE: this increment's credential payload (playwrightSession.ts's
 * PlaywrightCredentialPayload) only threads through a single `credential`
 * string, matching every other Playwright-driven connector's
 * SessionHooks#performLogin contract. A maintainer wiring this against a
 * live Mercari account will also need a login-identifier (email/phone)
 * field on the stored credential to fill the login form's first input --
 * not modeled here since no connection payload carries one yet.
 */
async function performMercariLogin(page: unknown, credential: string): Promise<void> {
  const p = asPage(page);
  await p.goto(`${MERCARI_BASE_URL}/login`);
  await p.fill('[data-testid="login-form-password-input"]', credential);
  await p.click('[data-testid="login-form-submit-button"]');
  await p.waitForSelector('[data-testid="account-nav-link"]', { timeout: 15000 }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Suspension classification
// ---------------------------------------------------------------------------

/**
 * Best-effort, documented-as-such text patterns Mercari is known to show on
 * a deactivated/suspended/restricted account. Matched against raw page
 * content (not a specific selector) since the exact banner markup for this
 * state hasn't been verified against a live account in this increment -- a
 * maintainer with account access should replace this with a real selector
 * check once one is confirmed. Deliberately narrow: generic error/timeout
 * text must NOT match here, or a transient navigation hiccup would wrongly
 * suspend a healthy connection.
 */
const MERCARI_SUSPENSION_PATTERNS: RegExp[] = [
  /account\s+has\s+been\s+(?:deactivated|disabled)/i,
  /your\s+account\s+(?:is|has\s+been)\s+(?:temporarily\s+)?(?:restricted|suspended|locked)/i,
  /account\s+suspension/i,
  /violat(?:ed|ion)s?\s+of\s+(?:our|mercari'?s)\s+(?:terms|polic)/i,
];

/**
 * Returns a short, non-secret classification reason if `pageContent`
 * matches a known Mercari suspension/restriction banner, or null otherwise
 * -- including for ambiguous/transient content (a timeout page, a generic
 * error, empty content), which must NEVER be classified as a suspension.
 */
export function classifyMercariSuspension(pageContent: string): string | null {
  if (!pageContent) {
    return null;
  }
  const match = MERCARI_SUSPENSION_PATTERNS.find((pattern) => pattern.test(pageContent));
  return match ? `mercari account restriction detected (matched pattern: ${match.source})` : null;
}

/**
 * Builds the SessionHooks passed to every withSession/validateSessionReadOnly
 * call this file makes -- delegates the actual validateSession/performLogin
 * composition (and the suspension check riding along with validateSession)
 * to playwrightSession.ts#buildSessionHooks, shared by every Playwright-
 * driven connector; only isAuthenticatedMercariSession/performMercariLogin/
 * classifyMercariSuspension are Mercari-specific.
 */
function buildMercariSessionHooks(tenantId: string, connectionId: string): SessionHooks {
  return buildSessionHooks(tenantId, connectionId, {
    isAuthenticated: isAuthenticatedMercariSession,
    performLogin: performMercariLogin,
    classifySuspension: classifyMercariSuspension,
  });
}

// ---------------------------------------------------------------------------
// Listing content helpers
// ---------------------------------------------------------------------------

/**
 * Fills Mercari's category-specific fields (brand/size/color for clothing,
 * brand/model for electronics, a "Books" category checkbox for books). Real
 * Mercari category-picker selectors are a multi-step dropdown/typeahead flow
 * not modeled in detail here -- documented as the maintainer's next step
 * against a live account; this best-effort version fills the fields the
 * create-listing form is known to expose as plain inputs.
 */
async function fillCategoryFields(page: PlaywrightPageLike, input: ListingInput): Promise<void> {
  if (input.category === 'clothing') {
    await fillClothingFields(page, input.details as ClothingDetails, {
      brand: '[data-testid="listing-brand-input"]',
      size: '[data-testid="listing-size-input"]',
      color: '[data-testid="listing-color-input"]',
    });
    return;
  }

  if (input.category === 'electronics') {
    await fillElectronicsFields(page, input.details as ElectronicsDetails);
    return;
  }

  await page.check('[data-testid="listing-category-books"]');
}

/**
 * Fills Mercari's electronics-specific fields (brand/model). The remaining
 * spec fields (processor/ram/storage/screen size/battery health/cycle
 * count) and condition ride along in the free-text description via
 * buildListingDescription rather than separate structured fields, same
 * convention as swappa.ts's fillDeviceSpecFields.
 */
async function fillElectronicsFields(page: PlaywrightPageLike, details: ElectronicsDetails): Promise<void> {
  await page.fill('[data-testid="listing-brand-input"]', details.brand);
  await page.fill('[data-testid="listing-model-input"]', details.model);
}

/**
 * Uploads listing photos -- delegates the sort/path-extraction/
 * setInputFiles plumbing to playwrightSession.ts#uploadSortedPhotos,
 * shared by every photo-uploading connector; only the selector is
 * Mercari-specific.
 */
async function uploadListingPhotos(page: PlaywrightPageLike, photos: ListingInput['photos']): Promise<void> {
  await uploadSortedPhotos(page, photos, '[data-testid="listing-photo-upload-input"]');
}

/**
 * Mercari listing URLs are shaped
 * https://www.mercari.com/us/item/<listingId>/ -- the id is the last
 * slash-delimited path segment. Best-effort/documented shape, not confirmed
 * against a live account.
 */
function extractListingIdFromUrl(url: string): string | null {
  const match = url.match(/\/item\/([a-zA-Z0-9]+)\/?$/);
  return match ? match[1] : null;
}

function listingPageUrl(externalListingId: string): string {
  return `${MERCARI_BASE_URL}/us/item/${externalListingId}/`;
}

function listingEditPageUrl(externalListingId: string): string {
  return `${MERCARI_BASE_URL}/us/sell/edit/${externalListingId}/`;
}

// ---------------------------------------------------------------------------
// Connector methods
// ---------------------------------------------------------------------------

async function createListingAction(page: PlaywrightPageLike, input: ListingInput): Promise<CreateListingResult> {
  // 1. Navigate to Mercari's "Sell"/create-listing form -- the only page
  //    this action ever visits besides the post-submit confirmation
  //    redirect; it never enumerates the seller's full item index as a
  //    side effect.
  await page.goto(`${MERCARI_BASE_URL}/sell/`);

  // 2. Fill listing fields using VALUE-based locators only -- title/
  //    description/price values are passed as fill() arguments, never
  //    interpolated into a selector string.
  await page.fill('[data-testid="listing-title-input"]', input.title);
  await page.fill('[data-testid="listing-description-input"]', buildListingDescription(input));
  await page.fill('[data-testid="listing-price-input"]', formatPriceDollars(input.priceCents));

  // 3. Category-specific fields (size/brand for clothing, brand/model for
  //    electronics, category for books).
  await fillCategoryFields(page, input);

  // 4. Photos -- Mercari requires at least one image.
  await uploadListingPhotos(page, input.photos);

  // 5. Submit.
  await page.click('[data-testid="list-item-submit-button"]');
  await page.waitForURL(/\/item\//).catch(() => undefined);

  // 6. Extract the new listing id from the resulting URL. Falls back to
  //    this app's own itemId only if the URL couldn't be parsed -- a
  //    best-effort safety net, not the expected path.
  const externalListingId = extractListingIdFromUrl(page.url()) ?? input.itemId;

  return { externalListingId };
}

const SITE: PlaywrightSite = {
  platform: 'mercari',
  buildHooks: buildMercariSessionHooks,
  detailPageUrl: listingPageUrl,
  editPageUrl: listingEditPageUrl,
  selectors: {
    notFound: '[data-testid="item-not-found"]',
    titleInput: '[data-testid="listing-title-input"]',
    priceInput: '[data-testid="listing-price-input"]',
    saveButton: '[data-testid="listing-save-button"]',
    markSoldButton: '[data-testid="listing-mark-as-sold-button"]',
    delistButton: '[data-testid="listing-delist-button"]',
  },
};

/**
 * Raw (ungated) Mercari Connector implementation -- wrap with
 * gate.ts#buildConnector('mercari', mercariConnector) before exposing to
 * callers, same convention as every other platform.
 */
export const mercariConnector: Connector = buildPlaywrightConnector(SITE, createListingAction, pacedGuards('mercari'));

export const { createListing, updateListing, markSold, delist, checkConnectionHealth } = mercariConnector;
