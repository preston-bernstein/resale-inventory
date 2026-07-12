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
});
