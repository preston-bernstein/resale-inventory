import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  mockValidateSessionReadOnly,
  mockWithSession,
} from './playwrightConnectorFixtures';
import { buildBookInput, buildClothingInput, makeFakePageWith, wireSessionTo } from './playwrightListingBuilders';
import { buildPlaywrightConnector, type PlaywrightSite, type SessionGuards } from '../playwrightConnector';
import { UnsupportedCategoryError } from '@/lib/connectors/types';
import type { PlaywrightPageLike } from '../playwrightSession';

const CONNECTION_ID = 'site-conn-1';
const TENANT_ID = 'tenant-1';

const SITE: PlaywrightSite = {
  platform: 'depop',
  buildHooks: () => ({}),
  detailPageUrl: (id) => `https://site.test/items/${id}`,
  editPageUrl: (id) => `https://site.test/items/${id}/edit`,
  selectors: {
    notFound: '#gone',
    titleInput: '#title',
    priceInput: '#price',
    saveButton: '#save',
    markSoldButton: '#sold',
    delistButton: '#delist',
  },
};

const guards: SessionGuards = { beforeCreate: vi.fn(), beforeMutation: vi.fn() };
const createAction = vi.fn(async (_page: PlaywrightPageLike) => ({ externalListingId: 'ext-1' }));
const connector = buildPlaywrightConnector(SITE, createAction, guards);

function fakePage(isGone: boolean) {
  return makeFakePageWith(
    { url: () => 'https://site.test/items/ext-1', isVisible: false },
    { isVisible: vi.fn().mockResolvedValue(isGone) },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('buildPlaywrightConnector createListing', () => {
  it('rejects an unsupported category before the guard or the session', async () => {
    const input = buildBookInput(CONNECTION_ID, 'item-1');
    input.category = 'electronics';

    await expect(connector.createListing(input)).rejects.toBeInstanceOf(UnsupportedCategoryError);
    expect(guards.beforeCreate).not.toHaveBeenCalled();
    expect(mockWithSession).not.toHaveBeenCalled();
  });

  it('runs the guard, then the create action inside the session', async () => {
    const page = fakePage(false);
    wireSessionTo(mockWithSession, page);
    const input = buildClothingInput(CONNECTION_ID, 'item-1', { title: 'Jacket', priceCents: 4500, color: 'Blue' });

    const result = await connector.createListing(input);

    expect(result).toEqual({ externalListingId: 'ext-1' });
    expect(guards.beforeCreate).toHaveBeenCalledWith(input);
    expect(createAction).toHaveBeenCalledWith(page, input);
  });

  it('opens no session when the guard throws', async () => {
    vi.mocked(guards.beforeCreate).mockImplementation(() => {
      throw new Error('paced out');
    });
    const input = buildClothingInput(CONNECTION_ID, 'item-1', { title: 'Jacket', priceCents: 4500, color: 'Blue' });

    await expect(connector.createListing(input)).rejects.toThrow('paced out');
    expect(mockWithSession).not.toHaveBeenCalled();
  });
});

describe('buildPlaywrightConnector listing edits', () => {
  it('updateListing fills only the patched fields, then saves', async () => {
    const page = fakePage(false);
    wireSessionTo(mockWithSession, page);

    const result = await connector.updateListing('ext-1', TENANT_ID, CONNECTION_ID, { priceCents: 1250 });

    expect(result).toEqual({ ok: true });
    expect(guards.beforeMutation).toHaveBeenCalledWith(CONNECTION_ID);
    expect(page.goto).toHaveBeenCalledWith('https://site.test/items/ext-1/edit');
    expect(page.fill).toHaveBeenCalledTimes(1);
    expect(page.fill).toHaveBeenCalledWith('#price', '12.50');
    expect(page.click).toHaveBeenCalledWith('#save');
  });

  it('markSold clicks the mark-sold button on the detail page', async () => {
    const page = fakePage(false);
    wireSessionTo(mockWithSession, page);

    const result = await connector.markSold('ext-1', TENANT_ID, CONNECTION_ID);

    expect(result).toEqual({ ok: true });
    expect(page.goto).toHaveBeenCalledWith('https://site.test/items/ext-1');
    expect(page.click).toHaveBeenCalledWith('#sold');
  });

  it('delist clicks the delist button on the detail page', async () => {
    const page = fakePage(false);
    wireSessionTo(mockWithSession, page);

    await connector.delist('ext-1', TENANT_ID, CONNECTION_ID);

    expect(page.click).toHaveBeenCalledWith('#delist');
  });

});

describe('buildPlaywrightConnector missing listings', () => {
  it.each(['updateListing', 'markSold', 'delist'] as const)(
    '%s reports not_found and clicks nothing when the not-found element shows',
    async (method) => {
      const page = fakePage(true);
      wireSessionTo(mockWithSession, page);

      const result =
        method === 'updateListing'
          ? await connector.updateListing('ext-1', TENANT_ID, CONNECTION_ID, { title: 'x' })
          : await connector[method]('ext-1', TENANT_ID, CONNECTION_ID);

      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(page.click).not.toHaveBeenCalled();
      expect(page.fill).not.toHaveBeenCalled();
    },
  );
});

describe('buildPlaywrightConnector checkConnectionHealth', () => {
  it('reads the session read-only and skips the guards and withSession', async () => {
    mockValidateSessionReadOnly.mockResolvedValue({ healthy: true });

    const result = await connector.checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    expect(result).toEqual({ healthy: true });
    expect(guards.beforeMutation).not.toHaveBeenCalled();
    expect(mockWithSession).not.toHaveBeenCalled();
  });
});
