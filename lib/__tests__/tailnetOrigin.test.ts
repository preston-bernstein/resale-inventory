import { describe, it, expect, afterEach } from 'vitest';
import { resolveTailnetOrigin } from '../tailnetOrigin';

// resolveTailnetOrigin() reads process.env.PUBLIC_ORIGIN directly (not a
// module-load-time constant like lib/photos.ts's PHOTOS_ROOT), so tests can
// just set/delete it per-case without vi.resetModules().
const ORIGINAL_PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN;

function requestWithHost(host: string | undefined): Request {
  const headers = new Headers();
  if (host !== undefined) {
    headers.set('host', host);
  }
  return new Request('http://placeholder.invalid/', { headers });
}

describe('lib/tailnetOrigin.ts resolveTailnetOrigin', () => {
  afterEach(() => {
    if (ORIGINAL_PUBLIC_ORIGIN === undefined) {
      delete process.env.PUBLIC_ORIGIN;
    } else {
      process.env.PUBLIC_ORIGIN = ORIGINAL_PUBLIC_ORIGIN;
    }
  });

  it('accepts a .ts.net MagicDNS host', () => {
    expect(resolveTailnetOrigin(requestWithHost('myapp.beta.ts.net'))).toBe(
      'https://myapp.beta.ts.net',
    );
  });

  it('accepts a .ts.net host case-insensitively', () => {
    expect(resolveTailnetOrigin(requestWithHost('MYAPP.BETA.TS.NET'))).toBe(
      'https://MYAPP.BETA.TS.NET',
    );
  });

  it('rejects localhost', () => {
    expect(resolveTailnetOrigin(requestWithHost('localhost'))).toBeNull();
  });

  it('rejects localhost with a port', () => {
    expect(resolveTailnetOrigin(requestWithHost('localhost:3000'))).toBeNull();
  });

  it('rejects the 127.0.0.1 IP literal', () => {
    expect(resolveTailnetOrigin(requestWithHost('127.0.0.1'))).toBeNull();
  });

  it('rejects the 127.0.0.1 IP literal with a port', () => {
    expect(resolveTailnetOrigin(requestWithHost('127.0.0.1:3000'))).toBeNull();
  });

  it('rejects a LAN IP literal', () => {
    expect(resolveTailnetOrigin(requestWithHost('192.168.1.50'))).toBeNull();
  });

  it('rejects a host that merely contains .ts.net but does not end in it (suffix-of-a-suffix attack)', () => {
    expect(resolveTailnetOrigin(requestWithHost('evil.ts.net.attacker.com'))).toBeNull();
  });

  it('rejects a host that starts with a real tailnet name but ends elsewhere', () => {
    expect(resolveTailnetOrigin(requestWithHost('myapp.ts.net.evil.com'))).toBeNull();
  });

  it('rejects a missing Host header', () => {
    expect(resolveTailnetOrigin(requestWithHost(undefined))).toBeNull();
  });

  it('accepts via PUBLIC_ORIGIN when Host matches a .ts.net PUBLIC_ORIGIN', () => {
    process.env.PUBLIC_ORIGIN = 'https://mybox.tailnet-name.ts.net';
    expect(resolveTailnetOrigin(requestWithHost('mybox.tailnet-name.ts.net'))).toBe(
      'https://mybox.tailnet-name.ts.net',
    );
  });

  it('accepts via PUBLIC_ORIGIN even for a non-.ts.net custom domain', () => {
    process.env.PUBLIC_ORIGIN = 'https://mybox.example.com';
    expect(resolveTailnetOrigin(requestWithHost('mybox.example.com'))).toBe(
      'https://mybox.example.com',
    );
  });

  it('still falls back to the .ts.net check when PUBLIC_ORIGIN is set but Host does not match it', () => {
    process.env.PUBLIC_ORIGIN = 'https://mybox.example.com';
    expect(resolveTailnetOrigin(requestWithHost('myapp.beta.ts.net'))).toBe(
      'https://myapp.beta.ts.net',
    );
  });

  // The cases below were added after a Stryker mutation pass on this file
  // (harden skill, 2026-07-12) surfaced survived mutants that black-box
  // testing hadn't caught — each one targets a specific line/branch that
  // was previously reachable without the assertion actually depending on
  // it behaving correctly.

  it('rejects an empty-string Host header (not just a missing one)', () => {
    expect(resolveTailnetOrigin(requestWithHost(''))).toBeNull();
  });

  it('rejects a Host header that is only a port, with no hostname (stripPort would leave it empty)', () => {
    expect(resolveTailnetOrigin(requestWithHost(':3000'))).toBeNull();
  });

  it('accepts a .ts.net host with an explicit port, dropping the port from the returned origin', () => {
    // Intentional: Tailscale Serve always terminates HTTPS on the standard
    // port (see the file-level comment), so a port on the Host header is
    // normalized away rather than carried into the returned origin.
    expect(resolveTailnetOrigin(requestWithHost('myapp.beta.ts.net:8443'))).toBe(
      'https://myapp.beta.ts.net',
    );
  });

  it('rejects a bare (unbracketed) IPv6 literal', () => {
    expect(resolveTailnetOrigin(requestWithHost('::1'))).toBeNull();
  });

  it('rejects a bracketed IPv6 literal with a port', () => {
    expect(resolveTailnetOrigin(requestWithHost('[::1]:3000'))).toBeNull();
  });

  it('rejects a bracketed IPv6 literal without a port', () => {
    expect(resolveTailnetOrigin(requestWithHost('[::1]'))).toBeNull();
  });

  it('does not strip a non-numeric colon suffix as if it were a port', () => {
    // If stripPort incorrectly treated ":foo" as a port and removed it, this
    // would wrongly resolve to the accepted host "myapp.beta.ts.net" — it
    // must not, so the whole (malformed) host is rejected instead.
    expect(resolveTailnetOrigin(requestWithHost('myapp.beta.ts.net:foo'))).toBeNull();
  });

  it('does not strip a colon suffix that ends in non-digits, even if it starts with digits', () => {
    // Distinguishes the /^\d+$/ port check from a /^\d+/ (missing trailing
    // anchor) variant, which would wrongly accept "123abc" as a port.
    expect(resolveTailnetOrigin(requestWithHost('myapp.beta.ts.net:123abc'))).toBeNull();
  });

  it('does not strip a colon suffix that starts with non-digits, even if it ends in digits', () => {
    // Distinguishes the /^\d+$/ port check from a /\d+$/ (missing leading
    // anchor) variant, which would wrongly accept "abc123" as a port.
    expect(resolveTailnetOrigin(requestWithHost('myapp.beta.ts.net:abc123'))).toBeNull();
  });

  it('ignores an empty-string PUBLIC_ORIGIN and falls through to the .ts.net check', () => {
    process.env.PUBLIC_ORIGIN = '';
    expect(resolveTailnetOrigin(requestWithHost('myapp.beta.ts.net'))).toBe(
      'https://myapp.beta.ts.net',
    );
  });

  it('rejects when PUBLIC_ORIGIN is set but Host matches neither PUBLIC_ORIGIN nor .ts.net', () => {
    process.env.PUBLIC_ORIGIN = 'https://mybox.example.com';
    expect(resolveTailnetOrigin(requestWithHost('randomhost.example.org'))).toBeNull();
  });

  it('falls through gracefully to the .ts.net check when PUBLIC_ORIGIN is a malformed URL', () => {
    process.env.PUBLIC_ORIGIN = 'not a valid url';
    expect(resolveTailnetOrigin(requestWithHost('myapp.beta.ts.net'))).toBe(
      'https://myapp.beta.ts.net',
    );
  });

  it('matches PUBLIC_ORIGIN with a port present on both PUBLIC_ORIGIN and the Host header', () => {
    process.env.PUBLIC_ORIGIN = 'https://mybox.example.com:8443';
    expect(resolveTailnetOrigin(requestWithHost('mybox.example.com:8443'))).toBe(
      'https://mybox.example.com:8443',
    );
  });
});
