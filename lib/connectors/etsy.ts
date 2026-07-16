import type { BookDetails, ClothingDetails } from '@/lib/types';
import { getDecryptedCredential, recordSuspensionSignal } from '@/lib/connections';
import { requireEnv } from './envConfig';
import { getFreshAccessToken } from './apiCredential';
import { apiFetch } from './apiFetch';
import { scrubSecrets } from './scrub';
import {
  ConnectorPlatformError,
  type Connector,
  type ListingInput,
  type CreateListingResult,
  type UpdateListingResult,
  type MarkSoldResult,
  type DelistResult,
  type HealthResult,
} from './types';

// Etsy Open API v3 connector -- RAW (ungated) implementation. Gating
// (consent/connection-status checks via lib/automationGate.ts) is applied by
// gate.ts/registry.ts wrapping this connector, not here -- see ebay.ts /
// gate.ts for the same split.
//
// Etsy's real authorization flow is OAuth 2.0 Authorization Code Grant +
// PKCE. No tenant has a real Etsy account/authorization yet, so -- exactly
// like ebay.ts's OAuth portion -- this connector only implements the
// refresh_token grant (etsyExchangeFn below, wired into getFreshAccessToken).
// The PKCE code_verifier is only needed for the INITIAL authorization-code
// exchange, which has no UI/auth-flow-initiation this increment and is out
// of scope here.
//
// SAFETY-CRITICAL INVARIANT: Etsy has no sandbox environment. A listing
// created/updated through this connector against the real API is a real,
// live, publicly visible listing the moment its `state` is "active". Every
// write in this file that sets `state` therefore hardcodes the literal
// "draft" and must NEVER be changed to "active" -- draft is the only thing
// standing between this connector and a real public listing.

const ETSY_API_BASE_URL = 'https://api.etsy.com/v3';
const ETSY_TOKEN_URL = `${ETSY_API_BASE_URL}/public/oauth/token`;
const ETSY_APPLICATION_BASE_URL = `${ETSY_API_BASE_URL}/application`;

interface EtsyOAuthTokenResponse {
  access_token: string;
  expires_in: number; // seconds
  refresh_token?: string;
  token_type: string;
}

/**
 * Exchange a stored refresh token for a fresh Etsy access token via the
 * OAuth2 refresh_token grant against Etsy's public token endpoint.
 * Signature matches what getFreshAccessToken() expects for its exchangeFn
 * parameter -- same shape as ebay.ts's ebayExchangeFn.
 */
async function etsyExchangeFn(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}> {
  const apiKey = requireEnv('etsy', 'ETSY_API_KEY');
  const sharedSecret = requireEnv('etsy', 'ETSY_SHARED_SECRET');

  const basicAuth = Buffer.from(`${apiKey}:${sharedSecret}`).toString('base64');

  // apiFetch always JSON-serializes `body` (see apiFetch.ts) rather than
  // form-encoding it. Real Etsy OAuth2 token endpoints conventionally expect
  // application/x-www-form-urlencoded, but there are no live credentials to
  // validate against yet and the unit tests mock apiFetch entirely, so the
  // grant parameters go through apiFetch's existing shared JSON contract
  // rather than hand-rolling a second body-encoding path here -- same
  // tradeoff ebay.ts's ebayExchangeFn documents.
  const result = await apiFetch(ETSY_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'x-api-key': apiKey,
    },
    body: {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: apiKey,
    },
    timeoutMs: 10_000,
  });

  if (!result.ok) {
    throw new ConnectorPlatformError(
      'etsy',
      `oauth_${result.status}`,
      scrubSecrets(
        `Etsy OAuth token exchange failed with status ${result.status}: ${safeStringify(result.body)}`,
        [apiKey, sharedSecret, refreshToken],
      ),
    );
  }

  const parsed = result.body as EtsyOAuthTokenResponse;
  if (!parsed || typeof parsed.access_token !== 'string' || typeof parsed.expires_in !== 'number') {
    throw new ConnectorPlatformError(
      'etsy',
      'oauth_bad_response',
      'Etsy OAuth token exchange returned an unexpected response shape',
    );
  }

  return {
    accessToken: parsed.access_token,
    expiresAt: Date.now() + parsed.expires_in * 1000,
    refreshToken: parsed.refresh_token,
  };
}

/**
 * Return a valid Etsy access token for the given tenant/connection,
 * refreshing via etsyExchangeFn when the stored token is expired or
 * near-expiry.
 */
async function getEtsyAccessToken(tenantId: string, connectionId: string): Promise<string> {
  return getFreshAccessToken(tenantId, connectionId, etsyExchangeFn);
}

// ---------------------------------------------------------------------------
// shop_id resolution
// ---------------------------------------------------------------------------

/**
 * Etsy's create/update-listing endpoints are shop-scoped
 * (/shops/{shop_id}/listings). In Etsy's real flow, shop_id is discovered
 * from the authorizing user during the initial authorization-code exchange
 * -- which isn't implemented in this increment (see file header). There is
 * no platform_account_id-shaped field on lib/connections.ts's
 * ConnectionMetadata to reuse (checked: it only carries
 * id/platform/status/lastVerifiedAt/createdAt/updatedAt), and credentials
 * are already an arbitrary per-connection JSON blob, so as an interim
 * convention this reads an optional `shopId` field off the SAME stored
 * credential object apiCredential.ts already uses
 * ({accessToken, expiresAt, refreshToken, shopId}).
 *
 * TODO(real-etsy-auth): once the authorization-code+PKCE flow is
 * implemented, populate shopId there (e.g. from Etsy's /users/me lookup at
 * connect time) instead of expecting it to already be present here.
 */
function getEtsyShopId(tenantId: string, connectionId: string): string {
  const stored = getDecryptedCredential(tenantId, connectionId) as
    | { shopId?: unknown }
    | null
    | undefined;

  const shopId = stored?.shopId;
  if (typeof shopId !== 'string' || shopId.length === 0) {
    throw new ConnectorPlatformError(
      'etsy',
      'shop_id_unresolved',
      `Connection ${connectionId} has no shopId on its stored credential -- cannot resolve the shop-scoped Etsy endpoint (see getEtsyShopId TODO)`,
    );
  }
  return shopId;
}

// ---------------------------------------------------------------------------
// Suspension classification (best-effort heuristic)
// ---------------------------------------------------------------------------

// Real Etsy error codes/messages for account/shop suspension aren't
// verifiable without a live suspended account, so this is a best-effort
// heuristic pending real API verification: a 403 whose error text mentions
// one of these phrases is treated as a suspension signal. A plain 401
// (expired/invalid token -- already handled by the OAuth refresh path) and
// any 5xx/429/timeout are NEVER classified as suspension.
const SUSPENSION_INDICATOR_PATTERNS = [
  'shop is inactive',
  'shop_inactive',
  'account suspended',
  'account_suspended',
  'unauthorized_shop',
  'shop is suspended',
  'shop_suspended',
  'seller account is disabled',
];

function extractErrorText(body: unknown): string {
  if (typeof body === 'string') {
    return body;
  }
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    return [obj.error, obj.error_code, obj.message, obj.error_description]
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
  }
  return '';
}

/**
 * Best-effort classification of an Etsy error response as an
 * account/shop-suspension signal. See SUSPENSION_INDICATOR_PATTERNS comment
 * above -- this heuristic is not verified against a real suspended Etsy
 * account and should be tightened once real API behavior is known.
 */
export function isEtsySuspensionSignal(status: number, body: unknown): boolean {
  if (status !== 403) {
    // 401 = likely just an expired/invalid token (handled by refresh path);
    // 5xx/429/timeout = transient, never a suspension signal.
    return false;
  }
  const text = extractErrorText(body).toLowerCase();
  return SUSPENSION_INDICATOR_PATTERNS.some((pattern) => text.includes(pattern));
}

function classifySuspensionReason(body: unknown): string {
  const text = extractErrorText(body).toLowerCase();
  if (text.includes('unauthorized_shop')) return 'etsy_403_unauthorized_shop';
  if (text.includes('inactive')) return 'etsy_403_shop_inactive';
  if (text.includes('suspend')) return 'etsy_403_account_suspended';
  return 'etsy_403_suspected_suspension';
}

async function maybeRecordSuspension(
  tenantId: string,
  connectionId: string,
  status: number,
  body: unknown,
  secrets: (string | undefined | null)[],
): Promise<void> {
  if (!isEtsySuspensionSignal(status, body)) {
    return;
  }
  const reason = scrubSecrets(classifySuspensionReason(body), secrets);
  recordSuspensionSignal(tenantId, connectionId, reason, 'suspended');
}

// ---------------------------------------------------------------------------
// Error / not-found helpers
// ---------------------------------------------------------------------------

function safeStringify(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function isNotFoundResponse(status: number, body: unknown): boolean {
  if (status === 404) {
    return true;
  }
  const text = extractErrorText(body).toLowerCase();
  return text.includes('not found') || text.includes('no listing') || text.includes('does not exist');
}

function platformError(
  code: string,
  status: number,
  body: unknown,
  secrets: (string | undefined | null)[],
): ConnectorPlatformError {
  const raw = `Etsy request failed with status ${status}: ${safeStringify(body)}`;
  return new ConnectorPlatformError('etsy', code, scrubSecrets(raw, secrets));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Listing payload construction
// ---------------------------------------------------------------------------

function buildDescription(input: ListingInput): string {
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
 * Builds the create-listing request payload. Full Etsy-required-field
 * mapping (who_made/when_made/taxonomy_id/shipping profile/etc.) is out of
 * scope for this increment -- the safety-critical field is `state`, which
 * is ALWAYS the literal "draft" here. Never wire this up to accept
 * "active" from any input/patch.
 */
function buildCreatePayload(input: ListingInput): Record<string, unknown> {
  return {
    quantity: 1,
    title: input.title,
    description: buildDescription(input),
    price: input.priceCents / 100,
    state: 'draft', // CRITICAL: never "active" -- see file header.
  };
}

// ---------------------------------------------------------------------------
// Connector methods
// ---------------------------------------------------------------------------

export async function createListing(input: ListingInput): Promise<CreateListingResult> {
  const apiKey = requireEnv('etsy', 'ETSY_API_KEY');
  const accessToken = await getEtsyAccessToken(input.tenantId, input.connectionId);
  const shopId = getEtsyShopId(input.tenantId, input.connectionId);

  const body = buildCreatePayload(input);

  const result = await apiFetch(`${ETSY_APPLICATION_BASE_URL}/shops/${shopId}/listings`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      Authorization: `Bearer ${accessToken}`,
    },
    body,
  });

  if (!result.ok) {
    await maybeRecordSuspension(input.tenantId, input.connectionId, result.status, result.body, [
      apiKey,
      accessToken,
    ]);
    throw platformError(`create_${result.status}`, result.status, result.body, [apiKey, accessToken]);
  }

  const parsed = result.body as { listing_id?: number | string };
  if (parsed?.listing_id === undefined || parsed.listing_id === null) {
    throw new ConnectorPlatformError(
      'etsy',
      'create_bad_response',
      'Etsy create-listing response did not include a listing_id',
    );
  }

  return { externalListingId: String(parsed.listing_id) };
}

export async function updateListing(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
  patch: Partial<Pick<ListingInput, 'title' | 'priceCents' | 'details'>>,
): Promise<UpdateListingResult> {
  const apiKey = requireEnv('etsy', 'ETSY_API_KEY');
  const accessToken = await getEtsyAccessToken(tenantId, connectionId);
  const shopId = getEtsyShopId(tenantId, connectionId);

  // CRITICAL: state is always "draft" here too -- an update must never be
  // able to flip a listing to "active", so this is a hardcoded literal, not
  // derived from `patch` (patch has no `state` field in its type anyway).
  const body: Record<string, unknown> = { state: 'draft' };
  if (patch.title !== undefined) {
    body.title = patch.title;
  }
  if (patch.priceCents !== undefined) {
    body.price = patch.priceCents / 100;
  }

  const result = await apiFetch(
    `${ETSY_APPLICATION_BASE_URL}/shops/${shopId}/listings/${externalListingId}`,
    {
      method: 'PATCH',
      headers: {
        'x-api-key': apiKey,
        Authorization: `Bearer ${accessToken}`,
      },
      body,
    },
  );

  if (result.ok) {
    return { ok: true };
  }

  if (isNotFoundResponse(result.status, result.body)) {
    return { ok: false, reason: 'not_found' };
  }

  await maybeRecordSuspension(tenantId, connectionId, result.status, result.body, [apiKey, accessToken]);
  throw platformError(`update_${result.status}`, result.status, result.body, [apiKey, accessToken]);
}

/**
 * Shared implementation for markSold/delist's "change the draft listing's
 * state without ever activating it" pattern. `state` is a fixed internal
 * literal supplied only by the two callers below (never caller-controlled
 * input), so there is no path for this to ever send "active".
 */
async function transitionDraftListingState(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
  state: 'inactive',
  opCode: string,
): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
  const apiKey = requireEnv('etsy', 'ETSY_API_KEY');
  const accessToken = await getEtsyAccessToken(tenantId, connectionId);
  const shopId = getEtsyShopId(tenantId, connectionId);

  const result = await apiFetch(
    `${ETSY_APPLICATION_BASE_URL}/shops/${shopId}/listings/${externalListingId}`,
    {
      method: 'PATCH',
      headers: {
        'x-api-key': apiKey,
        Authorization: `Bearer ${accessToken}`,
      },
      body: { state },
    },
  );

  if (result.ok) {
    return { ok: true };
  }

  if (isNotFoundResponse(result.status, result.body)) {
    return { ok: false, reason: 'not_found' };
  }

  await maybeRecordSuspension(tenantId, connectionId, result.status, result.body, [apiKey, accessToken]);
  throw platformError(`${opCode}_${result.status}`, result.status, result.body, [apiKey, accessToken]);
}

/**
 * Etsy has no seller-settable "sold" state -- items go to sold_out via real
 * purchases. This connector only ever operates on its own draft-state
 * listings (no live activation happens in this increment), so "mark sold"
 * is modeled as transitioning the draft listing to "inactive" -- the
 * closest state Etsy exposes for "no longer available," reachable without
 * ever passing through "active". TODO(real-etsy-auth): revisit once a real
 * authorized shop with live listings exists.
 */
export async function markSold(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
): Promise<MarkSoldResult> {
  return transitionDraftListingState(externalListingId, tenantId, connectionId, 'inactive', 'mark_sold');
}

export async function delist(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
): Promise<DelistResult> {
  const apiKey = requireEnv('etsy', 'ETSY_API_KEY');
  const accessToken = await getEtsyAccessToken(tenantId, connectionId);
  const shopId = getEtsyShopId(tenantId, connectionId);

  const result = await apiFetch(
    `${ETSY_APPLICATION_BASE_URL}/shops/${shopId}/listings/${externalListingId}`,
    {
      method: 'DELETE',
      headers: {
        'x-api-key': apiKey,
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (result.ok) {
    return { ok: true };
  }

  if (isNotFoundResponse(result.status, result.body)) {
    return { ok: false, reason: 'not_found' };
  }

  await maybeRecordSuspension(tenantId, connectionId, result.status, result.body, [apiKey, accessToken]);
  throw platformError(`delist_${result.status}`, result.status, result.body, [apiKey, accessToken]);
}

/**
 * Lightweight authenticated health probe -- a shop-info GET. Never throws:
 * any failure (missing config, refresh failure, network error, non-2xx
 * response) is reported as `{ healthy: false, detail }` with `detail`
 * scrubbed of credential material, so a caller can safely surface it (e.g.
 * to decide whether to prompt for reconnect) without risking a leak.
 */
export async function checkConnectionHealth(
  tenantId: string,
  connectionId: string,
): Promise<HealthResult> {
  let apiKey: string | undefined;
  let accessToken: string | undefined;

  try {
    apiKey = requireEnv('etsy', 'ETSY_API_KEY');
    accessToken = await getEtsyAccessToken(tenantId, connectionId);
    const shopId = getEtsyShopId(tenantId, connectionId);

    const result = await apiFetch(`${ETSY_APPLICATION_BASE_URL}/shops/${shopId}`, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!result.ok) {
      await maybeRecordSuspension(tenantId, connectionId, result.status, result.body, [
        apiKey,
        accessToken,
      ]);
      return {
        healthy: false,
        detail: scrubSecrets(
          `Etsy shop health check failed with status ${result.status}`,
          [apiKey, accessToken],
        ),
      };
    }

    return { healthy: true };
  } catch (err) {
    return {
      healthy: false,
      detail: scrubSecrets(errorMessage(err), [apiKey, accessToken]),
    };
  }
}

/** Raw (ungated) Etsy Connector implementation -- wrap with gate.ts#buildConnector('etsy', etsyConnector) before exposing to callers. */
export const etsyConnector: Connector = {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
};
