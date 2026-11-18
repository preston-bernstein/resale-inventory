import {
  buildSessionHooks,
  fillClothingFields,
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

// Grailed connector. It drives Grailed through the shared Playwright module;
// see playwrightConnector.ts for the 5 Connector methods, the guards and the
// selector rules.
//
// Grailed publishes no relist-cooldown or share-cap policy, so there is no
// durable ban-risk state. The one mitigation is enforcePacing('grailed',
// connectionId), which runs before any browser action in the 4 mutating
// methods.
//
// No live Grailed seller account exists, so every selector below is a best-effort
// guess for a maintainer with account access to correct.

const GRAILED_BASE_URL = 'https://www.grailed.com';

/**
 * True if the current page looks like an authenticated Grailed seller view
 * (selling/dashboard chrome visible), rather than a login/signin redirect.
 * Real selector TBD against a live account -- placeholder checks for a
 * "sell" nav element assumed to exist on Grailed's authenticated header.
 * Any failure reading the page (closed page, navigation error) is treated
 * as "not authenticated" rather than thrown, matching
 * playwrightSession.ts's SessionHooks#validateSession contract (a boolean,
 * never a throw).
 */
async function isAuthenticatedGrailedSession(page: PlaywrightPageLike): Promise<boolean> {
  try {
    return await page.isVisible('[data-testid="sell-nav-link"]');
  } catch {
    return false;
  }
}

/**
 * Grailed login flow -- exactly one navigate+submit attempt, invoked by
 * withSession() only when the persisted session fails validation.
 * validateSessionReadOnly() never calls this (see playwrightSession.ts).
 * Fills the credential VALUE only, never interpolated into a selector.
 *
 * NOTE: this increment's credential payload (playwrightSession.ts's
 * PlaywrightCredentialPayload) only threads through a single `credential`
 * string, matching every other Playwright-driven connector's
 * SessionHooks#performLogin contract. A maintainer wiring this against a
 * live Grailed account will also need a login-identifier (username/email)
 * field on the stored credential to fill the login form's first input --
 * not modeled here since no connection payload carries one yet.
 */
async function performGrailedLogin(page: unknown, credential: string): Promise<void> {
  const p = asPage(page);
  await p.goto(`${GRAILED_BASE_URL}/login`);
  await p.fill('[data-testid="login-form-password-input"]', credential);
  await p.click('[data-testid="login-form-submit-button"]');
  await p.waitForSelector('[data-testid="sell-nav-link"]', { timeout: 15000 }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Suspension classification
// ---------------------------------------------------------------------------

/**
 * Best-effort, documented-as-such text patterns Grailed is known to show on
 * a banned/suspended/under-review account. Matched against raw page content
 * (not a specific selector) since the exact banner markup for this state
 * hasn't been verified against a live account in this increment -- a
 * maintainer with account access should replace this with a real selector
 * check once one is confirmed. Deliberately narrow: generic error/timeout
 * text must NOT match here, or a transient navigation hiccup would wrongly
 * suspend a healthy connection.
 */
const GRAILED_SUSPENSION_PATTERNS: RegExp[] = [
  /account\s+has\s+been\s+banned/i,
  /your\s+account\s+(?:is|has\s+been)\s+(?:temporarily\s+)?suspended/i,
  /account\s+is\s+under\s+review/i,
  /violat(?:ed|ion)s?\s+of\s+(?:our|grailed'?s)\s+(?:terms|polic)/i,
];

/**
 * Returns a short, non-secret classification reason if `pageContent`
 * matches a known Grailed suspension/ban/under-review banner, or null
 * otherwise -- including for ambiguous/transient content (a timeout page,
 * a generic error, empty content), which must NEVER be classified as a
 * suspension.
 */
export function classifyGrailedSuspension(pageContent: string): string | null {
  if (!pageContent) {
    return null;
  }
  const match = GRAILED_SUSPENSION_PATTERNS.find((pattern) => pattern.test(pageContent));
  return match ? `grailed account restriction detected (matched pattern: ${match.source})` : null;
}

/**
 * Builds the SessionHooks passed to every withSession/validateSessionReadOnly
 * call this file makes -- delegates the actual validateSession/performLogin
 * composition (and the suspension check riding along with validateSession)
 * to playwrightSession.ts#buildSessionHooks, shared by every Playwright-
 * driven connector; only isAuthenticatedGrailedSession/performGrailedLogin/
 * classifyGrailedSuspension are Grailed-specific.
 */
function buildGrailedSessionHooks(tenantId: string, connectionId: string): SessionHooks {
  return buildSessionHooks(tenantId, connectionId, {
    isAuthenticated: isAuthenticatedGrailedSession,
    performLogin: performGrailedLogin,
    classifySuspension: classifyGrailedSuspension,
  });
}

// ---------------------------------------------------------------------------
// Listing content helpers
// ---------------------------------------------------------------------------

/**
 * Fills Grailed's electronics-specific fields (brand/model/condition/
 * processor/RAM/storage/screen size/battery health) -- Grailed's sell form
 * is menswear/streetwear-focused in practice, but per PLATFORM_CATEGORY_SUPPORT
 * (lib/constants.ts) it also accepts electronics listings, same uniform
 * ListingInput contract every platform connector threads `details` through.
 * Real Grailed category-picker selectors are a multi-step dropdown/typeahead
 * flow not modeled in detail here -- documented as the maintainer's next
 * step against a live account; this best-effort version fills the fields
 * the sell form is known to expose as plain inputs. Nullable numeric/
 * optional spec fields (processor/ram/storage/screen size/battery health)
 * are only filled when present, same pattern as fillClothingFields' optional
 * `color` -- battery_cycle_count isn't modeled as a distinct form field here
 * (it still rides along in the free-text description via
 * buildListingDescription).
 */
const ELECTRONICS_NUMERIC_FIELDS: { selector: string; read: (details: ElectronicsDetails) => number | null | undefined }[] = [
  { selector: '[data-testid="listing-ram-input"]', read: (d) => d.ram_gb },
  { selector: '[data-testid="listing-storage-input"]', read: (d) => d.storage_gb },
  { selector: '[data-testid="listing-screen-size-input"]', read: (d) => d.screen_size_in },
  { selector: '[data-testid="listing-battery-health-input"]', read: (d) => d.battery_health_pct },
];

async function fillElectronicsFields(page: PlaywrightPageLike, details: ElectronicsDetails): Promise<void> {
  await page.fill('[data-testid="listing-brand-input"]', details.brand ?? '');
  await page.fill('[data-testid="listing-model-input"]', details.model ?? '');
  await page.fill('[data-testid="listing-condition-input"]', details.condition);
  if (details.processor) {
    await page.fill('[data-testid="listing-processor-input"]', details.processor);
  }
  for (const { selector, read } of ELECTRONICS_NUMERIC_FIELDS) {
    const value = read(details);
    if (value !== null && value !== undefined) {
      await page.fill(selector, String(value));
    }
  }
}

/**
 * Fills Grailed's category-specific fields -- brand/size/color for clothing
 * (via the shared fillClothingFields helper, same as every other clothing-
 * capable connector), or brand/model/condition/spec fields for electronics
 * (via fillElectronicsFields above). Grailed has no book category in
 * practice, but this connector still threads `details` through generically
 * like every other platform connector for a uniform ListingInput contract,
 * so a 'book' input simply falls through as a no-op here.
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
  }
}

/**
 * Grailed listing URLs are shaped
 * https://www.grailed.com/listings/<listingId>-<title-slug> -- the id is
 * the first hyphen-delimited segment of the last path component.
 * Best-effort/documented shape, not confirmed against a live account.
 */
function extractListingIdFromUrl(url: string): string | null {
  const match = url.match(/\/listings\/(\d+)(?:-[^/]*)?\/?$/);
  return match ? match[1] : null;
}

function listingPageUrl(externalListingId: string): string {
  return `${GRAILED_BASE_URL}/listings/${externalListingId}`;
}

function listingEditPageUrl(externalListingId: string): string {
  return `${GRAILED_BASE_URL}/listings/${externalListingId}/edit`;
}

// ---------------------------------------------------------------------------
// Connector methods
// ---------------------------------------------------------------------------

async function createListingAction(page: PlaywrightPageLike, input: ListingInput): Promise<CreateListingResult> {
  // Navigate to Grailed's "Sell"/create-listing form -- the only page this
  // action ever visits besides the post-submit confirmation redirect; it
  // never enumerates the seller's full listing index as a side effect.
  await page.goto(`${GRAILED_BASE_URL}/sell`);

  // Fill listing fields using VALUE-based locators only -- title/
  // description/price values are passed as fill() arguments, never
  // interpolated into a selector string.
  await page.fill('[data-testid="listing-title-input"]', input.title);
  await page.fill('[data-testid="listing-description-input"]', buildListingDescription(input));
  await page.fill('[data-testid="listing-price-input"]', formatPriceDollars(input.priceCents));

  // Category-specific fields (size/brand/color for clothing).
  await fillCategoryFields(page, input);

  // Submit.
  await page.click('[data-testid="list-item-submit-button"]');
  await page.waitForURL(/\/listings\//).catch(() => undefined);

  // Extract the new listing id from the resulting URL. Falls back to this
  // app's own itemId only if the URL couldn't be parsed -- a best-effort
  // safety net, not the expected path.
  const externalListingId = extractListingIdFromUrl(page.url()) ?? input.itemId;

  return { externalListingId };
}

const SITE: PlaywrightSite = {
  platform: 'grailed',
  buildHooks: buildGrailedSessionHooks,
  detailPageUrl: listingPageUrl,
  editPageUrl: listingEditPageUrl,
  selectors: {
    notFound: '[data-testid="listing-not-found"]',
    titleInput: '[data-testid="listing-title-input"]',
    priceInput: '[data-testid="listing-price-input"]',
    saveButton: '[data-testid="listing-save-button"]',
    markSoldButton: '[data-testid="listing-mark-as-sold-button"]',
    delistButton: '[data-testid="listing-delist-button"]',
  },
};

/**
 * Raw (ungated) Grailed Connector implementation -- wrap with
 * gate.ts#buildConnector('grailed', grailedConnector) before exposing to
 * callers, same convention as every other platform.
 */
export const grailedConnector: Connector = buildPlaywrightConnector(SITE, createListingAction, pacedGuards('grailed'));

export const { createListing, updateListing, markSold, delist, checkConnectionHealth } = grailedConnector;
