import crypto from 'crypto';
import { requireEnv } from '@/lib/connectors/envConfig';
import { apiFetch } from '@/lib/connectors/apiFetch';
import { scrubSecrets } from '@/lib/connectors/scrub';
import { getConnection, rotateCredential } from '@/lib/connections';

// Etsy Open API v3 authorization: OAuth 2.0 Authorization Code Grant + PKCE.
// startEtsyAuthorization() builds the consent URL and remembers the PKCE
// verifier; completeEtsyAuthorization() trades the returned code for tokens,
// looks up the shop, and stores {accessToken, expiresAt, refreshToken,
// shopId} on the connection -- the shape connectors/apiCredential.ts and
// connectors/etsy.ts already read.
//
// Pending flows live in process memory (10-minute TTL, single-use). That fits
// this single-process local-first app; a restart mid-flow just means the user
// clicks Connect again.

const ETSY_CONNECT_URL = 'https://www.etsy.com/oauth/connect';
const ETSY_API_BASE_URL = 'https://api.etsy.com/v3';
const ETSY_TOKEN_URL = `${ETSY_API_BASE_URL}/public/oauth/token`;
const ETSY_SCOPES = ['listings_r', 'listings_w', 'shops_r'];
const PENDING_TTL_MS = 10 * 60 * 1000;

export type EtsyAuthErrorCode =
  | 'invalid_state'
  | 'token_exchange_failed'
  | 'shop_lookup_failed'
  | 'shop_not_found'
  | 'connection_not_found';

export class EtsyAuthError extends Error {
  constructor(
    public readonly code: EtsyAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EtsyAuthError';
  }
}

interface PendingFlow {
  tenantId: string;
  connectionId: string;
  verifier: string;
  expiresAt: number;
}

// globalThis, not a module-level const: Next can bundle the authorize and
// callback routes as separate module instances, which would each see an
// empty map.
const PENDING_KEY = Symbol.for('resale-inventory.etsyAuth.pending');
function pendingFlows(): Map<string, PendingFlow> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[PENDING_KEY]) g[PENDING_KEY] = new Map<string, PendingFlow>();
  return g[PENDING_KEY] as Map<string, PendingFlow>;
}

function sweepExpired(now: number): void {
  const flows = pendingFlows();
  for (const [state, flow] of flows) {
    if (flow.expiresAt <= now) flows.delete(state);
  }
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function startEtsyAuthorization(tenantId: string, connectionId: string): string {
  const apiKey = requireEnv('etsy', 'ETSY_API_KEY');
  const redirectUri = requireEnv('etsy', 'ETSY_REDIRECT_URI');

  const { verifier, challenge } = generatePkce();
  const state = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();

  sweepExpired(now);
  pendingFlows().set(state, { tenantId, connectionId, verifier, expiresAt: now + PENDING_TTL_MS });

  const url = new URL(ETSY_CONNECT_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', apiKey);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', ETSY_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Consume a pending flow. Single-use; wrong tenant or expired state is "invalid_state". */
function takePending(tenantId: string, state: string): PendingFlow {
  const flows = pendingFlows();
  const flow = flows.get(state);
  if (!flow || flow.tenantId !== tenantId || flow.expiresAt <= Date.now()) {
    // A wrong-tenant probe must not burn the real owner's flow.
    if (flow && flow.expiresAt <= Date.now()) flows.delete(state);
    throw new EtsyAuthError('invalid_state', 'Unknown or expired authorization state.');
  }
  flows.delete(state);
  return flow;
}

/** Drop a pending flow without completing it (user declined on Etsy). */
export function cancelEtsyAuthorization(tenantId: string, state: string): void {
  const flow = pendingFlows().get(state);
  if (flow && flow.tenantId === tenantId) pendingFlows().delete(state);
}

function shopIdFrom(body: unknown): string | null {
  const b = body as { shop_id?: unknown; results?: Array<{ shop_id?: unknown }> } | null;
  const raw = b?.shop_id ?? b?.results?.[0]?.shop_id;
  return typeof raw === 'number' || typeof raw === 'string' ? String(raw) : null;
}

export async function completeEtsyAuthorization(
  tenantId: string,
  code: string,
  state: string,
): Promise<{ connectionId: string }> {
  const flow = takePending(tenantId, state);
  const apiKey = requireEnv('etsy', 'ETSY_API_KEY');
  const sharedSecret = requireEnv('etsy', 'ETSY_SHARED_SECRET');
  const redirectUri = requireEnv('etsy', 'ETSY_REDIRECT_URI');
  const secrets = [apiKey, sharedSecret, code, flow.verifier];

  if (!getConnection(tenantId, flow.connectionId)) {
    throw new EtsyAuthError('connection_not_found', 'The connection no longer exists.');
  }

  const token = await apiFetch(ETSY_TOKEN_URL, {
    method: 'POST',
    form: {
      grant_type: 'authorization_code',
      client_id: apiKey,
      redirect_uri: redirectUri,
      code,
      code_verifier: flow.verifier,
    },
    timeoutMs: 10_000,
  });
  const t = token.body as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  } | null;
  if (
    !token.ok ||
    typeof t?.access_token !== 'string' ||
    typeof t.refresh_token !== 'string' ||
    typeof t.expires_in !== 'number'
  ) {
    throw new EtsyAuthError(
      'token_exchange_failed',
      scrubSecrets(`Etsy token exchange failed with status ${token.status}.`, secrets),
    );
  }

  // Etsy access tokens are "<user_id>.<token>".
  const userId = t.access_token.split('.')[0];
  const shop = await apiFetch(`${ETSY_API_BASE_URL}/application/users/${userId}/shops`, {
    headers: { Authorization: `Bearer ${t.access_token}`, 'x-api-key': apiKey },
    timeoutMs: 10_000,
  });
  if (!shop.ok && shop.status !== 404) {
    throw new EtsyAuthError(
      'shop_lookup_failed',
      scrubSecrets(`Etsy shop lookup failed with status ${shop.status}.`, secrets),
    );
  }
  const shopId = shop.ok ? shopIdFrom(shop.body) : null;
  if (!shopId) {
    throw new EtsyAuthError('shop_not_found', 'This Etsy account has no shop.');
  }

  rotateCredential(tenantId, flow.connectionId, {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    shopId,
  });
  return { connectionId: flow.connectionId };
}
