import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// This repo is public. It must never re-accumulate a literal map of where it
// actually runs — the real domain, or an IP address on the operator's real
// home network — the same class of finding a pre-publish audit flagged and
// this repo was scrubbed of (2026-08-30).
//
// Scope note on "RFC1918 address": banning every RFC1918 literal outright
// would break legitimate test fixtures elsewhere in this suite that need a
// private/LAN-shaped IP to exercise real logic (e.g. "reject a LAN IP as a
// tailnet origin", `lib/__tests__/tailnetOrigin.test.ts`). Those fixtures
// were deliberately moved onto 172.16.0.0/12, which is RFC1918 but is NOT
// part of the operator's actual network (the real LAN is 10.0.0.0/24; the
// real, now-retired secondary network was 192.168.1.0/24) — so this test
// bans literals from the operator's actual real ranges plus the real
// domain, and explicitly leaves 172.16.0.0/12 (and RFC 5737 documentation
// addresses like 203.0.113.0/24) alone as the sanctioned fixture ranges.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../..');

const FORBIDDEN_DOMAIN = 'houseoflight.dev';

// The operator's actual current LAN (10.0.0.0/24) and former secondary
// network (192.168.1.0/24, retired 2026-08-28) — see reference docs in the
// operator's private notes. Neither should ever appear in this public repo.
const FORBIDDEN_IP_PATTERNS = [
  /\b10\.0\.0\.\d{1,3}\b/,
  /\b192\.168\.1\.\d{1,3}\b/,
];

// Other real-infra identifiers the 2026-08-30 audit found alongside the
// domain/IPs (SSH alias, dedicated service-user pattern, systemd unit
// names, real deployed filesystem path). Banned as plain substrings.
const FORBIDDEN_SUBSTRINGS = [
  FORBIDDEN_DOMAIN,
  'desktop-agent',
  'resale-inventory.service',
  'resale-inventory-firewall',
  '/home/resale-inventory',
];

// This test file itself necessarily contains the forbidden strings above
// (as data, to define what's forbidden) — exclude it from its own scan.
const SELF_PATH = path
  .relative(REPO_ROOT, __filename)
  .split(path.sep)
  .join('/');

function listTrackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && f !== SELF_PATH);
}

// Binary/generated files git ls-files may still list (icons, lockfiles are
// text but huge/noisy) — skip anything that isn't a source/docs file we'd
// ever hand-author, plus package-lock.json which can legitimately contain
// upstream package "resolved" URLs unrelated to this repo's own topology.
const SKIP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2']);

function isScannable(relPath: string): boolean {
  const ext = path.extname(relPath);
  return !SKIP_EXTENSIONS.has(ext);
}

describe('public-repo opsec: no real infra literals in tracked source', () => {
  const trackedFiles = listTrackedTextFiles().filter(isScannable);

  it('found at least one tracked file to scan (sanity check the scan itself runs)', () => {
    expect(trackedFiles.length).toBeGreaterThan(50);
  });

  it('never re-introduces the real domain or real SSH-alias/service-name/path literals', () => {
    const offenders: string[] = [];
    for (const relPath of trackedFiles) {
      const absPath = path.join(REPO_ROOT, relPath);
      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf8');
      } catch {
        continue; // deleted-but-still-listed race, or genuinely unreadable — not this test's concern
      }
      for (const needle of FORBIDDEN_SUBSTRINGS) {
        if (content.toLowerCase().includes(needle.toLowerCase())) {
          offenders.push(`${relPath}: contains forbidden literal "${needle}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never re-introduces a literal IP on the operator\'s real home network', () => {
    const offenders: string[] = [];
    for (const relPath of trackedFiles) {
      const absPath = path.join(REPO_ROOT, relPath);
      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf8');
      } catch {
        continue;
      }
      for (const pattern of FORBIDDEN_IP_PATTERNS) {
        const match = content.match(pattern);
        if (match) {
          offenders.push(`${relPath}: contains real-LAN-shaped IP literal "${match[0]}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
