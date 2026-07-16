import { assertCanAutomate } from '@/lib/automationGate';
import { recordListingCreated } from '@/lib/connectors/itemPlatformsWrite';
import { ConnectorGatingError } from '@/lib/connectors/types';
import type {
  Connector,
  ListingInput,
  CreateListingResult,
  MarkSoldResult,
  DelistResult,
  UpdateListingResult,
} from '@/lib/connectors/types';

// ---------------------------------------------------------------------------
// The single wrapping layer between a concrete platform connector (ebay.ts,
// poshmark.ts, ...) and anything that calls it. Every mutating method gets a
// FRESH lib/automationGate.ts#assertCanAutomate check on every invocation --
// never once at construction time -- so a consent revocation or kill-switch
// suspension that lands between two calls is visible to the very next call
// (FR24/FR25). checkConnectionHealth is the one exception: it's a read-only
// probe, not a marketplace-mutating action, so it passes through ungated.
// ---------------------------------------------------------------------------

/**
 * lib/automationGate.ts#assertCanAutomate's real, already-shipped contract
 * (from the merged multi-tenant-foundation story) returns one of three
 * reasons -- 'not_found' (connection doesn't exist / wrong tenant),
 * 'not_active' (suspended or revoked), or 'consent_required'. Connector
 * callers (lib/connectors/types.ts's ConnectorGatingError) only distinguish
 * two kinds, so both connection-shaped failures ('not_found' and
 * 'not_active') collapse onto 'connection_not_active' -- there's no
 * connection to automate against either way -- while 'consent_required'
 * maps onto 'missing_consent'.
 */
function toGatingKind(
  reason: 'not_found' | 'not_active' | 'consent_required',
): 'missing_consent' | 'connection_not_active' {
  return reason === 'consent_required' ? 'missing_consent' : 'connection_not_active';
}

function assertGateOrThrow(tenantId: string, connectionId: string): void {
  const gate = assertCanAutomate(tenantId, connectionId);
  if (!gate.ok) {
    throw new ConnectorGatingError(toGatingKind(gate.reason), connectionId);
  }
}

/**
 * Shape shared by updateListing/markSold/delist: externalListingId first,
 * then tenantId/connectionId (the 2nd/3rd positional args the gate checks),
 * then whatever platform-specific extra args that particular method takes.
 */
type GatedMethod<Result, Extra extends unknown[]> = (
  externalListingId: string,
  tenantId: string,
  connectionId: string,
  ...extra: Extra
) => Promise<Result>;

/**
 * Wraps a single raw connector method with a fresh pre-call gate check.
 * Exists so updateListing/markSold/delist share one implementation instead
 * of triplicating the same "check gate, then call raw" logic three times.
 */
function gated<Result, Extra extends unknown[]>(
  raw: GatedMethod<Result, Extra>,
): GatedMethod<Result, Extra> {
  return async (externalListingId, tenantId, connectionId, ...extra) => {
    assertGateOrThrow(tenantId, connectionId);
    return raw(externalListingId, tenantId, connectionId, ...extra);
  };
}

/**
 * Wraps a raw, platform-specific Connector implementation with the
 * automation gate. `raw` does the real platform API/browser-bot work;
 * everything here is cross-cutting (gating + the createListing ->
 * item_platforms bookkeeping) and identical across every platform, which is
 * why it lives here instead of being copy-pasted into each connector file.
 */
export function buildConnector(platform: string, raw: Connector): Connector {
  return {
    // Kept inline (not built on top of `gated()`) because it has the extra
    // recordListingCreated bookkeeping step on success that no other method
    // needs.
    async createListing(input: ListingInput): Promise<CreateListingResult> {
      assertGateOrThrow(input.tenantId, input.connectionId);

      const result = await raw.createListing(input);
      recordListingCreated(input.tenantId, input.itemId, platform, result.externalListingId);
      return result;
    },

    updateListing: gated<UpdateListingResult, [Parameters<Connector['updateListing']>[3]]>(
      raw.updateListing.bind(raw),
    ),

    markSold: gated<MarkSoldResult, []>(raw.markSold.bind(raw)),

    delist: gated<DelistResult, []>(raw.delist.bind(raw)),

    // Deliberately ungated: a health probe doesn't mutate anything on the
    // platform, so it isn't behind assertCanAutomate -- callers must be able
    // to check health even while a connection is suspended (e.g. to decide
    // whether to surface a reconnect prompt).
    checkConnectionHealth: raw.checkConnectionHealth.bind(raw),
  };
}
