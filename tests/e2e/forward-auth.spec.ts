import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { MOCK_JWKS_FIXED_E2E_PORT } from './fixtures/mockJwksServer';

// ---------------------------------------------------------------------------
// Forward-auth (Authentik) E2E coverage -- AC10 / the "mockable JWKS/JWT" NFR.
//
// Exercises the full header-in / cookie-out flow (middleware.ts's
// applyForwardAuth, via lib/forwardAuth.ts's verifyAuthentikJwt) against a
// real running app with NO live Authentik instance -- the mock JWKS server
// (tests/e2e/fixtures/mockJwksServer.ts) stands in for Authentik's JWKS
// endpoint, started by tests/e2e/globalSetup.ts on a fixed port BEFORE the
// webServer (`next dev`) boots, so playwright.config.ts's webServer.env can
// point AUTHENTIK_JWKS_URL/AUTHENTIK_ISSUER/AUTHENTIK_AUDIENCE at it
// statically.
//
// The mock server runs in the process that ran globalSetup, not this spec
// file's worker process -- its signToken() closure isn't reachable directly
// from here, so tokens are minted via an HTTP POST to its /sign endpoint
// instead (see mockJwksServer.ts's signToken doc comment).
//
// Unlike the rest of this suite, this spec must NOT use the shared E2E
// tenant / storageState from auth.setup.ts: it needs a fresh tenant whose
// email exactly matches what gets signed into the mock JWT, and it needs
// precise control over which requests carry a session cookie and which
// don't (the whole point is proving cookie-out follows header-in, and that
// the resulting cookie alone is sufficient afterwards). Using the
// `request` API-testing context directly (not `page`) keeps that control
// explicit and avoids a real browser needing to navigate through /login.
// ---------------------------------------------------------------------------

test.use({ storageState: { cookies: [], origins: [] } });

const BASE_URL = 'http://127.0.0.1:3100';
const MOCK_JWKS_SERVER_ORIGIN = `http://127.0.0.1:${MOCK_JWKS_FIXED_E2E_PORT}`;
const JWT_HEADER = 'X-Authentik-Jwt';
const SESSION_COOKIE_NAME = 'reseller_session';

/**
 * Sign a JWT for `email` against the mock JWKS server's private key, over
 * HTTP (see the file-level comment on why this can't be an in-process call).
 * `context` can be any APIRequestContext -- it's just an HTTP client here,
 * not the one that talks to the app under test.
 */
async function signMockToken(context: APIRequestContext, email: string): Promise<string> {
  const res = await context.post(`${MOCK_JWKS_SERVER_ORIGIN}/sign`, {
    data: { claims: { email } },
  });
  expect(res.ok(), `mock JWKS /sign failed: ${res.status()} ${await res.text()}`).toBe(true);
  const body = (await res.json()) as { token: string };
  return body.token;
}

test.describe('forward-auth (AC10): header-in cookie-out, no live Authentik instance', () => {
  test('a verified X-Authentik-Jwt establishes a session cookie, and the cookie alone authenticates a follow-up request', async () => {
    // --- Step 1/3: create a real tenant whose email the JWT will carry. ---
    // findTenantByEmail (middleware.ts) requires a known tenant -- an
    // otherwise-valid JWT for an unknown email gets redirected to
    // /login?sso_error=unmatched instead of establishing a session, so this
    // step is load-bearing, not incidental setup.
    const email = `forward-auth-e2e-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.invalid`;
    const password = 'forward-auth-e2e-test-password';

    const signupContext = await apiRequest.newContext({ baseURL: BASE_URL });
    try {
      const signupRes = await signupContext.post('/api/auth/signup', {
        data: { email, password },
      });
      expect(
        signupRes.ok(),
        `signup failed: ${signupRes.status()} ${await signupRes.text()}`,
      ).toBe(true);
    } finally {
      // Discarded, not reused: its cookie jar now holds the signup's own
      // session cookie, which must not leak into the forward-auth request
      // below (that request needs to start with NO reseller_session cookie).
      await signupContext.dispose();
    }

    // --- Step 2: sign a JWT for that email (see signMockToken above). ---
    const signerContext = await apiRequest.newContext();
    let jwt: string;
    try {
      jwt = await signMockToken(signerContext, email);
    } finally {
      await signerContext.dispose();
    }

    // --- Step 3/4: header-in, cookie-out -- a fresh, cookie-less context ---
    // presents the JWT on a page route (/dashboard, which redirects
    // server-side to /login when unauthenticated -- see app/dashboard/page.tsx
    // -- so a 200 here is real evidence the middleware established a
    // session, not just that the route happens not to require one).
    const forwardAuthContext = await apiRequest.newContext({ baseURL: BASE_URL });
    try {
      const firstRes = await forwardAuthContext.get('/dashboard', {
        headers: { [JWT_HEADER]: jwt },
        maxRedirects: 0,
      });
      expect(
        firstRes.status(),
        `expected no redirect to login; got ${firstRes.status()}: ${await firstRes.text()}`,
      ).toBe(200);

      const state = await forwardAuthContext.storageState();
      const sessionCookie = state.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
      expect(
        sessionCookie,
        'expected the verified JWT to establish a reseller_session cookie',
      ).toBeDefined();

      // --- Step 5: a second request, same context (cookie jar now carries ---
      // the session cookie), with NO X-Authentik-Jwt header -- must succeed
      // on the cookie alone, without needing a new JWT.
      const secondRes = await forwardAuthContext.get('/dashboard', { maxRedirects: 0 });
      expect(
        secondRes.status(),
        `expected the session cookie alone to authenticate; got ${secondRes.status()}: ${await secondRes.text()}`,
      ).toBe(200);
    } finally {
      await forwardAuthContext.dispose();
    }
  });
});
