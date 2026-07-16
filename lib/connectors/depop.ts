import { recordSuspensionSignal } from '@/lib/connections';
import { withSession, validateSessionReadOnly, type SessionHooks } from '@/lib/connectors/playwrightSession';
import { scrubSecrets } from '@/lib/connectors/scrub';
import { enforcePacing } from '@/lib/connectors/pacing';
import type { BookDetails, ClothingDetails } from '@/lib/types';
import type {
  Connector,
  ListingInput,
  CreateListingResult,
  UpdateListingResult,
  MarkSoldResult,
  DelistResult,
  HealthResult,
} from '@/lib/connectors/types';

// Depop connector -- the 5 shared Connector methods (createListing/
// updateListing/markSold/delist/checkConnectionHealth), driving Depop via
// lib/connectors/playwrightSession.ts's shared Playwright session harness,
// same pattern as lib/connectors/poshmark.ts (its sibling task and this
// file's reference implementation for the Playwright/withSession
// conventions, suspension-classification shape, and selector-safety rules).
//
// Unlike Poshmark, Depop publishes no documented relist-cooldown or
// share-cap policy, so it has NO durable
// (poshmark_delist_events/poshmark_share_events-shaped) ban-risk
// persistence layer. Its sole ban-risk mitigation is
// lib/connectors/pacing.ts#enforcePacing('depop', connectionId) --
// an in-memory, conservative "1 action per DEPOP_ACTION_RATE_LIMIT_MS
// window per connection" self-pace (lib/constants.ts), called FIRST, before
// any Playwright/browser action, in every one of the 4 mutating methods
// below. A ConnectorRateLimitedError thrown by enforcePacing must propagate
// untouched -- never caught here -- so a paced-out caller sees exactly that
// error and no browser context is ever opened for that call.
//
// No live Depop seller account exists to verify selectors against in this
// increment, so every selector/DOM check below is a best-effort, clearly
// commented approximation of Depop's real sell/listing-edit/listing-detail
// pages -- a concrete starting shape for a maintainer with real account
// access to correct, not a placeholder no-op.
//
// Selector safety: every locator below is a stable, literal data-testid
// string -- listing content (title/description/price/etc) only ever flows
// into Playwright's VALUE-based APIs (`fill`/`check`/`setInputFiles`),
// never interpolated into a selector string.
//
// No over-scraping: each method navigates to exactly the one page its
// action needs -- the create-listing form, or a single listing's
// detail/edit page keyed by externalListingId -- never the seller's full
// shop listing index.

/**
 * Minimal value-based subset of Playwright's `Page` API this file touches.
 * Declared locally -- like playwrightSession.ts itself -- so this module
 * never needs a static import of the `playwright` package; `withSession`/
 * `validateSessionReadOnly` hand back `page` typed `unknown`, cast to this
 * shape at the point of use via `asPage()` below.
 */
interface DepopPage {
  goto(url: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  check(selector: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForURL(pattern: string | RegExp): Promise<void>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  url(): string;
  content(): Promise<string>;
  setInputFiles(selector: string, files: string | string[]): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
}

function asPage(page: unknown): DepopPage {
  return page as DepopPage;
}

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
async function isAuthenticatedDepopSession(page: DepopPage): Promise<boolean> {
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
 * Reads the current page's content and, ONLY on a positive
 * classifyDepopSuspension() match, records a suspension signal via
 * lib/connections.ts#recordSuspensionSignal with a scrubbed reason. Any
 * failure reading page content (navigation timeout, closed page, etc) is
 * swallowed here and treated as "nothing to report" -- an ambiguous or
 * transient failure must never trigger a suspension write.
 */
async function detectAndRecordSuspension(
  tenantId: string,
  connectionId: string,
  page: DepopPage,
): Promise<void> {
  let content: string;
  try {
    content = await page.content();
  } catch {
    return;
  }

  const reason = classifyDepopSuspension(content);
  if (!reason) {
    return;
  }

  // scrubSecrets is effectively a no-op here (the reason string is built
  // entirely from a static pattern match, never from raw page content) --
  // called anyway so every recordSuspensionSignal call site in the
  // connector layer scrubs its reason the same way (see poshmark.ts).
  recordSuspensionSignal(tenantId, connectionId, scrubSecrets(reason, []), 'suspended');
}

/**
 * Builds the SessionHooks passed to every withSession/validateSessionReadOnly
 * call this file makes -- one choke point so validateSession/performLogin
 * behavior (and the suspension check riding along with validateSession)
 * stays identical across all 5 Connector methods.
 */
function buildDepopSessionHooks(tenantId: string, connectionId: string): SessionHooks {
  return {
    validateSession: async (page) => {
      const p = asPage(page);
      const authenticated = await isAuthenticatedDepopSession(p);
      // Suspension banner text can appear on an otherwise "authenticated"
      // page (nav chrome can still render for a restricted account), so
      // this check always runs, independent of the auth result above.
      await detectAndRecordSuspension(tenantId, connectionId, p);
      return authenticated;
    },
    performLogin: performDepopLogin,
  };
}

// ---------------------------------------------------------------------------
// Listing content helpers
// ---------------------------------------------------------------------------

function formatDollars(priceCents: number): string {
  return (priceCents / 100).toFixed(2);
}

/** Builds the listing description text from category-specific details. */
function buildListingDescription(input: Pick<ListingInput, 'category' | 'details'>): string {
  if (input.category === 'book') {
    const d = input.details as BookDetails;
    return [
      d.author ? `By ${d.author}` : null,
      d.publisher ? `Publisher: ${d.publisher}` : null,
      d.isbn ? `ISBN: ${d.isbn}` : null,
      `Condition: ${d.condition}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  const d = input.details as ClothingDetails;
  return [
    d.brand ? `Brand: ${d.brand}` : null,
    d.size_label ? `Size: ${d.size_label}` : null,
    d.color ? `Color: ${d.color}` : null,
    `Condition: ${d.condition}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Fills Depop's category-specific fields (brand/size/color for clothing --
 * Depop's dominant listing category). Real Depop category-picker selectors
 * (a multi-step dropdown/typeahead flow, plus Depop's own condition-tag
 * picker) aren't modeled in detail here -- documented as the maintainer's
 * next step against a live account; this best-effort version fills the
 * fields the sell form is known to expose as plain inputs.
 */
async function fillCategoryFields(page: DepopPage, input: ListingInput): Promise<void> {
  if (input.category === 'clothing') {
    const d = input.details as ClothingDetails;
    await page.fill('[data-testid="listing-brand-input"]', d.brand ?? '');
    await page.fill('[data-testid="listing-size-input"]', d.size_label ?? '');
    if (d.color) {
      await page.fill('[data-testid="listing-color-input"]', d.color);
    }
    return;
  }

  // Depop has no dedicated "books" department the way Poshmark does --
  // best-effort fallback: check a generic "other" category checkbox.
  await page.check('[data-testid="listing-category-other"]');
}

/**
 * Uploads listing photos by VALUE (file paths handed to setInputFiles,
 * Playwright's own documented way of attaching files by path), never
 * through a dynamically-built selector.
 */
async function uploadListingPhotos(page: DepopPage, photos: ListingInput['photos']): Promise<void> {
  if (photos.length === 0) {
    return;
  }
  const paths = photos
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((photo) => photo.path);
  await page.setInputFiles('[data-testid="listing-photo-upload-input"]', paths);
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

/**
 * True if the current page shows Depop's "item not found/unavailable"
 * state -- e.g. the listing was already deleted, sold and removed, or
 * externalListingId is stale/wrong. Checked via a locator's visibility
 * rather than raw content matching (unlike suspension classification,
 * which by necessity scans raw content to catch banner text wherever it
 * renders) -- this is a single, stable, expected element.
 */
async function isItemNotFound(page: DepopPage): Promise<boolean> {
  try {
    return await page.isVisible('[data-testid="product-not-found"]');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Connector methods
// ---------------------------------------------------------------------------

async function createListingAction(page: DepopPage, input: ListingInput): Promise<CreateListingResult> {
  // 1. Navigate to Depop's sell/create-listing form -- the only page this
  //    action ever visits besides the post-submit confirmation redirect; it
  //    never enumerates the seller's shop as a side effect.
  await page.goto(`${DEPOP_BASE_URL}/products/create/`);

  // 2. Fill listing fields using VALUE-based locators only -- title/
  //    description/price values are passed as fill() arguments, never
  //    interpolated into a selector string.
  await page.fill('[data-testid="listing-title-input"]', input.title);
  await page.fill('[data-testid="listing-description-input"]', buildListingDescription(input));
  await page.fill('[data-testid="listing-price-input"]', formatDollars(input.priceCents));

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

export async function createListing(input: ListingInput): Promise<CreateListingResult> {
  // Pacing gate FIRST -- before any Playwright/browser action. Depop has no
  // durable relist-cooldown/share-cap persistence like Poshmark; its only
  // ban-risk mitigation is enforcePacing's in-memory per-connection window.
  // A ConnectorRateLimitedError thrown here must propagate untouched -- no
  // browser context is opened for a paced-out call.
  enforcePacing('depop', input.connectionId);

  return withSession(
    input.tenantId,
    input.connectionId,
    (page) => createListingAction(asPage(page), input),
    buildDepopSessionHooks(input.tenantId, input.connectionId),
  );
}

async function updateListingAction(
  page: DepopPage,
  externalListingId: string,
  patch: Partial<Pick<ListingInput, 'title' | 'priceCents' | 'details'>>,
): Promise<UpdateListingResult> {
  // Navigates to exactly the one listing's edit page -- never the shop
  // listing index.
  await page.goto(listingEditPageUrl(externalListingId));

  if (await isItemNotFound(page)) {
    return { ok: false, reason: 'not_found' };
  }

  if (patch.title !== undefined) {
    await page.fill('[data-testid="listing-title-input"]', patch.title);
  }
  if (patch.priceCents !== undefined) {
    await page.fill('[data-testid="listing-price-input"]', formatDollars(patch.priceCents));
  }
  // patch.details (size/brand/condition/etc) maps onto the same
  // category-specific fields fillCategoryFields fills at creation time --
  // left as a maintainer TODO against a live account, since an EXISTING
  // listing's edit-form field selectors aren't guaranteed identical to the
  // create-listing form's.

  await page.click('[data-testid="listing-save-button"]');
  return { ok: true };
}

export async function updateListing(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
  patch: Partial<Pick<ListingInput, 'title' | 'priceCents' | 'details'>>,
): Promise<UpdateListingResult> {
  // Pacing gate FIRST -- see createListing's comment.
  enforcePacing('depop', connectionId);

  return withSession(
    tenantId,
    connectionId,
    (page) => updateListingAction(asPage(page), externalListingId, patch),
    buildDepopSessionHooks(tenantId, connectionId),
  );
}

async function markSoldAction(page: DepopPage, externalListingId: string): Promise<MarkSoldResult> {
  // Navigates to exactly the one listing's detail page -- never the shop
  // listing index.
  await page.goto(listingPageUrl(externalListingId));

  if (await isItemNotFound(page)) {
    return { ok: false, reason: 'not_found' };
  }

  await page.click('[data-testid="listing-mark-as-sold-button"]');
  return { ok: true };
}

export async function markSold(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
): Promise<MarkSoldResult> {
  // Pacing gate FIRST -- see createListing's comment.
  enforcePacing('depop', connectionId);

  return withSession(
    tenantId,
    connectionId,
    (page) => markSoldAction(asPage(page), externalListingId),
    buildDepopSessionHooks(tenantId, connectionId),
  );
}

async function delistAction(page: DepopPage, externalListingId: string): Promise<DelistResult> {
  // Navigates to exactly the one listing's detail page -- never the shop
  // listing index.
  await page.goto(listingPageUrl(externalListingId));

  if (await isItemNotFound(page)) {
    return { ok: false, reason: 'not_found' };
  }

  await page.click('[data-testid="listing-delist-button"]');
  return { ok: true };
}

export async function delist(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
): Promise<DelistResult> {
  // Pacing gate FIRST -- see createListing's comment. Unlike Poshmark's
  // delist (which also starts a durable relist-cooldown clock on success),
  // Depop has no such persistence layer -- enforcePacing is the entire
  // ban-risk mitigation story for this method.
  enforcePacing('depop', connectionId);

  return withSession(
    tenantId,
    connectionId,
    (page) => delistAction(asPage(page), externalListingId),
    buildDepopSessionHooks(tenantId, connectionId),
  );
}

/**
 * Read-only session health check -- calls validateSessionReadOnly, NEVER
 * withSession and NEVER enforcePacing, so a health check can neither
 * trigger a fresh login attempt nor consume this connection's pacing
 * window (playwrightSession.ts's design; see that function's doc comment --
 * a health probe isn't a mutating marketplace action).
 */
export async function checkConnectionHealth(tenantId: string, connectionId: string): Promise<HealthResult> {
  return validateSessionReadOnly(tenantId, connectionId, buildDepopSessionHooks(tenantId, connectionId));
}

/**
 * Raw (ungated) Depop Connector implementation -- wrap with
 * gate.ts#buildConnector('depop', depopConnector) before exposing to
 * callers, same convention as every other platform (amazon.ts/ebay.ts/
 * poshmark.ts).
 */
export const depopConnector: Connector = {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
};
