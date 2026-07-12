import { describe, it, expect } from 'vitest';
import { NextResponse } from 'next/server';
import { parseItemId } from '../apiRequest';

const VALID_UUID = '8f14e45f-ea54-4df1-8a3c-4c6b2e6f8a1e';

describe('lib/apiRequest.ts parseItemId', () => {
  it('returns the parsed id for a valid UUIDv4', async () => {
    const result = await parseItemId(Promise.resolve({ id: VALID_UUID }));
    expect(result).toEqual({ id: VALID_UUID });
  });

  it('returns a 400 NextResponse for a malformed id', async () => {
    const result = await parseItemId(Promise.resolve({ id: 'not-a-uuid' }));
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });

  it('rejects an id where a valid UUID appears only as a suffix, not the whole string', async () => {
    // Regression test for a Stryker-caught gap: without the regex's leading
    // `^` anchor, a regex engine can start matching partway through the
    // string, so "junk" + a real UUID would incorrectly validate — this id
    // must be rejected in full, not partially matched.
    const result = await parseItemId(Promise.resolve({ id: `junkprefix${VALID_UUID}` }));
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });

  it('rejects an id where a valid UUID appears only as a prefix, with trailing junk', async () => {
    const result = await parseItemId(Promise.resolve({ id: `${VALID_UUID}trailingjunk` }));
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });

  it('rejects the empty string', async () => {
    const result = await parseItemId(Promise.resolve({ id: '' }));
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });

  it('rejects a UUID with the wrong version digit (not v4)', async () => {
    const uuidV3 = '8f14e45f-ea54-3df1-8a3c-4c6b2e6f8a1e';
    const result = await parseItemId(Promise.resolve({ id: uuidV3 }));
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });

  it('accepts an uppercase UUIDv4 (case-insensitive)', async () => {
    const result = await parseItemId(Promise.resolve({ id: VALID_UUID.toUpperCase() }));
    expect(result).toEqual({ id: VALID_UUID.toUpperCase() });
  });
});
