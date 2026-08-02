import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  recordForwardAuthOutcome,
  resetForwardAuthOutcomeCountsForTests,
} from '../lib/metrics';

// ---------------------------------------------------------------------------
// Regression coverage for the estate-scraper-class bug: a node-exporter
// textfile collector rejects the ENTIRE .prom file (not just the offending
// metric) if `# HELP`/`# TYPE` for any metric name is missing, duplicated
// per-sample, or a gauge is misleadingly named with the counter-only
// `_total` suffix. `docker run ... promtool check metrics` is the same tool
// node-exporter itself uses to validate a textfile before scraping it, so
// this test shells out to it for a real, non-hand-rolled check rather than
// re-implementing Prometheus text-format parsing rules here.
// ---------------------------------------------------------------------------

let scratchDir: string;
const dockerAvailable = (() => {
  try {
    execFileSync('docker', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

beforeEach(async () => {
  resetForwardAuthOutcomeCountsForTests();
  scratchDir = await mkdtemp(path.join(tmpdir(), 'resale-inventory-metrics-'));
  process.env.NODE_EXPORTER_TEXTFILE_DIR = scratchDir;
});

afterEach(async () => {
  delete process.env.NODE_EXPORTER_TEXTFILE_DIR;
  await rm(scratchDir, { recursive: true, force: true });
});

describe('writeForwardAuthTextfile (via recordForwardAuthOutcome)', () => {
  it('writes a .prom file readable by group/other (node_exporter runs as a different user)', async () => {
    await recordForwardAuthOutcome('verified');
    const filePath = path.join(scratchDir, 'resale_inventory_forward_auth.prom');
    const { stat } = await import('fs/promises');
    const stats = await stat(filePath);
    // 0600 (owner-only) is the proven-today failure mode: node_exporter runs
    // as a different unix user (`observability`) and silently never picks up
    // an unreadable file. Assert group- and other-readable bits are set,
    // not an exact mode -- umask varies by host and only the readability
    // bits are load-bearing here.
    const mode = stats.mode & 0o777;
    expect(mode & 0o044).toBe(0o044);
  });

  it.skipIf(!dockerAvailable)(
    'produces output that passes `promtool check metrics` with several outcomes recorded',
    async () => {
      await recordForwardAuthOutcome('verified');
      await recordForwardAuthOutcome('verified');
      await recordForwardAuthOutcome('invalid_algorithm');
      await recordForwardAuthOutcome('jwks_unreachable');
      await recordForwardAuthOutcome('token_expired');

      const filePath = path.join(scratchDir, 'resale_inventory_forward_auth.prom');
      const content = await readFile(filePath, 'utf8');

      // Regression guard mirrored from the estate-scraper audit: HELP/TYPE
      // must appear exactly once per metric name, never once per sample.
      const helpLines = content.split('\n').filter((l) => l.startsWith('# HELP'));
      const metricNames = helpLines.map((l) => l.split(' ')[2]);
      expect(new Set(metricNames).size).toBe(metricNames.length);

      // Regression guard: gauges must not use the counter-reserved `_total`
      // suffix. The only `_total`-suffixed metric here must be TYPE counter.
      const typeLines = content
        .split('\n')
        .filter((l) => l.startsWith('# TYPE'))
        .map((l) => l.split(' '));
      for (const [, , name, type] of typeLines) {
        if (name.endsWith('_total')) {
          expect(type).toBe('counter');
        } else {
          expect(type).not.toBe('counter');
        }
      }

      expect(() =>
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '-i',
            '--entrypoint=promtool',
            'prom/prometheus:v3.5.0',
            'check',
            'metrics',
          ],
          { input: content, stdio: ['pipe', 'pipe', 'pipe'] },
        ),
      ).not.toThrow();
    },
    30_000,
  );
});
