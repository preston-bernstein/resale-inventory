import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';

// lib/photos.ts computes PHOTOS_ROOT once, at import time, from
// process.env.BOOKSELLER_PHOTOS_PATH (falling back to <cwd>/data/photos).
// vitest.config.ts sets BOOKSELLER_PHOTOS_PATH globally for every test run
// (see the scratchPhotosPath comment there), so the module-under-test has
// already resolved against that value by the time any other test file
// imports it. To exercise BOTH branches of the `??` — the env override and
// the cwd-default fallback — this file manipulates process.env directly and
// re-imports the module fresh via vi.resetModules(), the same technique
// needed for any module whose exported value is computed at import time
// from an environment variable.

const ORIGINAL_ENV = process.env.BOOKSELLER_PHOTOS_PATH;

describe('lib/photos.ts PHOTOS_ROOT', () => {
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.BOOKSELLER_PHOTOS_PATH;
    } else {
      process.env.BOOKSELLER_PHOTOS_PATH = ORIGINAL_ENV;
    }
  });

  it('resolves to <cwd>/data/photos when BOOKSELLER_PHOTOS_PATH is unset', async () => {
    delete process.env.BOOKSELLER_PHOTOS_PATH;
    const { vi } = await import('vitest');
    vi.resetModules();
    const { PHOTOS_ROOT } = await import('../photos');
    expect(PHOTOS_ROOT).toBe(path.resolve(path.join(process.cwd(), 'data', 'photos')));
  });

  it('resolves to BOOKSELLER_PHOTOS_PATH when set, overriding the cwd default', async () => {
    process.env.BOOKSELLER_PHOTOS_PATH = '/tmp/some-scratch-photos-dir';
    const { vi } = await import('vitest');
    vi.resetModules();
    const { PHOTOS_ROOT } = await import('../photos');
    expect(PHOTOS_ROOT).toBe(path.resolve('/tmp/some-scratch-photos-dir'));
  });
});
