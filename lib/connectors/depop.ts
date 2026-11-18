import {
  buildSessionHooks,
  fillClothingFields,
  uploadSortedPhotos,
  type SessionHooks,
  type PlaywrightPageLike,
} from '@/lib/connectors/playwrightSession';
import type { ClothingDetails } from '@/lib/types';
import type {
  Connector,
  ListingInput,
  CreateListingResult,
} from '@/lib/connectors/types';
import { buildListingDescription, formatPriceDollars } from '@/lib/connectors/listingContent';
import {
  asPage,
  buildPlaywrightConnector,
  pacedGuards,
  type PlaywrightSite,
} from '@/lib/connectors/playwrightConnector';

// Depop connector. It drives Depop through the shared Playwright module; see
// playwrightConnector.ts for the 5 Connector methods, the guards and the
// selector rules.
//
// Depop publishes no relist-cooldown or share-cap policy, so there is no
// durable ban-risk state. The one mitigation is enforcePacing('depop',
// connectionId), which runs before any browser action in the 4 mutating
// methods.
//
// No live Depop seller account exists, so every selector below is a best-effort
// guess for a maintainer with account access to correct.

const DEPOP_BASE_URL = 'https://www.depop.com';

/**
 * True if the current page looks like an authenticated Depop seller view
 * (shop/dashboard chrome visible), rather than a login/signin redirect.
 * Real selector TBD against a live account -- placeholder checks for a
 * "shop" nav element assumed to exist on Depop's authenticated header. Any
 * failure reading the page (closed page, navigation error) is treated as
 * "not authenticated" rather than thrown, matching playwrightSession.ts's
 * SessionHooks#validateSession contract (a boolean, never a throw).
 */
async function isAuthenticatedDepopSession(page: PlaywrightPageLike): Promise<boolean> {
  try {
    return await page.isVisible('[data-testid="shop-nav-link"]');
  } catch {
    return false;
  }
}

/**
 * Depop login flow -- exactly one navigate+submit attempt, invoked by
 * withSession() only when the persisted session fails validation.
 * validateSessionReadOnly() never calls this (see playwrightSession.ts).
 * Fills the credential VALUE only, never interpolated into a selector.
 *
 * NOTE: this increment's credential payload (playwrightSession.ts's
 * PlaywrightCredentialPayload) only threads through a single `credential`
 * string, matching every other Playwright-driven connector's
 * SessionHooks#performLogin contract. A maintainer wiring this against a
 * live Depop account will also need a login-identifier (username/email)
 * field on the stored credential to fill the login form's first input --
 * not modeled here since no connection payload carries one yet.
 */
async function performDepopLogin(page: unknown, credential: string): Promise<void> {
  const p = asPage(page);
  await p.goto(`${DEPOP_BASE_URL}/login/`);
  await p.fill('[data-testid="login-form-password-input"]', credential);
  await p.click('[data-testid="login-form-submit-button"]');
  await p.waitForSelector('[data-testid="shop-nav-link"]', { timeout: 15000 }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Suspension classification
// ---------------------------------------------------------------------------

/**
 * Best-effort, documented-as-such text patterns Depop is known to show on a
 * suspended/banned/restricted account. Matched against raw page content
 * (not a specific selector) since the exact banner markup for this state
 * hasn't been verified against a live account in this increment -- a
 * maintainer with account access should replace this with a real selector
 * check once one is confirmed. Deliberately narrow: generic error/timeout
 * text must NOT match here, or a transient navigation hiccup would wrongly
 * suspend a healthy connection.
 */
const DEPOP_SUSPENSION_PATTERNS: RegExp[] = [
  /account\s+has\s+been\s+suspended/i,
  /account\s+has\s+been\s+banned/i,
  /your\s+account\s+(?:is|has\s+been)\s+(?:temporarily\s+)?restricted/i,
  /account\s+has\s+been\s+disabled/i,
  /violat(?:ed|ion)s?\s+of\s+(?:our|depop'?s)\s+(?:terms|polic)/i,
];

/**
 * Returns a short, non-secret classification reason if `pageContent`
 * matches a known Depop suspension/restriction banner, or null otherwise --
 * including for ambiguous/transient content (a timeout page, a generic
 * error, empty content), which must NEVER be classified as a suspension.
 */
export function classifyDepopSuspension(pageContent: string): string | null {
  if (!pageContent) {
    return null;
  }
  const match = DEPOP_SUSPENSION_PATTERNS.find((pattern) => pattern.test(pageContent));
  return match ? `depop account restriction detected (matched pattern: ${match.source})` : null;
}

/**
 * Builds the SessionHooks passed to every withSession/validateSessionReadOnly
 * call this file makes -- delegates the actual validateSession/performLogin
 * composition (and the suspension check riding along with validateSession)
 * to playwrightSession.ts#buildSessionHooks, shared by every Playwright-
 * driven connector; only isAuthenticatedDepopSession/performDepopLogin/
 * classifyDepopSuspension are Depop-specific.
 */
function buildDepopSessionHooks(tenantId: string, connectionId: string): SessionHooks {
  return buildSessionHooks(tenantId, connectionId, {
    isAuthenticated: isAuthenticatedDepopSession,
    performLogin: performDepopLogin,
    classifySuspension: classifyDepopSuspension,
  });
}

// ---------------------------------------------------------------------------
// Listing content helpers
// ---------------------------------------------------------------------------

/**
 * Fills Depop's category-specific fields (brand/size/color for clothing --
 * Depop's dominant listing category). Real Depop category-picker selectors
 * (a multi-step dropdown/typeahead flow, plus Depop's own condition-tag
 * picker) aren't modeled in detail here -- documented as the maintainer's
 * next step against a live account; this best-effort version fills the
 * fields the sell form is known to expose as plain inputs.
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

  // Depop has no dedicated "books" department the way Poshmark does --
  // best-effort fallback: check a generic "other" category checkbox.
  await page.check('[data-testid="listing-category-other"]');
}

/**
 * Uploads listing photos -- delegates the sort/path-extraction/
 * setInputFiles plumbing to playwrightSession.ts#uploadSortedPhotos,
 * shared by every photo-uploading connector; only the selector is
 * Depop-specific.
 */
async function uploadListingPhotos(page: PlaywrightPageLike, photos: ListingInput['photos']): Promise<void> {
  await uploadSortedPhotos(page, photos, '[data-testid="listing-photo-upload-input"]');
}

/**
 * Depop listing URLs are shaped
 * https://www.depop.com/products/<seller>-<slug>/ -- the last non-empty
 * path segment (after `/products/`) is treated as the external listing id.
 * Best-effort/documented shape, not confirmed against a live account.
 */
function extractListingIdFromUrl(url: string): string | null {
  const match = url.match(/\/products\/([^/?]+)\/?/);
  return match ? match[1] : null;
}

function listingPageUrl(externalListingId: string): string {
  return `${DEPOP_BASE_URL}/products/${externalListingId}/`;
}

function listingEditPageUrl(externalListingId: string): string {
  return `${DEPOP_BASE_URL}/products/${externalListingId}/edit/`;
}

// ---------------------------------------------------------------------------
// Connector methods
// ---------------------------------------------------------------------------

async function createListingAction(page: PlaywrightPageLike, input: ListingInput): Promise<CreateListingResult> {
  // 1. Navigate to Depop's sell/create-listing form -- the only page this
  //    action ever visits besides the post-submit confirmation redirect; it
  //    never enumerates the seller's shop as a side effect.
  await page.goto(`${DEPOP_BASE_URL}/products/create/`);

  // 2. Fill listing fields using VALUE-based locators only -- title/
  //    description/price values are passed as fill() arguments, never
  //    interpolated into a selector string.
  await page.fill('[data-testid="listing-title-input"]', input.title);
  await page.fill('[data-testid="listing-description-input"]', buildListingDescription(input));
  await page.fill('[data-testid="listing-price-input"]', formatPriceDollars(input.priceCents));

  // 3. Category-specific fields (size/brand/color for clothing).
  await fillCategoryFields(page, input);

  // 4. Photos -- Depop requires at least one image.
  await uploadListingPhotos(page, input.photos);

  // 5. Submit.
  await page.click('[data-testid="list-item-submit-button"]');
  await page.waitForURL(/\/products\//).catch(() => undefined);

  // 6. Extract the new listing id from the resulting URL. Falls back to
  //    this app's own itemId only if the URL couldn't be parsed -- a
  //    best-effort safety net, not the expected path.
  const externalListingId = extractListingIdFromUrl(page.url()) ?? input.itemId;

  return { externalListingId };
}

const SITE: PlaywrightSite = {
  platform: 'depop',
  buildHooks: buildDepopSessionHooks,
  detailPageUrl: listingPageUrl,
  editPageUrl: listingEditPageUrl,
  selectors: {
    notFound: '[data-testid="product-not-found"]',
    titleInput: '[data-testid="listing-title-input"]',
    priceInput: '[data-testid="listing-price-input"]',
    saveButton: '[data-testid="listing-save-button"]',
    markSoldButton: '[data-testid="listing-mark-as-sold-button"]',
    delistButton: '[data-testid="listing-delist-button"]',
  },
};

/**
 * Raw (ungated) Depop Connector implementation -- wrap with
 * gate.ts#buildConnector('depop', depopConnector) before exposing to
 * callers, same convention as every other platform.
 */
export const depopConnector: Connector = buildPlaywrightConnector(SITE, createListingAction, pacedGuards('depop'));

export const { createListing, updateListing, markSold, delist, checkConnectionHealth } = depopConnector;
