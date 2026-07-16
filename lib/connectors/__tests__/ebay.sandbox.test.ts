import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createConnection } from '@/lib/connections';
import { createTestTenant } from '@/tests/helpers/tenant';
import type { ListingInput } from '../types';
import { createListing, updateListing, markSold, delist, checkConnectionHealth } from '../ebay';

// Real-Sandbox integration suite (FR22, requirement 22 in
// docs/marketplace-connector-tier/requirements.md) -- exercises
// createListing/updateListing/markSold/delist/checkConnectionHealth against
// the actual api.sandbox.ebay.com, no mocking of apiFetch/getFreshAccessToken
// here (contrast with ebay.test.ts/ebay.oauth.test.ts, which mock both so
// `npm test` never needs network access or real credentials by default).
//
// Skip-gate: the whole suite is skipped, not failed, when
// EBAY_SANDBOX_CLIENT_ID is unset -- this is the exact var name
// requireEnv('ebay', 'EBAY_SANDBOX_CLIENT_ID') reads in ebay.ts's
// ebayExchangeFn(), so "creds present" here means the same thing "creds
// present" means to the connector itself. `npm test` must remain fully
// runnable with zero live credentials configured (AC14) -- this file is the
// one place in the suite that would otherwise need network access, so it is
// the one place that must never turn network-unavailable into a failure.
//
// A second var, EBAY_SANDBOX_REFRESH_TOKEN, holds the Sandbox seller test
// account's OAuth refresh token (sell.inventory scope) -- this is the
// *tenant's own* stored credential (normally arrives via the OAuth
// authorization-code flow a real tenant completes through the app), not an
// app-level credential, so it doesn't belong in envConfig.ts's
// requireEnv()/ebay.ts's ebayExchangeFn() alongside EBAY_SANDBOX_CLIENT_ID/
// EBAY_SANDBOX_CLIENT_SECRET. It is only ever read here, to seed this
// suite's own platform_connections row.
const HAS_SANDBOX_CREDS = Boolean(process.env.EBAY_SANDBOX_CLIENT_ID);

describe.skipIf(!HAS_SANDBOX_CREDS)('eBay Sandbox integration', () => {
  let tenantId: string;
  let connectionId: string;

  beforeAll(() => {
    // createTestTenant() (tests/helpers/tenant.ts) mints a fresh tenant with
    // a unique email per call -- same fixture tests/api/consent.test.ts and
    // friends use against this repo's real scratch DB
    // (BOOKSELLER_DB_PATH, vitest.config.ts). Using a fresh tenant per run,
    // rather than the shared DEFAULT_TENANT_ID, sidesteps
    // platform_connections' UNIQUE(tenant_id, platform) constraint --
    // nothing else in the suite could already hold an 'ebay' connection row
    // for this tenant.
    const tenant = createTestTenant();
    tenantId = tenant.tenantId;

    const refreshToken = process.env.EBAY_SANDBOX_REFRESH_TOKEN;
    if (!refreshToken) {
      // Deliberately NOT part of the skip condition (see HAS_SANDBOX_CREDS
      // above) -- if an operator has gone to the trouble of setting
      // EBAY_SANDBOX_CLIENT_ID (and thus opted into this suite actually
      // running), a still-missing refresh token is a real misconfiguration
      // that should fail loudly, not silently skip.
      throw new Error(
        'EBAY_SANDBOX_CLIENT_ID is set (this suite is running) but ' +
          'EBAY_SANDBOX_REFRESH_TOKEN is not -- this suite needs a real eBay ' +
          "Sandbox seller test account's OAuth refresh token (sell.inventory " +
          'scope) to exercise createListing/updateListing/markSold/delist/' +
          'checkConnectionHealth against api.sandbox.ebay.com. Generate one ' +
          "via eBay Developer Program's Sandbox OAuth consent flow and set " +
          'it before running this suite.',
      );
    }

    // Seed the stored-credential shape apiCredential.ts's
    // getFreshAccessToken() expects ({accessToken, expiresAt, refreshToken},
    // see StoredTokenCredential in apiCredential.ts). accessToken is left
    // empty with expiresAt=0 (already-expired) so the very first connector
    // call exercises getFreshAccessToken's real refresh path
    // (ebayExchangeFn) against api.sandbox.ebay.com using the real refresh
    // token, rather than trusting a stale/fabricated access token.
    const connection = createConnection(tenantId, 'ebay', {
      accessToken: '',
      expiresAt: 0,
      refreshToken,
    });
    connectionId = connection.id;
  });

  // itemId is fresh per call (uuidv4()), and ebay.ts's generateSku() then
  // appends its own random suffix on top of that -- so every createListing
  // call in this suite (and every past/future run of it) gets a SKU that
  // has never been seen by this Sandbox account before. That is what makes
  // repeated runs against the same Sandbox account collision-free (NFR) with
  // no manual Sandbox cleanup step required between runs.
  function sandboxInput(overrides: Partial<ListingInput> = {}): ListingInput {
    return {
      itemId: uuidv4(),
      tenantId,
      connectionId,
      title: `Sandbox integration test listing ${uuidv4().slice(0, 8)}`,
      priceCents: 999,
      category: 'book',
      details: {
        isbn: '9780143127550',
        author: 'Integration Test Author',
        publisher: 'Sandbox Fixtures Press',
        condition: 'Good',
      },
      photos: [],
      ...overrides,
    };
  }

  it(
    'exercises the real create -> update -> markSold -> checkConnectionHealth flow against eBay Sandbox',
    async () => {
      // Step 1: createListing -- real 3-step Create Inventory Item -> Create
      // Offer -> Publish Offer flow (ebay.ts's createListing). A real
      // externalListingId (offerId) comes back only once eBay's Sandbox has
      // actually confirmed the publish step.
      const created = await createListing(sandboxInput());
      expect(typeof created.externalListingId).toBe('string');
      expect(created.externalListingId.length).toBeGreaterThan(0);

      // Step 2: updateListing -- real GET-offer-to-resolve-sku, then real
      // Inventory Item PUT (title) and Offer PUT (price) against what step 1
      // just published.
      const updated = await updateListing(created.externalListingId, tenantId, connectionId, {
        title: 'Sandbox integration test listing (updated)',
        priceCents: 1499,
      });
      expect(updated).toEqual({ ok: true });

      // Step 3: markSold -- real withdraw of the Offer created in step 1.
      const sold = await markSold(created.externalListingId, tenantId, connectionId);
      expect(sold).toEqual({ ok: true });

      // Step 4: checkConnectionHealth -- independent authenticated read
      // (list up to 1 Inventory Item) against the real Sandbox account. Not
      // chained off the offer above; just proves the connection itself is
      // healthy end-to-end, same as a caller would use it for reconnect
      // prompts.
      const health = await checkConnectionHealth(tenantId, connectionId);
      expect(health).toEqual({ healthy: true });
    },
    30_000,
  );

  it(
    'delist withdraws a freshly created real Sandbox offer',
    async () => {
      // Independent create -> delist pair (rather than reusing the flow
      // test's already-sold offer above) so this test's pass/fail never
      // depends on the other test's Sandbox-side terminal state or run
      // order.
      const created = await createListing(sandboxInput());

      const delisted = await delist(created.externalListingId, tenantId, connectionId);
      expect(delisted).toEqual({ ok: true });
    },
    30_000,
  );

  it(
    'updateListing returns {ok:false, reason:"not_found"} for a real Sandbox call against an offerId that was never created',
    async () => {
      const result = await updateListing(`nonexistent-offer-${uuidv4()}`, tenantId, connectionId, {
        title: 'should never apply',
      });

      expect(result).toEqual({ ok: false, reason: 'not_found' });
    },
    30_000,
  );

  it(
    'markSold returns {ok:false, reason:"not_found"} for a real Sandbox call against an offerId that was never created',
    async () => {
      const result = await markSold(`nonexistent-offer-${uuidv4()}`, tenantId, connectionId);

      expect(result).toEqual({ ok: false, reason: 'not_found' });
    },
    30_000,
  );
});
