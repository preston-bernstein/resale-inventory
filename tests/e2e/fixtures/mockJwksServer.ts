import http from 'http';
import type { AddressInfo } from 'net';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

// ---------------------------------------------------------------------------
// Mock Authentik JWKS server, for E2E tests only.
//
// Later E2E coverage (a forward-auth spec, not yet written as of this file)
// needs to: (1) sign a test JWT against a known private key, (2) point the
// app's AUTHENTIK_JWKS_URL at a real, network-reachable HTTP endpoint that
// serves the matching public JWKS document, (3) inject that JWT as the
// X-Authentik-Jwt header on a request, and (4) confirm the app's middleware
// (lib/forwardAuth.ts's verifyAuthentikJwt, via jose's createRemoteJWKSet)
// verifies it and resolves a tenant session. Hitting a live Authentik
// instance for that would be slow and flaky; this fixture stands in for it
// with a tiny in-process http.createServer that always serves one RSA
// keypair's public half as a standards-shaped JWKS document, and exposes a
// signToken() helper closed over the matching private key so a test can
// mint tokens that verify against what the server serves.
//
// Not a general-purpose OIDC/Authentik mock: no discovery document, no
// token endpoint, no key rotation -- just the one JWKS GET that
// createRemoteJWKSet needs, kept minimal on purpose.
// ---------------------------------------------------------------------------

const KEY_ID = 'mock-authentik-key';

// Defaults line up with the AUTHENTIK_ISSUER / AUTHENTIK_AUDIENCE shape used
// elsewhere in this repo's forward-auth tests (see tests/api/forwardAuth.test.ts)
// so a consuming spec can omit them entirely for the common case, or override
// per-call to exercise issuer/audience mismatch scenarios.
export const MOCK_AUTHENTIK_ISSUER = 'https://mock-authentik.example.invalid/application/o/resale/';
export const MOCK_AUTHENTIK_AUDIENCE = 'resale-inventory';

// Fixed port for the forward-auth E2E spec (tests/e2e/forward-auth.spec.ts).
// playwright.config.ts's webServer.env is evaluated -- and used to spawn
// `next dev` -- BEFORE any spec file runs, so AUTHENTIK_JWKS_URL must be
// known statically at config-eval time. That's incompatible with this
// server's normal OS-assigned-port mode (the port wouldn't exist yet when
// the config is read), so the forward-auth spec's Playwright `globalSetup`
// starts this server on this hardcoded port instead, and playwright.config.ts
// references the same constant when building AUTHENTIK_JWKS_URL. Picked
// arbitrarily in the high, rarely-used range; only in play for the duration
// of one local Playwright run.
export const MOCK_JWKS_FIXED_E2E_PORT = 41234;

export interface StartMockJwksServerOptions {
  /** Bind to this exact port instead of an OS-assigned one. See MOCK_JWKS_FIXED_E2E_PORT. */
  port?: number;
}

export interface SignTokenOptions {
  /** Overrides the default issuer -- set to something else to test a rejected mismatch. */
  issuer?: string;
  /** Overrides the default audience -- set to something else to test a rejected mismatch. */
  audience?: string;
  /** jose "time span" string, e.g. '10m', '-1m' for an already-expired token. Defaults to '10m'. */
  expiresIn?: string;
  /** Overrides the protected header's `alg`/`kid` -- used to build deliberately-invalid tokens. Defaults to RS256 / KEY_ID. */
  protectedHeader?: Record<string, unknown>;
}

export interface MockJwksServer {
  /** Base URL of the mock JWKS endpoint -- suitable for AUTHENTIK_JWKS_URL in a test (over plain HTTP; see note below on forwardAuth.ts's https:// requirement). */
  url: string;
  /** The port the server is bound to on 127.0.0.1. */
  port: number;
  /**
   * Sign a JWT against this server's private key, whose matching public key
   * is what the server's /jwks response contains. Defaults to the issuer/
   * audience this fixture publishes; override to build negative-path tokens.
   *
   * In-process callers (e.g. tests/api/forwardAuth.test.ts, which runs in
   * the same Node process it starts the server from) can call this
   * directly. A Playwright spec started via this file's `globalSetup`
   * (tests/e2e/globalSetup.ts) runs in a *different* process than the one
   * that called startMockJwksServer() -- for that case, POST claims/options
   * as JSON to this server's `/sign` path instead (same signing logic,
   * exposed over HTTP so it's reachable across the process boundary).
   */
  signToken: (claims?: Record<string, unknown>, options?: SignTokenOptions) => Promise<string>;
  /** Stop the server and release its port. Safe to call once; awaits server.close(). */
  stop: () => Promise<void>;
}

/**
 * Start a local mock JWKS HTTP server, by default on an OS-assigned port
 * (pass `{ port: MOCK_JWKS_FIXED_E2E_PORT }` for the fixed-port mode the
 * forward-auth E2E spec's globalSetup needs). Every request (regardless of
 * path) gets the same JWKS JSON body -- a real Authentik deployment mounts
 * this document at a fixed path, but nothing about verification cares what
 * that path is beyond it matching AUTHENTIK_JWKS_URL, so keeping this
 * endpoint path-agnostic avoids duplicating that convention here.
 *
 * NOTE: this serves plain http://, but lib/forwardAuth.ts's module-load
 * validation rejects any AUTHENTIK_JWKS_URL that isn't https:// (see that
 * file's parsedJwksUrl check). A consuming E2E test pointing the real app at
 * this fixture will need to account for that -- e.g. relaxing the check for
 * the test environment, or fronting this server with TLS -- which is outside
 * this fixture's scope; it exists to serve a valid JWKS document reliably,
 * not to satisfy that scheme check.
 */
export async function startMockJwksServer(
  options: StartMockJwksServerOptions = {},
): Promise<MockJwksServer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });

  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = KEY_ID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const jwksBody = JSON.stringify({ keys: [publicJwk] });

  const server = http.createServer((req, res) => {
    const requestPath = (req.url ?? '').split('?')[0];

    // POST /sign -- cross-process signing surface. See the MockJwksServer.signToken
    // doc comment above for why a Playwright spec (running in a worker process
    // distinct from whatever started this server via globalSetup) needs an
    // HTTP path instead of just calling the signToken() closure directly.
    if (req.method === 'POST' && requestPath === '/sign') {
      let rawBody = '';
      req.on('data', (chunk: Buffer) => {
        rawBody += chunk.toString('utf8');
      });
      req.on('end', () => {
        void (async () => {
          try {
            const parsed = rawBody.length > 0 ? JSON.parse(rawBody) : {};
            const token = await signToken(parsed.claims, parsed.options);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ token }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ error: err instanceof Error ? err.message : 'sign failed' }),
            );
          }
        })();
      });
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(jwksBody);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = `http://127.0.0.1:${port}/jwks`;

  async function signToken(
    claims: Record<string, unknown> = {},
    options: SignTokenOptions = {},
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, ...options.protectedHeader })
      .setIssuedAt()
      .setIssuer(options.issuer ?? MOCK_AUTHENTIK_ISSUER)
      .setAudience(options.audience ?? MOCK_AUTHENTIK_AUDIENCE)
      .setExpirationTime(options.expiresIn ?? '10m')
      .sign(privateKey);
  }

  function stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return { url, port, signToken, stop };
}
