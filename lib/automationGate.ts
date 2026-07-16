import { getConnection } from '@/lib/connections';
import { hasValidConsent } from '@/lib/consent';

export type AutomationGateResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_active' | 'consent_required' };

/**
 * The single choke point future connector code must call immediately before
 * every marketplace-mutating action, not just at connection setup (FR24/FR25)
 * -- mirrors lib/transitions.ts's centralize-one-invariant-check precedent.
 *
 * Checks, in order:
 *   1. The connection exists and belongs to tenantId (lib/connections.ts's
 *      getConnection already returns null for both "doesn't exist" and
 *      "belongs to a different tenant" -- this function doesn't distinguish
 *      the two either, same FR4-driven 404-not-403 discipline).
 *   2. The connection's status is 'active' -- 'suspended' or 'revoked' both
 *      fail here (FR21-FR25 kill-switch).
 *   3. A current, non-revoked consent exists for this tenant+connection
 *      (FR13-FR20).
 *
 * Pure read-only check: no side effects, no mutation, no throwing -- callers
 * get a plain discriminated-union result to branch on.
 */
export function assertCanAutomate(tenantId: string, connectionId: string): AutomationGateResult {
  const connection = getConnection(tenantId, connectionId);
  if (!connection) {
    return { ok: false, reason: 'not_found' };
  }

  if (connection.status !== 'active') {
    return { ok: false, reason: 'not_active' };
  }

  if (!hasValidConsent(tenantId, connectionId)) {
    return { ok: false, reason: 'consent_required' };
  }

  return { ok: true };
}
