import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// This repo is public. It must never re-accumulate a literal map of where it
// actually runs — a private-network address, an operator hostname, or the
// deployment's real domain. A pre-publish audit found exactly that and this
// repo was scrubbed of it (2026-08-30).
//
// This guard deliberately does NOT name the operator's real domain or LAN
// range. Writing them here to "ban" them would publish the very strings the
// scrub removed. Instead:
//
//   * IP check  — bans every RFC1918 literal generically, so it needs no
//     knowledge of which range is real. 172.16.0.0/12 is carved out as the
//     sanctioned fixture range (tests that must exercise LAN-shaped input,
//     e.g. `lib/__tests__/tailnetOrigin.test.ts`, live there), as are the
//     RFC 5737 documentation ranges.
//   * Literal check — reads its needles from OPSEC_FORBIDDEN_LITERALS (a
//     comma-separated list) so CI can supply real identifiers as a secret.
//     Unset locally, that half is skipped rather than failed, so an outside
//     contributor's checkout still runs green.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../..');

// Any RFC1918 literal, minus the sanctioned fixture range 172.16.0.0/12.
const PRIVATE_IP_RE = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/;

// Loopback and the "network address" forms used in prose/CIDR docs are fine.
const IP_ALLOWLIST = /\b(?:10\.0\.0\.0|192\.168\.0\.0|192\.168\.1\.0|127\.0\.0\.1)\b/;

// Repo-name-derived deployment names. Not secret (they are just this repo's
// own name), but pinned so a future change cannot quietly hardcode a real
// deployed path back into the tree.
const FORBIDDEN_SUBSTRINGS = [
  'internal-inventory-app.service',
  'internal-inventory-app-firewall',
  '/home/internal-inventory-app',
];

// Real operator identifiers (domain, SSH alias, …) come from the environment
// so they never appear in this public file.
const ENV_FORBIDDEN = (process.env.OPSEC_FORBIDDEN_LITERALS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const SELF_PATH = path.relative(REPO_ROOT, __filename).split(path.sep).join('/');

function listTrackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && f !== SELF_PATH);
}

const SKIP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2']);
const isScannable = (p: string) => !SKIP_EXTENSIONS.has(path.extname(p));

function read(relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
  } catch {
    return null; // deleted-but-still-listed race, or unreadable — not this test's concern
  }
}

describe('public-repo opsec: no real infra literals in tracked source', () => {
  const trackedFiles = listTrackedTextFiles().filter(isScannable);

  it('found at least one tracked file to scan (sanity check the scan itself runs)', () => {
    expect(trackedFiles.length).toBeGreaterThan(50);
  });

  it('never hardcodes a real deployed service name or path', () => {
    const offenders: string[] = [];
    for (const relPath of trackedFiles) {
      const content = read(relPath);
      if (content === null) continue;
      for (const needle of FORBIDDEN_SUBSTRINGS) {
        if (content.toLowerCase().includes(needle.toLowerCase())) {
          offenders.push(`${relPath}: contains forbidden literal "${needle}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never re-introduces a private-network IP literal outside the fixture range', () => {
    const offenders: string[] = [];
    for (const relPath of trackedFiles) {
      const content = read(relPath);
      if (content === null) continue;
      for (const line of content.split('\n')) {
        if (IP_ALLOWLIST.test(line)) continue;
        const match = line.match(PRIVATE_IP_RE);
        if (match) offenders.push(`${relPath}: private-network IP literal "${match[0]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.skipIf(ENV_FORBIDDEN.length === 0)(
    'never re-introduces operator identifiers supplied via OPSEC_FORBIDDEN_LITERALS',
    () => {
      const offenders: string[] = [];
      for (const relPath of trackedFiles) {
        const content = read(relPath);
        if (content === null) continue;
        for (const needle of ENV_FORBIDDEN) {
          if (content.toLowerCase().includes(needle.toLowerCase())) {
            offenders.push(`${relPath}: contains a forbidden operator identifier`);
          }
        }
      }
      expect(offenders).toEqual([]);
    },
  );
});
