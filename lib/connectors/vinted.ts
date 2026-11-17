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

// Vinted connector. It drives Vinted through the shared Playwright module;
// see playwrightConnector.ts for the 5 Connector methods, the guards and the
// selector rules.
//
// Vinted publishes no relist-cooldown or share-cap policy, so there is no
// durable ban-risk state. The one mitigation is enforcePacing('vinted',
// connectionId), which runs before any browser action in the 4 mutating
// methods.
//
// No live Vinted seller account exists, so every selector below is a best-effort
// guess for a maintainer with account access to correct.

const VINTED_BASE_URL = 'https://www.vinted.com';

/**
 * True if the current page looks like an authenticated Vinted member view
 * (wardrobe/profile chrome visible), rather than a login redirect. Real
 * selector TBD against a live account -- placeholder checks for a "My
 * wardrobe" nav element assumed to exist on Vinted's authenticated header.
 * Any failure reading the page (closed page, navigation error) is treated
 * as "not authenticated" rather than thrown, matching
 * playwrightSession.ts's SessionHooks#validateSession contract (a boolean,
 * never a throw).
 */
async function isAuthenticatedVintedSession(page: PlaywrightPageLike): Promise<boolean> {
  try {
    return await page.isVisible('[data-testid="wardrobe-nav-link"]');
  } catch {
    return false;
  }
}

/**
 * Vinted login flow -- exactly one navigate+submit attempt, invoked by
 * withSession() only when the persisted session fails validation.
 * validateSessionReadOnly() never calls this (see playwrightSession.ts).
 * Fills the credential VALUE only, never interpolated into a selector.
 *
 * NOTE: same caveat as poshmark.ts#performPoshmarkLogin -- this
 * increment's credential payload only threads through a single
 * `credential` string (playwrightSession.ts's PlaywrightCredentialPayload).
 * A maintainer wiring this against a live Vinted account will also need a
 * login-identifier (username/email) field on the stored credential to fill
 * the login form's first input -- not modeled here since no connection
 * payload carries one yet.
 */
async function performVintedLogin(page: unknown, credential: string): Promise<void> {
  const p = asPage(page);
  await p.goto(`${VINTED_BASE_URL}/member/login`);
  await p.fill('[data-testid="login-form-password-input"]', credential);
  await p.click('[data-testid="login-form-submit-button"]');
  await p.waitForSelector('[data-testid="wardrobe-nav-link"]', { timeout: 15000 }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Suspension classification
// ---------------------------------------------------------------------------

/**
 * Best-effort, documented-as-such text patterns Vinted is known to show on
 * a disabled/banned/restricted account. Matched against raw page content
 * (not a specific selector) since the exact banner markup for this state
 * hasn't been verified against a live account in this increment -- a
 * maintainer with account access should replace this with a real selector
 * check once one is confirmed. Deliberately narrow: generic error/timeout
 * text must NOT match here, or a transient navigation hiccup would wrongly
 * suspend a healthy connection.
 */
const VINTED_SUSPENSION_PATTERNS: RegExp[] = [
  /account\s+has\s+been\s+(?:disabled|banned)/i,
  /your\s+account\s+(?:is|has\s+been)\s+(?:temporarily\s+)?(?:blocked|restricted|suspended)/i,
  /this\s+account\s+(?:is|has\s+been)\s+closed/i,
  /violat(?:ed|ion)s?\s+of\s+(?:our|vinted'?s)\s+(?:terms|polic)/i,
];

/**
 * Returns a short, non-secret classification reason if `pageContent`
 * matches a known Vinted suspension/restriction banner, or null otherwise
 * -- including for ambiguous/transient content (a timeout page, a generic
 * error, empty content), which must NEVER be classified as a suspension.
 */
export function classifyVintedSuspension(pageContent: string): string | null {
  if (!pageContent) {
    return null;
  }
  const match = VINTED_SUSPENSION_PATTERNS.find((pattern) => pattern.test(pageContent));
  return match ? `vinted account restriction detected (matched pattern: ${match.source})` : null;
}

/**
 * Builds the SessionHooks passed to every withSession/validateSessionReadOnly
 * call this file makes -- delegates the actual validateSession/performLogin
 * composition (and the suspension check riding along with validateSession)
 * to playwrightSession.ts#buildSessionHooks, shared by every Playwright-
 * driven connector; only isAuthenticatedVintedSession/performVintedLogin/
 * classifyVintedSuspension are Vinted-specific.
 */
function buildVintedSessionHooks(tenantId: string, connectionId: string): SessionHooks {
  return buildSessionHooks(tenantId, connectionId, {
    isAuthenticated: isAuthenticatedVintedSession,
    performLogin: performVintedLogin,
    classifySuspension: classifyVintedSuspension,
  });
}

// ---------------------------------------------------------------------------
// Listing content helpers
// ---------------------------------------------------------------------------

/**
 * Fills Vinted's category-specific fields (brand/size/color for clothing).
 * Vinted's core catalog is clothing/fashion -- books have no natural
 * category-specific field beyond what buildListingDescription already
 * covers, so this is a no-op for `book` items. Real Vinted category-picker
 * selectors are a multi-step dropdown/typeahead flow not modeled in detail
 * here -- documented as the maintainer's next step against a live account;
 * this best-effort version fills the fields the upload form is known to
 * expose as plain inputs.
 */
async function fillCategoryFields(page: PlaywrightPageLike, input: ListingInput): Promise<void> {
  if (input.category !== 'clothing') {
    return;
  }
  await fillClothingFields(page, input.details as ClothingDetails, {
    brand: '[data-testid="upload-brand-input"]',
    size: '[data-testid="upload-size-input"]',
    color: '[data-testid="upload-color-input"]',
  });
}

/**
 * Uploads listing photos -- delegates the sort/path-extraction/
 * setInputFiles plumbing to playwrightSession.ts#uploadSortedPhotos,
 * shared by every photo-uploading connector; only the selector is
 * Vinted-specific.
 */
async function uploadListingPhotos(page: PlaywrightPageLike, photos: ListingInput['photos']): Promise<void> {
  await uploadSortedPhotos(page, photos, '[data-testid="upload-photo-input"]');
}

/**
 * Vinted item URLs are shaped https://www.vinted.com/items/<itemId>-<slug>
 * -- the id is the first path segment after /items/. Best-effort/
 * documented shape, not confirmed against a live account.
 */
function extractListingIdFromUrl(url: string): string | null {
  const match = url.match(/\/items\/(\d+)(?:-[^/]*)?\/?$/);
  return match ? match[1] : null;
}

function itemPageUrl(externalListingId: string): string {
  return `${VINTED_BASE_URL}/items/${externalListingId}`;
}

function itemEditPageUrl(externalListingId: string): string {
  return `${VINTED_BASE_URL}/items/${externalListingId}/edit`;
}

// ---------------------------------------------------------------------------
// Connector methods
// ---------------------------------------------------------------------------

async function createListingAction(page: PlaywrightPageLike, input: ListingInput): Promise<CreateListingResult> {
  // 1. Navigate to Vinted's upload/create-listing form -- the only page
  //    this action ever visits besides the post-submit confirmation
  //    redirect; it never enumerates the seller's wardrobe as a side
  //    effect.
  await page.goto(`${VINTED_BASE_URL}/items/new`);

  // 2. Fill listing fields using VALUE-based locators only -- title/
  //    description/price values are passed as fill() arguments, never
  //    interpolated into a selector string.
  await page.fill('[data-testid="upload-title-input"]', input.title);
  await page.fill('[data-testid="upload-description-input"]', buildListingDescription(input));
  await page.fill('[data-testid="upload-price-input"]', formatPriceDollars(input.priceCents));

  // 3. Category-specific fields (size/brand/color for clothing; no-op for
  //    books).
  await fillCategoryFields(page, input);

  // 4. Photos -- Vinted requires at least one image.
  await uploadListingPhotos(page, input.photos);

  // 5. Submit.
  await page.click('[data-testid="upload-submit-button"]');
  await page.waitForURL(/\/items\/\d+/).catch(() => undefined);

  // 6. Extract the new item id from the resulting URL. Falls back to this
  //    app's own itemId only if the URL couldn't be parsed -- a best-effort
  //    safety net, not the expected path.
  const externalListingId = extractListingIdFromUrl(page.url()) ?? input.itemId;

  return { externalListingId };
}

const SITE: PlaywrightSite = {
  platform: 'vinted',
  buildHooks: buildVintedSessionHooks,
  detailPageUrl: itemPageUrl,
  editPageUrl: itemEditPageUrl,
  selectors: {
    notFound: '[data-testid="item-not-found"]',
    titleInput: '[data-testid="upload-title-input"]',
    priceInput: '[data-testid="upload-price-input"]',
    saveButton: '[data-testid="upload-save-button"]',
    markSoldButton: '[data-testid="item-mark-as-sold-button"]',
    delistButton: '[data-testid="item-delist-button"]',
  },
};

/**
 * Raw (ungated) Vinted Connector implementation -- wrap with
 * gate.ts#buildConnector('vinted', vintedConnector) before exposing to
 * callers, same convention as every other platform.
 */
export const vintedConnector: Connector = buildPlaywrightConnector(SITE, createListingAction, pacedGuards('vinted'));

export const { createListing, updateListing, markSold, delist, checkConnectionHealth } = vintedConnector;
