import { describe, it, expect, vi, beforeEach } from 'vitest';

// getDecryptedCredential/rotateCredential/getConnection hit real SQLite +
// AES-GCM crypto underneath (lib/connections.ts) -- mocked at that module
// boundary, same pattern as apiCredential.test.ts.
vi.mock('@/lib/connections', () => ({
  getDecryptedCredential: vi.fn(),
  rotateCredential: vi.fn(),
  getConnection: vi.fn(),
}));

// The `playwright` package itself is mocked at the module level so this
// suite never launches a real browser. `launch` is a bare vi.fn(): the
// dry-run tests assert it was never called, which is what proves the
// dry-run path never reaches into playwright at all -- if withSession or
// validateSessionReadOnly ever did call it on the dry-run branch, that
// assertion fails loudly and immediately points at the regression.
const launch = vi.fn();
const newContext = vi.fn();
const newPage = vi.fn();
const storageState = vi.fn();
const closeBrowser = vi.fn();

vi.mock('playwright', () => ({
  chromium: {
    launch: (...args: unknown[]) => launch(...args),
  },
}));

import { getDecryptedCredential, rotateCredential, getConnection } from '@/lib/connections';
import {
  DRY_RUN_CREDENTIAL_MARKER,
  isDryRunCredential,
  withSession,
  validateSessionReadOnly,
} from '../playwrightSession';

const TENANT_ID = 'tenant-1';

beforeEach(() => {
  vi.mocked(getDecryptedCredential).mockReset();
  vi.mocked(rotateCredential).mockReset();
  vi.mocked(getConnection).mockReset();
  vi.mocked(getConnection).mockReturnValue({
    id: 'conn',
    platform: 'poshmark',
    status: 'active',
    lastVerifiedAt: null,
    createdAt: '',
    updatedAt: '',
  });

  launch.mockReset();
  newContext.mockReset();
  newPage.mockReset();
  storageState.mockReset();
  closeBrowser.mockReset();

  const page = { url: () => 'https://example.com/dashboard' };
  const context = {
    newPage: newPage.mockResolvedValue(page),
    storageState: storageState.mockResolvedValue({ cookies: [], origins: [] }),
  };
  const browser = {
    newContext: newContext.mockResolvedValue(context),
    close: closeBrowser.mockResolvedValue(undefined),
  };
  launch.mockResolvedValue(browser);

  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('isDryRunCredential', () => {
  it('is true for null/undefined/empty and the reserved marker', () => {
    expect(isDryRunCredential(null)).toBe(true);
    expect(isDryRunCredential(undefined)).toBe(true);
    expect(isDryRunCredential('')).toBe(true);
    expect(isDryRunCredential(DRY_RUN_CREDENTIAL_MARKER)).toBe(true);
  });

  it('is false for a real-looking credential', () => {
    expect(isDryRunCredential('super-secret-password')).toBe(false);
  });

  // Pins the sentinel's literal value -- a mutant that swaps
  // DRY_RUN_CREDENTIAL_MARKER's definition for the empty string (or any
  // other value) would still make isDryRunCredential('') true (since the
  // function already treats '' as dry-run via the `!rawCredential` branch),
  // so the boolean-return assertions above can't catch that mutation on
  // their own. Asserting the exact string, and that a near-miss string is
  // NOT treated as the marker, closes that gap.
  it('the marker constant is the exact literal "__DRY_RUN__", and near-miss strings are not treated as it', () => {
    expect(DRY_RUN_CREDENTIAL_MARKER).toBe('__DRY_RUN__');
    expect(isDryRunCredential('__DRY_RUN__ ')).toBe(false);
    expect(isDryRunCredential(' __DRY_RUN__')).toBe(false);
    expect(isDryRunCredential('__DRY_RUN')).toBe(false);
    expect(isDryRunCredential('__dry_run__')).toBe(false);
  });
});

describe('resolvePlatform fallback (via withSession dry-run result)', () => {
  // resolvePlatform falls back to the literal 'unknown' when getConnection
  // can't find the connection at all (`?.platform ?? 'unknown'`). Every
  // other test in this file has getConnection returning a real connection
  // record (set up in beforeEach), so none of them exercise this fallback
  // or the optional-chaining guard in front of it.
  it('falls back to platform "unknown" when getConnection finds nothing, without throwing', async () => {
    vi.mocked(getConnection).mockReturnValue(null);
    vi.mocked(getDecryptedCredential).mockReturnValue({ credential: DRY_RUN_CREDENTIAL_MARKER });

    const result = await withSession(TENANT_ID, 'conn-missing', vi.fn());

    expect(result).toMatchObject({ dryRun: true, platform: 'unknown' });
    expect(console.log).toHaveBeenCalledWith('[dry-run] platform=unknown action=withSession');
  });
});

describe('withSession', () => {
  it('dry-run: never launches a browser, logs via dryRunLog, and does not call action()', async () => {
    vi.mocked(getDecryptedCredential).mockReturnValue({
      credential: DRY_RUN_CREDENTIAL_MARKER,
    });

    const action = vi.fn().mockResolvedValue('should-not-run');

    const result = await withSession(TENANT_ID, 'conn-dry', action);

    expect(launch).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(rotateCredential).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dryRun: true, platform: 'poshmark' });
    // Exact match, not stringContaining -- dryRunLog is called here without
    // an itemId, so the ` item=...` suffix must be entirely absent. A
    // mutant that swaps the no-itemId suffix branch's '' for a non-empty
    // placeholder string only shows up under an exact-match assertion.
    expect(console.log).toHaveBeenCalledWith('[dry-run] platform=poshmark action=withSession');
  });

  it('dry-run also covers an entirely absent credential', async () => {
    vi.mocked(getDecryptedCredential).mockReturnValue(null);

    const action = vi.fn();
    await withSession(TENANT_ID, 'conn-dry-2', action);

    expect(launch).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('two concurrent calls for the same connectionId both resolve without error', async () => {
    // This does not deterministically prove serialization (that the second
    // call's work only starts after the first's fully settles) -- doing so
    // in a unit test would require instrumenting internal timing. It only
    // confirms the per-connectionId lock doesn't deadlock or drop either
    // call when both are in flight for the same connectionId. Both calls
    // use dry-run credentials so no real browser contention is at stake.
    vi.mocked(getDecryptedCredential).mockReturnValue({
      credential: DRY_RUN_CREDENTIAL_MARKER,
    });

    const actionA = vi.fn().mockResolvedValue('a');
    const actionB = vi.fn().mockResolvedValue('b');

    const [resultA, resultB] = await Promise.all([
      withSession(TENANT_ID, 'conn-shared', actionA),
      withSession(TENANT_ID, 'conn-shared', actionB),
    ]);

    expect(resultA).toMatchObject({ dryRun: true });
    expect(resultB).toMatchObject({ dryRun: true });
  });

  // withConnectionLock's finally() cleanup guards deletion behind
  // `connectionLocks.get(connectionId) === tracked` specifically so that a
  // call finishing DOESN'T clear out a *newer* call's still-in-flight lock
  // entry from the map. If that guard is dropped (always-delete, or the
  // equality flipped), a first call settling would wrongly wipe a second
  // call's still-pending entry -- letting a third call for the same
  // connectionId start immediately instead of queuing behind the second.
  // Real (non-dry-run) credentials + controllable deferred actions are used
  // here so the exact moment each call "starts" vs "settles" can be pinned
  // down deterministically.
  it('a third call still queues behind a still-pending second call, even after the first call has fully settled', async () => {
    vi.mocked(getDecryptedCredential).mockReturnValue({
      credential: 'real-pass',
      sessionState: { cookies: [], origins: [] },
    });
    newPage.mockResolvedValue({ url: () => 'https://example.com/dashboard' });

    function createDeferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    const dA = createDeferred<string>();
    const dB = createDeferred<string>();

    const actionA = vi.fn().mockImplementation(() => dA.promise);
    const actionB = vi.fn().mockImplementation(() => dB.promise);
    // actionC's own promise resolves immediately -- the only thing that
    // should be holding call C back is the mutex queuing behind B, not any
    // delay inside actionC itself. That way, if C ever gets wrongly
    // unblocked, it has nothing stopping it from running all the way to
    // completion (and settling pC) well before B is done.
    const actionC = vi.fn().mockResolvedValue('c-done');

    const connId = 'conn-race';

    const pA = withSession(TENANT_ID, connId, actionA);
    const pB = withSession(TENANT_ID, connId, actionB);

    dA.resolve('a-done');
    await pA;

    // `await pA` only guarantees call A's own returned promise has
    // settled -- the cleanup guard under test runs off a SEPARATE
    // downstream promise (`tracked`, derived from `run` via one more
    // `.then()`), so it may not have fired yet at this exact point. A real
    // macrotask delay (not a fixed count of microtask flushes) guarantees
    // every pending microtask -- including that cleanup callback and call
    // B's task actually starting -- has drained before call C is issued,
    // so the guard's effect (or a mutant's lack thereof) is fully in place
    // by the time C reads the connectionLocks map.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // First call has fully settled AND its cleanup has run. Second call is
    // still pending (its action is blocked on dB). Now issue a third call
    // for the SAME connectionId.
    const pC = withSession(TENANT_ID, connId, actionC);
    let cSettled = false;
    void pC.then(() => {
      cSettled = true;
    });

    // A real macrotask delay -- not a fixed count of microtask flushes --
    // so this doesn't depend on guessing exactly how many await hops
    // withSession's real-path body needs before reaching action(). If the
    // cleanup guard is broken (always/never deletes, or checks the wrong
    // thing), a wrongly-unblocked call C has every opportunity to run to
    // completion inside this window since nothing else is holding it back.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cSettled).toBe(false);
    expect(actionC).not.toHaveBeenCalled();

    dB.resolve('b-done');
    await pB;
    await pC;

    expect(cSettled).toBe(true);
    expect(actionC).toHaveBeenCalledTimes(1);
  });
});

describe('withSession real (non-dry-run) path', () => {
  it('valid persisted session: skips login, reuses the session for newContext, calls action, rotates the (unchanged) session', async () => {
    const persistedSession = { cookies: [{ name: 'c' }], origins: [] };
    vi.mocked(getDecryptedCredential).mockReturnValue({
      credential: 'real-pass',
      sessionState: persistedSession,
    });
    newPage.mockResolvedValue({ url: () => 'https://example.com/dashboard' });
    const freshState = { cookies: [{ name: 'refreshed' }], origins: [] };
    storageState.mockResolvedValue(freshState);

    const action = vi.fn().mockResolvedValue('action-result');
    const result = await withSession(TENANT_ID, 'conn-real', action);

    expect(result).toBe('action-result');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(newContext).toHaveBeenCalledWith({ storageState: persistedSession });
    expect(action).toHaveBeenCalledTimes(1);
    expect(rotateCredential).toHaveBeenCalledWith(TENANT_ID, 'conn-real', {
      credential: 'real-pass',
      sessionState: freshState,
    });
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });

  it('no persisted session: treats it as invalid without calling validateSession first, logs in via performLogin, then re-validates', async () => {
    vi.mocked(getDecryptedCredential).mockReturnValue({
      credential: 'real-pass',
      sessionState: null,
    });
    newPage.mockResolvedValue({ url: () => 'https://example.com/dashboard' });

    const performLogin = vi.fn().mockResolvedValue(undefined);
    const action = vi.fn().mockResolvedValue('logged-in-result');

    const result = await withSession(TENANT_ID, 'conn-nosession', action, { performLogin });

    expect(newContext).toHaveBeenCalledWith(undefined);
    expect(performLogin).toHaveBeenCalledWith(expect.anything(), 'real-pass');
    expect(action).toHaveBeenCalledTimes(1);
    expect(result).toBe('logged-in-result');
  });

  it('invalid persisted session with no performLogin hook: throws a specific error naming the connectionId, and still closes the browser', async () => {
    vi.mocked(getDecryptedCredential).mockReturnValue({
      credential: 'real-pass',
      sessionState: { cookies: [], origins: [] },
    });
    newPage.mockResolvedValue({ url: () => 'https://example.com/login' });

    const action = vi.fn();

    await expect(withSession(TENANT_ID, 'conn-no-hook', action)).rejects.toThrow(
      'withSession: no valid session for connection conn-no-hook and no performLogin hook supplied -- the calling connector must pass SessionHooks.performLogin',
    );
    expect(action).not.toHaveBeenCalled();
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });

  it('invalid persisted session, performLogin runs but the fresh login still fails validation: throws a specific error, still closes the browser', async () => {
    vi.mocked(getDecryptedCredential).mockReturnValue({
      credential: 'real-pass',
      sessionState: { cookies: [], origins: [] },
    });
    // Every validation check reports invalid, including after performLogin.
    const validateSession = vi.fn().mockResolvedValue(false);
    const performLogin = vi.fn().mockResolvedValue(undefined);
    const action = vi.fn();

    await expect(
      withSession(TENANT_ID, 'conn-login-fails', action, { validateSession, performLogin }),
    ).rejects.toThrow('withSession: fresh login attempt failed for connection conn-login-fails');
    expect(performLogin).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });

  it('closes the browser even when action() itself throws', async () => {
    vi.mocked(getDecryptedCredential).mockReturnValue({
      credential: 'real-pass',
      sessionState: { cookies: [], origins: [] },
    });
    newPage.mockResolvedValue({ url: () => 'https://example.com/dashboard' });

    const action = vi.fn().mockRejectedValue(new Error('action blew up'));

    await expect(withSession(TENANT_ID, 'conn-action-throws', action)).rejects.toThrow(
      'action blew up',
    );
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });
});

describe('getRawCredential payload-shape edge cases (via withSession dry-run detection)', () => {
  // getRawCredential's `typeof payload === 'object' && 'credential' in
  // payload` guard exists specifically so a non-object payload (which the
  // `in` operator throws on) is handled safely instead of crashing. These
  // cases exercise that guard directly through the public API.
  it('a bare string payload (not an object) is treated as no-credential (dry-run), without throwing', async () => {
    vi.mocked(getDecryptedCredential).mockReturnValue(
      'not-an-object-payload' as unknown as ReturnType<typeof getDecryptedCredential>,
    );

    const action = vi.fn();
    const result = await withSession(TENANT_ID, 'conn-string-payload', action);

    expect(launch).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dryRun: true });
  });

  // A function is `typeof 'function'`, not `'object'` -- so even if a
  // `credential` property is attached to it, the typeof guard must still
  // reject it (falling through to "no credential" / dry-run) rather than
  // reading the attached property. A mutant that bypasses the typeof check
  // (e.g. collapsing the whole guard to `true`) would instead read the
  // attached property and treat this as a REAL credential, skipping
  // dry-run entirely.
  it('a function-typed payload with an attached "credential" property is still treated as no-credential (dry-run)', async () => {
    const weirdPayload = (() => {}) as unknown as { credential: string };
    weirdPayload.credential = 'attached-but-not-a-real-object-payload';
    vi.mocked(getDecryptedCredential).mockReturnValue(
      weirdPayload as unknown as ReturnType<typeof getDecryptedCredential>,
    );

    const action = vi.fn();
    const result = await withSession(TENANT_ID, 'conn-function-payload', action);

    expect(launch).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dryRun: true });
  });
});

describe('validateSessionReadOnly', () => {
  it('dry-run: never launches a browser and reports unhealthy', async () => {
    vi.mocked(getDecryptedCredential).mockReturnValue({ credential: null });

    const result = await validateSessionReadOnly(TENANT_ID, 'conn-dry');

    expect(launch).not.toHaveBeenCalled();
    expect(result).toEqual({ healthy: false, detail: 'dry-run: no credential configured' });
    // Exact match on the dryRunLog call -- pins the 'checkConnectionHealth'
    // action-name literal itself, not just that some log happened.
    expect(console.log).toHaveBeenCalledWith(
      '[dry-run] platform=poshmark action=checkConnectionHealth',
    );
  });

  it('non-dry-run + no persisted session at all: reports unhealthy with the specific reason, WITHOUT ever touching playwright', async () => {
    vi.mocked(getDecryptedCredential).mockReturnValue({
      credential: 'real-password',
      sessionState: null,
    });

    const result = await validateSessionReadOnly(TENANT_ID, 'conn-no-session');

    expect(result).toEqual({ healthy: false, detail: 'no persisted session to validate' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('non-dry-run + invalid persisted session: reports unhealthy WITHOUT ever attempting a fresh login', async () => {
    const persistedSession = { cookies: [], origins: [] };
    vi.mocked(getDecryptedCredential).mockReturnValue({
      credential: 'real-password',
      sessionState: persistedSession,
    });
    // Default validation heuristic treats a login-looking URL as invalid.
    newPage.mockResolvedValue({ url: () => 'https://example.com/login' });

    const performLogin = vi.fn();

    const result = await validateSessionReadOnly(TENANT_ID, 'conn-real', { performLogin });

    expect(result).toEqual({ healthy: false, detail: 'session invalid or expired' });
    expect(performLogin).not.toHaveBeenCalled();
    // It DOES use playwright on this path (real credential + real session
    // to check) -- just never logs in.
    expect(launch).toHaveBeenCalledTimes(1);
    expect(newContext).toHaveBeenCalledWith({ storageState: persistedSession });
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });

  it('non-dry-run + valid persisted session: reports healthy and closes the browser', async () => {
    vi.mocked(getDecryptedCredential).mockReturnValue({
      credential: 'real-password',
      sessionState: { cookies: [], origins: [] },
    });
    newPage.mockResolvedValue({ url: () => 'https://example.com/dashboard' });

    const result = await validateSessionReadOnly(TENANT_ID, 'conn-real-2');

    expect(result).toEqual({ healthy: true });
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });
});

// defaultValidateSession (the fallback used whenever a connector doesn't
// supply hooks.validateSession) is only reachable indirectly through
// validateSessionReadOnly/withSession -- these tests drive it via
// validateSessionReadOnly with real credentials + a persisted session, and
// no validateSession hook, so the default heuristic runs.
describe('defaultValidateSession (default heuristic, driven via validateSessionReadOnly)', () => {
  function realSessionSetup() {
    vi.mocked(getDecryptedCredential).mockReturnValue({
      credential: 'real-password',
      sessionState: { cookies: [], origins: [] },
    });
  }

  it('a page with no url() method at all (undefined, not just empty) is treated as invalid, without throwing', async () => {
    realSessionSetup();
    newPage.mockResolvedValue({});

    const result = await validateSessionReadOnly(TENANT_ID, 'conn-no-url-fn');

    expect(result).toEqual({ healthy: false, detail: 'session invalid or expired' });
  });

  // Guards against a null/undefined `page` itself (distinct from the case
  // above, which is a real object missing the url() method) -- both layers
  // of optional chaining in `(page as {...})?.url?.()` must independently
  // hold, or this throws instead of degrading to "invalid".
  it('a null page is treated as invalid, without throwing', async () => {
    realSessionSetup();
    newPage.mockResolvedValue(null as unknown as { url: () => string });

    const result = await validateSessionReadOnly(TENANT_ID, 'conn-null-page');

    expect(result).toEqual({ healthy: false, detail: 'session invalid or expired' });
  });

  it('a page whose url() returns an empty string is treated as invalid', async () => {
    realSessionSetup();
    newPage.mockResolvedValue({ url: () => '' });

    const result = await validateSessionReadOnly(TENANT_ID, 'conn-empty-url');

    expect(result).toEqual({ healthy: false, detail: 'session invalid or expired' });
  });

  it.each([
    ['https://example.com/account/log-in', 'login URL with a hyphen'],
    ['https://example.com/signin', 'signin URL with no hyphen'],
    ['https://example.com/account/sign-in', 'sign-in URL with a hyphen, no "log" substring'],
    ['https://example.com/Login', 'Login URL, different case'],
  ])('a dashboard-shaped URL containing %s (%s) is still treated as invalid', async (url) => {
    realSessionSetup();
    newPage.mockResolvedValue({ url: () => url });

    const result = await validateSessionReadOnly(TENANT_ID, 'conn-login-variant');

    expect(result.healthy).toBe(false);
  });

  it('a genuinely dashboard-looking URL (no login/signin anywhere) is treated as valid', async () => {
    realSessionSetup();
    newPage.mockResolvedValue({ url: () => 'https://example.com/seller/dashboard' });

    const result = await validateSessionReadOnly(TENANT_ID, 'conn-dashboard');

    expect(result).toEqual({ healthy: true });
  });
});
