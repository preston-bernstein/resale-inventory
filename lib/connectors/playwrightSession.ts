import { getDecryptedCredential, rotateCredential, getConnection, recordSuspensionSignal } from '@/lib/connections';
import { scrubSecrets } from '@/lib/connectors/scrub';
import type { ClothingDetails, Photo } from '@/lib/types';

// This module is the shared Playwright session harness for
// cookie/session-based marketplace connectors (Poshmark, Depop, Mercari,
// Vinted, Grailed, Amazon Seller, ...) -- platforms without a first-class
// API, where a connector has to drive a real logged-in browser instead of
// calling a REST endpoint (contrast with apiCredential.ts, which handles
// OAuth-token platforms like eBay/Etsy).
//
// No concrete connector exists yet -- poshmark.ts/depop.ts/etc. are future
// tasks -- so every piece of platform-specific behavior (what "logged in"
// looks like, how to submit the login form) is a caller-supplied hook
// (SessionHooks below), never hardcoded here.
//
// Dry-run safety is the load-bearing property of this file: when a
// connection has no real credential configured (absent, or explicitly
// marked DRY_RUN_CREDENTIAL_MARKER), NOTHING in here may import or invoke
// the `playwright` package -- no browser launch, ever. The `playwright`
// package is only ever touched via a dynamic `await import('playwright')`
// inside the non-dry-run branches below, after isDryRunCredential() has
// already returned false.

/** Reserved marker stored as a connection's "credential" to mean "no real credential -- always dry-run this connection." */
export const DRY_RUN_CREDENTIAL_MARKER = '__DRY_RUN__';

/** True if `rawCredential` is absent/empty, or is the reserved dry-run marker. */
export function isDryRunCredential(rawCredential: string | null | undefined): boolean {
  return !rawCredential || rawCredential === DRY_RUN_CREDENTIAL_MARKER;
}

/**
 * Logs a dry-run action. Deliberately logs ONLY platform + action type +
 * (optional) item id -- never a full listing payload, since dry-run
 * connections may still be wired to real (if inert) inventory data.
 */
function dryRunLog(platform: string, action: string, itemId?: string): void {
  const suffix = itemId ? ` item=${itemId}` : '';
  console.log(`[dry-run] platform=${platform} action=${action}${suffix}`);
}

/**
 * Minimal shape of what `context.storageState()` returns from Playwright
 * (cookies + localStorage per origin). Declared locally rather than
 * imported from the `playwright` package's types so referencing this type
 * never forces a static import of `playwright` itself.
 */
interface PlaywrightStorageState {
  cookies: unknown[];
  origins: unknown[];
}

/**
 * The credential envelope this module expects back from
 * getDecryptedCredential() for any playwright-driven connection.
 *
 *  - `credential`: the raw secret used to log in (e.g. a password), or
 *    absent/DRY_RUN_CREDENTIAL_MARKER for a dry-run connection.
 *  - `sessionState`: the last persisted Playwright storageState from a
 *    previous successful login, if any. Reused across calls so most
 *    withSession() invocations don't need to log in again.
 */
interface PlaywrightCredentialPayload {
  credential?: string | null;
  sessionState?: PlaywrightStorageState | null;
}

/**
 * Minimal value-based subset of Playwright's `Page` API shared by every
 * cookie/session-based connector that drives real listing pages through
 * this module's withSession/validateSessionReadOnly (poshmark.ts/depop.ts/
 * mercari.ts/vinted.ts/grailed.ts). Declared once here -- a superset of
 * what any single connector needs -- rather than redeclared per file, so
 * this module never needs a static import of the `playwright` package
 * itself; `withSession`/`validateSessionReadOnly` hand back `page` typed
 * `unknown`, and every connector casts to this shape at its own
 * `asPage()` call site. A connector that doesn't use one of these methods
 * (e.g. grailed.ts has no photo-upload step wired up yet, so never calls
 * setInputFiles) is unaffected by the unused method -- every cast here
 * originates from `unknown`, never from a real Playwright `Page`, so
 * nothing structurally enforces the extra method actually exists on the
 * runtime object until that connector chooses to call it.
 */
export interface PlaywrightPageLike {
  goto(url: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  check(selector: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForURL(pattern: string | RegExp): Promise<void>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  url(): string;
  content(): Promise<string>;
  setInputFiles(selector: string, files: string | string[]): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
}

export interface SessionHooks {
  /**
   * Platform-specific: given a live Playwright `Page` (typed `unknown`
   * here so this module never needs playwright's types at the top level),
   * return true if the page is showing an authenticated view rather than a
   * login/signin redirect. Each connector must supply its own
   * selectors/URL checks. Falls back to defaultValidateSession below when
   * omitted.
   */
  validateSession?: (page: unknown) => Promise<boolean>;
  /**
   * Platform-specific: perform exactly ONE navigate+submit login attempt
   * using the page and the decrypted raw credential. Used by withSession's
   * real (non-dry-run) path when the persisted session fails validation.
   * validateSessionReadOnly NEVER calls this -- see its doc comment.
   */
  performLogin?: (page: unknown, credential: string) => Promise<void>;
}

// Placeholder only -- real connectors must override via
// SessionHooks.validateSession with platform-specific checks (e.g. a
// selector that only exists on the seller dashboard). This default just
// checks the current URL doesn't look like a login/signin page.
const defaultValidateSession: NonNullable<SessionHooks['validateSession']> = async (page) => {
  const url = (page as { url?: () => string })?.url?.() ?? '';
  return url.length > 0 && !/log[-]?in|sign[-]?in/i.test(url);
};

function getRawCredential(payload: unknown): string | null | undefined {
  if (payload == null) {
    return payload as null | undefined;
  }
  if (typeof payload === 'object' && 'credential' in payload) {
    return (payload as PlaywrightCredentialPayload).credential ?? undefined;
  }
  return undefined;
}

function getSessionState(payload: unknown): PlaywrightStorageState | null {
  if (payload && typeof payload === 'object' && 'sessionState' in payload) {
    return (payload as PlaywrightCredentialPayload).sessionState ?? null;
  }
  return null;
}

function resolvePlatform(tenantId: string, connectionId: string): string {
  return getConnection(tenantId, connectionId)?.platform ?? 'unknown';
}

// --- per-connectionId async mutex -------------------------------------
//
// Two concurrent withSession()/validateSessionReadOnly() calls against the
// SAME connectionId must serialize -- otherwise two browser contexts could
// race to load/rotate the same persisted session. connectionLocks chains
// each new task onto the promise already queued for that connectionId;
// different connectionIds never block each other. connectionIds are
// globally-unique uuids (lib/connections.ts), so keying on connectionId
// alone (without tenantId) is safe.
const connectionLocks = new Map<string, Promise<unknown>>();

function withConnectionLock<T>(connectionId: string, task: () => Promise<T>): Promise<T> {
  const previous = connectionLocks.get(connectionId) ?? Promise.resolve();
  const run = previous.then(task, task);
  // Never-rejecting tracker so one failed call doesn't poison the chain for
  // whoever queues up next behind it.
  const tracked = run.then(
    () => undefined,
    () => undefined,
  );
  connectionLocks.set(connectionId, tracked);
  void tracked.finally(() => {
    if (connectionLocks.get(connectionId) === tracked) {
      connectionLocks.delete(connectionId);
    }
  });
  return run;
}

/**
 * Runs `action` against a live, authenticated Playwright `Page` for one
 * connection, used by the four mutating connector operations (list/delist/
 * update-price/mark-sold). Concurrent calls for the same connectionId are
 * serialized (see withConnectionLock above).
 *
 * Dry-run: if the stored credential is absent or DRY_RUN_CREDENTIAL_MARKER,
 * logs via dryRunLog() and resolves to a placeholder result WITHOUT ever
 * importing `playwright` or launching a browser.
 *
 * Real path: dynamically imports `playwright`, launches a fresh
 * browser/context scoped to this call, loads the persisted session (if
 * any), validates it via hooks.validateSession (or the placeholder
 * default), and -- if invalid -- performs exactly one login attempt via
 * hooks.performLogin (required on this path; throws a clear error if
 * omitted). The resulting session is persisted back via rotateCredential()
 * before `action(page)` runs.
 */
export async function withSession<T>(
  tenantId: string,
  connectionId: string,
  action: (page: unknown) => Promise<T>,
  hooks: SessionHooks = {},
): Promise<T> {
  return withConnectionLock(connectionId, async () => {
    const payload = getDecryptedCredential(tenantId, connectionId);
    const rawCredential = getRawCredential(payload);
    const platform = resolvePlatform(tenantId, connectionId);

    if (isDryRunCredential(rawCredential)) {
      dryRunLog(platform, 'withSession');
      return { dryRun: true, platform, connectionId } as unknown as T;
    }

    // Real credential established -- only NOW do we touch `playwright`.
    const { chromium } = await import('playwright');
    const sessionState = getSessionState(payload);
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext(
        sessionState ? { storageState: sessionState as never } : undefined,
      );
      const page = await context.newPage();

      const validateSession = hooks.validateSession ?? defaultValidateSession;
      let valid = sessionState ? await validateSession(page) : false;

      if (!valid) {
        if (!hooks.performLogin) {
          throw new Error(
            `withSession: no valid session for connection ${connectionId} and no performLogin hook supplied -- the calling connector must pass SessionHooks.performLogin`,
          );
        }
        await hooks.performLogin(page, (rawCredential as string) ?? '');
        valid = await validateSession(page);
        if (!valid) {
          throw new Error(`withSession: fresh login attempt failed for connection ${connectionId}`);
        }
      }

      const newState = (await context.storageState()) as PlaywrightStorageState;
      rotateCredential(tenantId, connectionId, {
        credential: rawCredential,
        sessionState: newState,
      });

      return await action(page);
    } finally {
      await browser.close();
    }
  });
}

/**
 * Read-only session health check, used by checkConnectionHealth. Validates
 * the EXISTING persisted session the same way withSession does, but NEVER
 * attempts a fresh login on failure -- even if `hooks.performLogin` is
 * supplied (accepted only for SessionHooks type-compatibility with
 * withSession's callers), it is deliberately never invoked here.
 *
 * Dry-run: returns `{ healthy: false, detail: 'dry-run: ...' }` without
 * ever importing `playwright`.
 */
export async function validateSessionReadOnly(
  tenantId: string,
  connectionId: string,
  hooks: SessionHooks = {},
): Promise<{ healthy: boolean; detail?: string }> {
  const payload = getDecryptedCredential(tenantId, connectionId);
  const rawCredential = getRawCredential(payload);
  const platform = resolvePlatform(tenantId, connectionId);

  if (isDryRunCredential(rawCredential)) {
    dryRunLog(platform, 'checkConnectionHealth');
    return { healthy: false, detail: 'dry-run: no credential configured' };
  }

  const sessionState = getSessionState(payload);
  if (!sessionState) {
    return { healthy: false, detail: 'no persisted session to validate' };
  }

  // Real credential + persisted session -- only NOW do we touch
  // `playwright`. hooks.performLogin is intentionally never referenced
  // below -- this function never attempts a login.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ storageState: sessionState as never });
    const page = await context.newPage();
    const validateSession = hooks.validateSession ?? defaultValidateSession;
    const valid = await validateSession(page);
    return valid ? { healthy: true } : { healthy: false, detail: 'session invalid or expired' };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Shared session-hooks wiring -- factored out of poshmark.ts/depop.ts/
// mercari.ts/vinted.ts/grailed.ts, which each independently hand-rolled an
// identical version of this composition (only the platform-specific
// isAuthenticated/performLogin/classifySuspension functions plugged into it
// actually differed). Kept here, next to SessionHooks itself, rather than
// in any one connector file.
// ---------------------------------------------------------------------------

/**
 * Reads the current page's content and, ONLY on a positive `classify()`
 * match, records a suspension signal via lib/connections.ts#
 * recordSuspensionSignal with a scrubbed reason. Any failure reading page
 * content (navigation timeout, closed page, etc) is swallowed here and
 * treated as "nothing to report" -- an ambiguous or transient failure must
 * never trigger a suspension write. `classify` is the only platform-
 * specific piece (each connector's own classify<Platform>Suspension,
 * matching that platform's known suspension/ban banner text) -- the
 * read-content/scrub/record plumbing around it is identical everywhere.
 */
async function detectAndRecordSuspension(
  tenantId: string,
  connectionId: string,
  page: unknown,
  classify: (pageContent: string) => string | null,
): Promise<void> {
  const p = page as PlaywrightPageLike;
  let content: string;
  try {
    content = await p.content();
  } catch {
    return;
  }

  const reason = classify(content);
  if (!reason) {
    return;
  }

  // scrubSecrets is effectively a no-op here (the reason string is built
  // entirely from a static pattern match, never from raw page content) --
  // called anyway so every recordSuspensionSignal call site scrubs its
  // reason the same way.
  recordSuspensionSignal(tenantId, connectionId, scrubSecrets(reason, []), 'suspended');
}

/**
 * Builds the SessionHooks passed to every withSession/validateSessionReadOnly
 * call a Playwright-driven connector makes -- one shared choke point so
 * validateSession/performLogin behavior (and the suspension check riding
 * along with validateSession) stays identical across every connector's 5
 * Connector methods, instead of each platform file hand-rolling its own
 * copy of this wiring. `opts.isAuthenticated`/`opts.performLogin`/
 * `opts.classifySuspension` are the only platform-specific pieces (each
 * connector supplies its own isAuthenticated<Platform>Session/
 * perform<Platform>Login/classify<Platform>Suspension here) -- the
 * composition itself is not, and stays out of every connector file.
 */
export function buildSessionHooks(
  tenantId: string,
  connectionId: string,
  opts: {
    isAuthenticated: (page: PlaywrightPageLike) => Promise<boolean>;
    performLogin: (page: unknown, credential: string) => Promise<void>;
    classifySuspension: (pageContent: string) => string | null;
  },
): SessionHooks {
  return {
    validateSession: async (page) => {
      const p = page as PlaywrightPageLike;
      const authenticated = await opts.isAuthenticated(p);
      // Suspension banner text can appear on an otherwise "authenticated"
      // page (nav chrome can still render for a restricted account), so
      // this check always runs, independent of the auth result above.
      await detectAndRecordSuspension(tenantId, connectionId, p, opts.classifySuspension);
      return authenticated;
    },
    performLogin: opts.performLogin,
  };
}

/**
 * Fills a clothing listing's brand/size/color fields -- the one
 * category-specific fill sequence identical (bar which literal selector
 * strings each platform's form happens to use) across every clothing-
 * capable connector. `selectors` supplies those platform-specific literal
 * data-testid strings; this function only ever passes VALUEs into
 * Playwright's fill() (never interpolates into a selector), same
 * selector-safety rule every connector already follows individually.
 */
export async function fillClothingFields(
  page: unknown,
  details: ClothingDetails,
  selectors: { brand: string; size: string; color: string },
): Promise<void> {
  const p = page as PlaywrightPageLike;
  await p.fill(selectors.brand, details.brand ?? '');
  await p.fill(selectors.size, details.size_label ?? '');
  if (details.color) {
    await p.fill(selectors.color, details.color);
  }
}

/**
 * True if `selector` is visible on the current page -- e.g. an "item not
 * found" marker, keyed by a single stable data-testid selector. Any
 * failure reading the page (closed page, navigation error) is treated as
 * "not visible" rather than thrown, matching the same fail-safe contract
 * every visibility check in this codebase already follows. Only the
 * literal `selector` is platform-specific.
 */
export async function isElementVisible(page: unknown, selector: string): Promise<boolean> {
  try {
    return await (page as PlaywrightPageLike).isVisible(selector);
  } catch {
    return false;
  }
}

/**
 * Uploads listing photos, sorted by sort_order, by VALUE (file paths
 * handed to setInputFiles, Playwright's own documented way of attaching
 * files by path -- never through a dynamically-built selector). A no-op
 * when `photos` is empty. `selector` is the one platform-specific piece
 * (each connector's own photo-upload input's literal data-testid).
 */
export async function uploadSortedPhotos(
  page: unknown,
  photos: Photo[],
  selector: string,
): Promise<void> {
  if (photos.length === 0) {
    return;
  }
  const paths = photos
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((photo) => photo.path);
  await (page as PlaywrightPageLike).setInputFiles(selector, paths);
}
