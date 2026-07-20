import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { assertCanAutomate } from '@/lib/automationGate';
import {
  withSession,
  validateSessionReadOnly,
  buildSessionHooks,
  fillClothingFields,
  uploadSortedPhotos,
  isElementVisible,
  type SessionHooks,
  type PlaywrightPageLike,
} from '@/lib/connectors/playwrightSession';
import {
  POSHMARK_RELIST_COOLDOWN_DAYS,
  POSHMARK_SHARE_CAP_PER_24H,
  assertCategorySupported,
} from '@/lib/constants';
import type { ClothingDetails, ElectronicsDetails } from '@/lib/types';
import {
  ConnectorGatingError,
  PoshmarkCooldownError,
  type Connector,
  type ListingInput,
  type CreateListingResult,
  type UpdateListingResult,
  type MarkSoldResult,
  type DelistResult,
  type HealthResult,
} from '@/lib/connectors/types';
import { buildListingDescription, formatPriceDollars } from '@/lib/connectors/listingContent';

// Poshmark connector -- durable ban-risk mitigation persistence layer
// (checkRelistCooldown/recordDelistEvent/checkShareCap/recordShareEvent,
// Task 14a) PLUS the 5 shared Connector methods (createListing/
// updateListing/markSold/delist/checkConnectionHealth) that drive Poshmark
// via lib/connectors/playwrightSession.ts's shared Playwright session
// harness (this task). `sharePoshmarkListing` below (the Poshmark-only 6th
// method, outside the Connector interface) still has the deliberate no-op
// placeholder where a future task's real "click share" interaction plugs
// in -- out of scope for this increment, which only wires up the 5 shared
// Connector methods.
//
// data/migrations/010_poshmark_pacing.sql's two event tables back these
// thresholds with durable (SQLite, not in-memory) state -- unlike
// lib/connectors/pacing.ts's in-memory rate limiter for the no-published-
// policy platforms, a 60-day relist cooldown must survive process restarts
// to mean anything. Thresholds themselves are lib/constants.ts's
// POSHMARK_RELIST_COOLDOWN_DAYS (60) and POSHMARK_SHARE_CAP_PER_24H (3500),
// grounded in Poshmark's documented policy.

/**
 * lib/automationGate.ts#assertCanAutomate's real, already-shipped contract
 * returns one of three reasons -- 'not_found' (connection doesn't exist /
 * wrong tenant), 'not_active' (suspended or revoked), or 'consent_required'.
 * Mirrors lib/connectors/gate.ts#toGatingKind's mapping exactly (both
 * connection-shaped failures collapse onto 'connection_not_active';
 * 'consent_required' maps onto 'missing_consent') so a Poshmark-specific
 * gating failure surfaces the same ConnectorGatingError kind a caller would
 * see from any other platform's gated method. Not imported from gate.ts --
 * that function isn't exported, and sharePoshmarkListing sits outside the
 * shared 5-method Connector interface entirely (buildConnector never wraps
 * it), so it must perform this check itself rather than relying on gate.ts.
 */
function toGatingKind(
  reason: 'not_found' | 'not_active' | 'consent_required',
): 'missing_consent' | 'connection_not_active' {
  return reason === 'consent_required' ? 'missing_consent' : 'connection_not_active';
}

/**
 * True if a relist for this connection+item should be BLOCKED -- i.e. the
 * item's most recent recorded delist happened fewer than
 * POSHMARK_RELIST_COOLDOWN_DAYS days ago. No poshmark_delist_events row at
 * all for this (connection_id, item_id) pair -- the item was never delisted
 * through this connection, or delists aren't tracked for it -- means no
 * cooldown applies: returns false (allow).
 */
export function checkRelistCooldown(connectionId: string, itemId: string): boolean {
  const row = db
    .prepare(
      `SELECT MAX(delisted_at) AS last_delisted_at
       FROM poshmark_delist_events
       WHERE connection_id = ? AND item_id = ?`,
    )
    .get(connectionId, itemId) as { last_delisted_at: string | null } | undefined;

  if (!row?.last_delisted_at) {
    return false;
  }

  // last_delisted_at is still inside the cooldown window (i.e. fewer than
  // POSHMARK_RELIST_COOLDOWN_DAYS days have elapsed since it) exactly when
  // it is at or after "now minus the cooldown window" -- computed in SQL
  // (not JS Date math) so the comparison uses the same datetime()
  // arithmetic/format as the CHECK constraint on the column itself.
  const result = db
    .prepare(`SELECT (? >= datetime('now', ?)) AS blocked`)
    .get(row.last_delisted_at, `-${POSHMARK_RELIST_COOLDOWN_DAYS} days`) as { blocked: number };

  return result.blocked === 1;
}

/**
 * Record that an item was delisted through a Poshmark connection, starting
 * (or restarting) its POSHMARK_RELIST_COOLDOWN_DAYS relist cooldown. Called
 * by the Playwright action layer's `delist` method (follow-up task) the
 * moment a delist is confirmed against the real platform.
 */
export function recordDelistEvent(tenantId: string, connectionId: string, itemId: string): void {
  db.prepare(
    `INSERT INTO poshmark_delist_events (id, tenant_id, connection_id, item_id)
     VALUES (?, ?, ?, ?)`,
  ).run(uuidv4(), tenantId, connectionId, itemId);
}

/**
 * True if a share for this connection should be BLOCKED -- i.e. it has
 * already recorded POSHMARK_SHARE_CAP_PER_24H or more shares within the
 * trailing 24 hours.
 */
export function checkShareCap(connectionId: string): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM poshmark_share_events
       WHERE connection_id = ? AND shared_at >= datetime('now', '-24 hours')`,
    )
    .get(connectionId) as { count: number };

  return row.count >= POSHMARK_SHARE_CAP_PER_24H;
}

/**
 * Record that a share action was taken for a Poshmark connection, counting
 * against its trailing-24h POSHMARK_SHARE_CAP_PER_24H budget.
 */
export function recordShareEvent(tenantId: string, connectionId: string): void {
  db.prepare(
    `INSERT INTO poshmark_share_events (id, tenant_id, connection_id)
     VALUES (?, ?, ?)`,
  ).run(uuidv4(), tenantId, connectionId);
}

/**
 * Share a Poshmark listing to boost its visibility in the feed ("Share to
 * followers" / community sharing) -- a Poshmark-only action with no
 * equivalent on any other platform, which is why it lives here as a 6th
 * method rather than on the shared Connector interface
 * (lib/connectors/types.ts). Because it's outside that interface,
 * lib/connectors/gate.ts's buildConnector never wraps it -- this function
 * is therefore its own choke point and must call assertCanAutomate directly
 * (mirroring gate.ts's assertGateOrThrow) before doing anything else.
 *
 * Order of checks, both fail-closed:
 *   1. assertCanAutomate -- same consent/connection-status gate every other
 *      mutating connector call goes through. Throws ConnectorGatingError.
 *   2. checkShareCap -- the durable, per-connection trailing-24h share
 *      budget. Throws PoshmarkCooldownError('share_cap', ...).
 *
 * Only once both pass does this record the share event and hand off to the
 * real platform action. No real Playwright "click share" implementation
 * exists yet -- that's a follow-up task working on this same file -- so the
 * actual platform interaction below is a deliberate no-op placeholder.
 */
export async function sharePoshmarkListing(
  tenantId: string,
  connectionId: string,
  itemId: string,
): Promise<void> {
  const gate = assertCanAutomate(tenantId, connectionId);
  if (!gate.ok) {
    throw new ConnectorGatingError(toGatingKind(gate.reason), connectionId);
  }

  if (checkShareCap(connectionId)) {
    throw new PoshmarkCooldownError('share_cap', connectionId);
  }

  recordShareEvent(tenantId, connectionId);

  // TODO(follow-up task, same file): the real Playwright interaction that
  // actually clicks "share" on `itemId`'s Poshmark listing plugs in here.
  // Nothing to do yet -- gating and the share cap have both already been
  // enforced above, and the event has been durably recorded, so this
  // increment's contract (persist + gate correctly) is already satisfied.
  void itemId;
}

// ---------------------------------------------------------------------------
// Playwright action layer -- the 5 raw `Connector` methods.
//
// Every one of createListing/updateListing/markSold/delist drives (or, in
// dry-run mode, is transparently skipped by -- see playwrightSession.ts's
// own doc comments) a real logged-in Poshmark browser session via
// withSession(); checkConnectionHealth is read-only and uses
// validateSessionReadOnly() instead, which NEVER attempts a fresh login.
//
// No live Poshmark seller account exists to verify selectors against in
// this increment, so every selector/DOM check below is a best-effort,
// clearly-commented approximation of Poshmark's real create-listing/
// closet/listing-edit pages -- a concrete starting shape for a maintainer
// with real account access to correct, not a placeholder no-op.
//
// Selector safety: every locator below is a stable, literal data-testid
// string -- listing content (title/description/price/etc) only ever flows
// into Playwright's VALUE-based APIs (`fill`/`check`/`setInputFiles`),
// never interpolated into a selector string.
//
// No over-scraping: each method navigates to exactly the one page its
// action needs -- the create-listing form, or a single listing's
// detail/edit page keyed by externalListingId -- never the tenant's full
// closet listing index.
// ---------------------------------------------------------------------------

/**
 * `page` is typed `unknown` by withSession/validateSessionReadOnly (see
 * playwrightSession.ts) -- cast to the shared PlaywrightPageLike shape at
 * the point of use via `asPage()` below, rather than redeclaring the same
 * Page-subset interface in every connector file.
 */
function asPage(page: unknown): PlaywrightPageLike {
  return page as PlaywrightPageLike;
}

const POSHMARK_BASE_URL = 'https://poshmark.com';

/**
 * True if the current page looks like an authenticated Poshmark seller
 * view (closet/dashboard chrome visible), rather than a login/signin
 * redirect. Real selector TBD against a live account -- placeholder checks
 * for a "My Closet" nav element assumed to exist on Poshmark's
 * authenticated header. Any failure reading the page (closed page,
 * navigation error) is treated as "not authenticated" rather than thrown,
 * matching playwrightSession.ts's SessionHooks#validateSession contract
 * (a boolean, never a throw).
 */
async function isAuthenticatedPoshmarkSession(page: PlaywrightPageLike): Promise<boolean> {
  try {
    return await page.isVisible('[data-testid="closet-nav-link"]');
  } catch {
    return false;
  }
}

/**
 * Poshmark login flow -- exactly one navigate+submit attempt, invoked by
 * withSession() only when the persisted session fails validation.
 * validateSessionReadOnly() never calls this (see playwrightSession.ts).
 * Fills the credential VALUE only, never interpolated into a selector.
 *
 * NOTE: this increment's credential payload (playwrightSession.ts's
 * PlaywrightCredentialPayload) only threads through a single `credential`
 * string, matching every other Playwright-driven connector's
 * SessionHooks#performLogin contract. A maintainer wiring this against a
 * live Poshmark account will also need a login-identifier (username/email)
 * field on the stored credential to fill the login form's first input --
 * not modeled here since no connection payload carries one yet.
 */
async function performPoshmarkLogin(page: unknown, credential: string): Promise<void> {
  const p = asPage(page);
  await p.goto(`${POSHMARK_BASE_URL}/login`);
  await p.fill('[data-testid="login-form-password-input"]', credential);
  await p.click('[data-testid="login-form-submit-button"]');
  await p.waitForSelector('[data-testid="closet-nav-link"]', { timeout: 15000 }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Suspension classification
// ---------------------------------------------------------------------------

/**
 * Best-effort, documented-as-such text patterns Poshmark is known to show
 * on a deactivated/suspended/restricted account. Matched against raw page
 * content (not a specific selector) since the exact banner markup for this
 * state hasn't been verified against a live account in this increment -- a
 * maintainer with account access should replace this with a real selector
 * check once one is confirmed. Deliberately narrow: generic error/timeout
 * text must NOT match here, or a transient navigation hiccup would wrongly
 * suspend a healthy connection.
 */
const POSHMARK_SUSPENSION_PATTERNS: RegExp[] = [
  /account\s+has\s+been\s+deactivated/i,
  /your\s+account\s+(?:is|has\s+been)\s+(?:temporarily\s+)?restricted/i,
  /account\s+has\s+been\s+suspended/i,
  /violat(?:ed|ion)s?\s+of\s+(?:our|poshmark'?s)\s+polic/i,
];

/**
 * Returns a short, non-secret classification reason if `pageContent`
 * matches a known Poshmark suspension/restriction banner, or null
 * otherwise -- including for ambiguous/transient content (a timeout page,
 * a generic error, empty content), which must NEVER be classified as a
 * suspension.
 */
export function classifyPoshmarkSuspension(pageContent: string): string | null {
  if (!pageContent) {
    return null;
  }
  const match = POSHMARK_SUSPENSION_PATTERNS.find((pattern) => pattern.test(pageContent));
  return match ? `poshmark account restriction detected (matched pattern: ${match.source})` : null;
}

/**
 * Builds the SessionHooks passed to every withSession/validateSessionReadOnly
 * call this file makes -- delegates the actual validateSession/performLogin
 * composition (and the suspension check riding along with validateSession)
 * to playwrightSession.ts#buildSessionHooks, shared by every Playwright-
 * driven connector; only isAuthenticatedPoshmarkSession/
 * performPoshmarkLogin/classifyPoshmarkSuspension are Poshmark-specific.
 */
function buildPoshmarkSessionHooks(tenantId: string, connectionId: string): SessionHooks {
  return buildSessionHooks(tenantId, connectionId, {
    isAuthenticated: isAuthenticatedPoshmarkSession,
    performLogin: performPoshmarkLogin,
    classifySuspension: classifyPoshmarkSuspension,
  });
}

// ---------------------------------------------------------------------------
// Listing content helpers
// ---------------------------------------------------------------------------

/**
 * Fills Poshmark's category-specific fields (brand/size/color for
 * clothing, department for books, brand/model/processor/ram/storage/
 * screen-size/battery-health/battery-cycle-count/condition for
 * electronics). Real Poshmark category-picker selectors are a multi-step
 * dropdown/typeahead flow not modeled in detail here -- documented as the
 * maintainer's next step against a live account; this best-effort version
 * fills the fields the create-listing form is known to expose as plain
 * inputs. The remaining electronics spec fields (processor/ram/storage/
 * screen size/battery health/cycle count) also ride along in the free-text
 * description via buildListingDescription, same convention as
 * swappa.ts#fillDeviceSpecFields.
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
    const d = input.details as ElectronicsDetails;
    await page.fill('[data-testid="listing-brand-input"]', d.brand);
    await page.fill('[data-testid="listing-model-input"]', d.model);
    if (d.processor) {
      await page.fill('[data-testid="listing-processor-input"]', d.processor);
    }
    if (d.ram_gb != null) {
      await page.fill('[data-testid="listing-ram-input"]', String(d.ram_gb));
    }
    if (d.storage_gb != null) {
      await page.fill('[data-testid="listing-storage-input"]', String(d.storage_gb));
    }
    if (d.screen_size_in != null) {
      await page.fill('[data-testid="listing-screen-size-input"]', String(d.screen_size_in));
    }
    if (d.battery_health_pct != null) {
      await page.fill('[data-testid="listing-battery-health-input"]', String(d.battery_health_pct));
    }
    if (d.battery_cycle_count != null) {
      await page.fill('[data-testid="listing-battery-cycle-count-input"]', String(d.battery_cycle_count));
    }
    await page.fill('[data-testid="listing-condition-input"]', d.condition);
    return;
  }

  await page.check('[data-testid="listing-department-books"]');
}

/**
 * Uploads listing photos -- delegates the sort/path-extraction/
 * setInputFiles plumbing to playwrightSession.ts#uploadSortedPhotos,
 * shared by every photo-uploading connector; only the selector is
 * Poshmark-specific.
 */
async function uploadListingPhotos(page: PlaywrightPageLike, photos: ListingInput['photos']): Promise<void> {
  await uploadSortedPhotos(page, photos, '[data-testid="listing-photo-upload-input"]');
}

/**
 * Poshmark listing URLs are shaped
 * https://poshmark.com/listing/<title-slug>-<listingId> -- the id is the
 * last hyphen-delimited segment. Best-effort/documented shape, not
 * confirmed against a live account.
 */
function extractListingIdFromUrl(url: string): string | null {
  const match = url.match(/\/listing\/[^/]*-([a-zA-Z0-9]+)\/?$/);
  return match ? match[1] : null;
}

function listingPageUrl(externalListingId: string): string {
  return `${POSHMARK_BASE_URL}/listing/${externalListingId}`;
}

function listingEditPageUrl(externalListingId: string): string {
  return `${POSHMARK_BASE_URL}/listing/${externalListingId}/edit`;
}

/**
 * True if the current page shows Poshmark's "item not found in your
 * closet" state -- e.g. the listing was already deleted, or
 * externalListingId is stale/wrong. Checked via a locator's visibility
 * rather than raw content matching (unlike suspension classification,
 * which by necessity scans raw content to catch banner text wherever it
 * renders) -- this is a single, stable, expected element.
 */
async function isItemNotFound(page: PlaywrightPageLike): Promise<boolean> {
  return isElementVisible(page, '[data-testid="listing-not-found"]');
}

/**
 * Reverse lookup from a Poshmark external_listing_id back to this app's
 * internal item id, via item_platforms' UNIQUE(platform,
 * external_listing_id) index (009_item_platforms_external_id.sql).
 * delist()'s Connector signature (types.ts) only receives
 * externalListingId -- gate.ts's buildConnector wrapper is what wrote this
 * row in the first place, off the original createListing call's
 * input.itemId, so this is the one durable place to recover it from for
 * recordDelistEvent's cooldown bookkeeping. No matching row (the mapping
 * was never recorded, or belongs to a different tenant) means the cooldown
 * simply can't be tracked for this delist -- silently skipped rather than
 * thrown, since the delist itself already succeeded on the real platform.
 */
function lookupItemIdForListing(tenantId: string, externalListingId: string): string | null {
  const row = db
    .prepare(
      `SELECT item_id FROM item_platforms
       WHERE platform = 'poshmark' AND external_listing_id = ? AND tenant_id = ?`,
    )
    .get(externalListingId, tenantId) as { item_id: string } | undefined;
  return row?.item_id ?? null;
}

// ---------------------------------------------------------------------------
// Connector methods
// ---------------------------------------------------------------------------

async function createListingAction(page: PlaywrightPageLike, input: ListingInput): Promise<CreateListingResult> {
  // 1. Navigate to Poshmark's "Sell"/create-listing form -- the only page
  //    this action ever visits besides the post-submit confirmation
  //    redirect; it never enumerates the seller's closet as a side effect.
  await page.goto(`${POSHMARK_BASE_URL}/create-listing`);

  // 2. Fill listing fields using VALUE-based locators only -- title/
  //    description/price values are passed as fill() arguments, never
  //    interpolated into a selector string.
  await page.fill('[data-testid="listing-title-input"]', input.title);
  await page.fill('[data-testid="listing-description-input"]', buildListingDescription(input));
  await page.fill('[data-testid="listing-price-input"]', formatPriceDollars(input.priceCents));

  // 3. Category-specific fields (size/brand for clothing, department for
  //    books).
  await fillCategoryFields(page, input);

  // 4. Photos -- Poshmark requires at least one image.
  await uploadListingPhotos(page, input.photos);

  // 5. Submit.
  await page.click('[data-testid="list-item-submit-button"]');
  await page.waitForURL(/\/listing\//).catch(() => undefined);

  // 6. Extract the new listing id from the resulting URL. Falls back to
  //    this app's own itemId only if the URL couldn't be parsed -- a
  //    best-effort safety net, not the expected path.
  const externalListingId = extractListingIdFromUrl(page.url()) ?? input.itemId;

  return { externalListingId };
}

export async function createListing(input: ListingInput): Promise<CreateListingResult> {
  // Category-rejection-as-first-statement -- before any cooldown, session,
  // or Playwright logic. Poshmark's PLATFORM_CATEGORY_SUPPORT entry
  // (lib/constants.ts) is `['book', 'clothing', 'electronics']`, so this is
  // the shared guard confirming support -- not a rejection for this
  // platform -- and still must run before anything else per the
  // shared-connector convention every platform's createListing follows.
  assertCategorySupported('poshmark', input.category);

  // Cooldown gate NEXT -- before any Playwright/browser action. A relist
  // attempt within POSHMARK_RELIST_COOLDOWN_DAYS of this item's last
  // recorded delist on this connection must never even open a browser.
  if (checkRelistCooldown(input.connectionId, input.itemId)) {
    throw new PoshmarkCooldownError('relist_cooldown', input.connectionId);
  }

  return withSession(
    input.tenantId,
    input.connectionId,
    (page) => createListingAction(asPage(page), input),
    buildPoshmarkSessionHooks(input.tenantId, input.connectionId),
  );
}

async function updateListingAction(
  page: PlaywrightPageLike,
  externalListingId: string,
  patch: Partial<Pick<ListingInput, 'title' | 'priceCents' | 'details'>>,
): Promise<UpdateListingResult> {
  // Navigates to exactly the one listing's edit page -- never the closet
  // listing index.
  await page.goto(listingEditPageUrl(externalListingId));

  if (await isItemNotFound(page)) {
    return { ok: false, reason: 'not_found' };
  }

  if (patch.title !== undefined) {
    await page.fill('[data-testid="listing-title-input"]', patch.title);
  }
  if (patch.priceCents !== undefined) {
    await page.fill('[data-testid="listing-price-input"]', formatPriceDollars(patch.priceCents));
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
  return withSession(
    tenantId,
    connectionId,
    (page) => updateListingAction(asPage(page), externalListingId, patch),
    buildPoshmarkSessionHooks(tenantId, connectionId),
  );
}

async function markSoldAction(page: PlaywrightPageLike, externalListingId: string): Promise<MarkSoldResult> {
  // Navigates to exactly the one listing's detail page -- never the closet
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
  return withSession(
    tenantId,
    connectionId,
    (page) => markSoldAction(asPage(page), externalListingId),
    buildPoshmarkSessionHooks(tenantId, connectionId),
  );
}

async function delistAction(page: PlaywrightPageLike, externalListingId: string): Promise<DelistResult> {
  // Navigates to exactly the one listing's detail page -- never the closet
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
  const result = await withSession(
    tenantId,
    connectionId,
    (page) => delistAction(asPage(page), externalListingId),
    buildPoshmarkSessionHooks(tenantId, connectionId),
  );

  // Only start the relist cooldown once the delist actually succeeded --
  // lookupItemIdForListing silently no-ops recordDelistEvent when the
  // item_id can't be recovered (see that function's doc comment).
  if (result.ok) {
    const itemId = lookupItemIdForListing(tenantId, externalListingId);
    if (itemId) {
      recordDelistEvent(tenantId, connectionId, itemId);
    }
  }

  return result;
}

/**
 * Read-only session health check -- calls validateSessionReadOnly, NEVER
 * withSession, so a health check can never trigger a fresh login attempt
 * (playwrightSession.ts's design; see that function's doc comment).
 */
export async function checkConnectionHealth(tenantId: string, connectionId: string): Promise<HealthResult> {
  return validateSessionReadOnly(tenantId, connectionId, buildPoshmarkSessionHooks(tenantId, connectionId));
}

/**
 * Raw (ungated) Poshmark Connector implementation -- wrap with
 * gate.ts#buildConnector('poshmark', poshmarkConnector) before exposing to
 * callers, same convention as every other platform (amazon.ts/ebay.ts/
 * etsy.ts).
 */
export const poshmarkConnector: Connector = {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
};
