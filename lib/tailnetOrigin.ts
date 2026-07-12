import net from 'net';

// Tailnet origin detection for the phone-handoff QR feature.
//
// This is an ALLOWLIST, not a blocklist, by design. A blocklist approach
// (reject only `localhost` / IP literals, accept everything else) would let
// an attacker-controlled `Host` header — spoofed or produced by a misrouted
// proxy — through unchanged, and that value gets embedded in a QR code the
// operator's phone then navigates to. That's an origin-injection path: scan
// the QR, land on the attacker's origin instead of this box's tailnet
// address. Allowlisting to the Tailscale MagicDNS suffix (`.ts.net`) or an
// explicit operator-configured `PUBLIC_ORIGIN` closes that gap — only hosts
// we recognize as "this box, reachable over the tailnet" can produce a URL.
//
// Tailscale Serve always terminates HTTPS (see docs/PHONE-ACCESS.md), so any
// accepted `.ts.net` host is returned as `https://<host>`.

const TAILSCALE_SUFFIX = '.ts.net';

export function resolveTailnetOrigin(request: Request): string | null {
  const rawHost = request.headers.get('host');
  if (rawHost === null || rawHost.trim() === '') {
    return null;
  }

  // Host headers may include a port (e.g. `localhost:3000`); strip it before
  // validating the hostname portion. Bracketed IPv6 literals (`[::1]:3000`)
  // are handled too, though net.isIP() below is what actually rejects them.
  const host = stripPort(rawHost.trim());
  if (host === '') {
    return null;
  }

  const publicOrigin = process.env.PUBLIC_ORIGIN;
  if (publicOrigin) {
    let publicHostname = '';
    try {
      publicHostname = new URL(publicOrigin).hostname;
    } catch {
      publicHostname = '';
    }
    if (publicHostname !== '' && host.toLowerCase() === publicHostname.toLowerCase()) {
      return publicOrigin;
    }
  }

  // Reject IP literals explicitly (localhost, 127.0.0.1, 192.168.x.x, IPv6,
  // etc.) — net.isIP() returns 0 for non-IP strings, 4 or 6 otherwise.
  if (net.isIP(host) !== 0) {
    return null;
  }

  // Must literally END in the Tailscale MagicDNS suffix — not merely contain
  // it — so `evil.ts.net.attacker.com` (ends in `.attacker.com`) and
  // `myapp.ts.net.evil.com` (ends in `.evil.com`) are correctly rejected.
  if (host.toLowerCase().endsWith(TAILSCALE_SUFFIX)) {
    return `https://${host}`;
  }

  return null;
}

function stripPort(host: string): string {
  // Bracketed IPv6 literal, e.g. "[::1]:3000" or "[::1]".
  if (host.startsWith('[')) {
    const closeBracket = host.indexOf(']');
    return closeBracket === -1 ? host : host.slice(0, closeBracket + 1);
  }
  const lastColon = host.lastIndexOf(':');
  if (lastColon === -1) {
    return host;
  }
  // Only treat this as a port separator if everything after it is digits
  // (a bare IPv6 literal like "::1" also contains colons but no brackets).
  const maybePort = host.slice(lastColon + 1);
  if (/^\d+$/.test(maybePort)) {
    return host.slice(0, lastColon);
  }
  return host;
}
