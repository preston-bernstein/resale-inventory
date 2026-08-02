import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  getForwardAuthOutcomeCounts,
  recordForwardAuthOutcome,
  resetForwardAuthOutcomeCountsForTests,
} from '@/lib/metrics';

describe('recordForwardAuthOutcome / getForwardAuthOutcomeCounts', () => {
  const prevDir = process.env.NODE_EXPORTER_TEXTFILE_DIR;

  beforeEach(() => {
    resetForwardAuthOutcomeCountsForTests();
    delete process.env.NODE_EXPORTER_TEXTFILE_DIR;
  });

  afterEach(() => {
    if (prevDir === undefined) {
      delete process.env.NODE_EXPORTER_TEXTFILE_DIR;
    } else {
      process.env.NODE_EXPORTER_TEXTFILE_DIR = prevDir;
    }
  });

  it('starts empty', () => {
    expect(getForwardAuthOutcomeCounts().size).toBe(0);
  });

  it('increments a fresh outcome to 1', async () => {
    await recordForwardAuthOutcome('verified');
    expect(getForwardAuthOutcomeCounts().get('verified')).toBe(1);
  });

  it('accumulates repeated outcomes of the same reason -- this is the "repeated validation failure is alertable" contract', async () => {
    await recordForwardAuthOutcome('jwks_unreachable');
    await recordForwardAuthOutcome('jwks_unreachable');
    await recordForwardAuthOutcome('jwks_unreachable');

    expect(getForwardAuthOutcomeCounts().get('jwks_unreachable')).toBe(3);
  });

  it('tracks distinct outcomes independently', async () => {
    await recordForwardAuthOutcome('verified');
    await recordForwardAuthOutcome('token_expired');
    await recordForwardAuthOutcome('verified');

    const counts = getForwardAuthOutcomeCounts();
    expect(counts.get('verified')).toBe(2);
    expect(counts.get('token_expired')).toBe(1);
  });

  it('resetForwardAuthOutcomeCountsForTests clears all counts', async () => {
    await recordForwardAuthOutcome('verified');
    resetForwardAuthOutcomeCountsForTests();

    expect(getForwardAuthOutcomeCounts().size).toBe(0);
  });
});

describe('recordForwardAuthOutcome textfile export (node-exporter textfile collector)', () => {
  const prevDir = process.env.NODE_EXPORTER_TEXTFILE_DIR;
  let scratchDir: string;

  beforeEach(async () => {
    resetForwardAuthOutcomeCountsForTests();
    scratchDir = await mkdtemp(path.join(tmpdir(), 'internal-inventory-app-metrics-test-'));
  });

  afterEach(async () => {
    if (prevDir === undefined) {
      delete process.env.NODE_EXPORTER_TEXTFILE_DIR;
    } else {
      process.env.NODE_EXPORTER_TEXTFILE_DIR = prevDir;
    }
    await rm(scratchDir, { recursive: true, force: true });
  });

  it('writes nothing when NODE_EXPORTER_TEXTFILE_DIR is unset (inert until deploy-time wiring)', async () => {
    delete process.env.NODE_EXPORTER_TEXTFILE_DIR;

    await recordForwardAuthOutcome('verified');

    const entries = await readFile(path.join(scratchDir, 'resale_inventory_forward_auth.prom'), {
      encoding: 'utf8',
    }).catch((err: NodeJS.ErrnoException) => err.code);
    expect(entries).toBe('ENOENT');
  });

  it('writes a well-formed Prometheus textfile when NODE_EXPORTER_TEXTFILE_DIR is set', async () => {
    process.env.NODE_EXPORTER_TEXTFILE_DIR = scratchDir;

    await recordForwardAuthOutcome('verified');
    await recordForwardAuthOutcome('token_expired');
    await recordForwardAuthOutcome('token_expired');

    const contents = await readFile(
      path.join(scratchDir, 'resale_inventory_forward_auth.prom'),
      'utf8',
    );

    expect(contents).toContain('# HELP resale_inventory_forward_auth_outcomes_total');
    expect(contents).toContain('# TYPE resale_inventory_forward_auth_outcomes_total counter');
    expect(contents).toContain('resale_inventory_forward_auth_outcomes_total{outcome="verified"} 1');
    expect(contents).toContain(
      'resale_inventory_forward_auth_outcomes_total{outcome="token_expired"} 2',
    );
    expect(contents).toMatch(
      /resale_inventory_forward_auth_last_write_timestamp_seconds \d+/,
    );
    // No stray .tmp file left behind -- the write-then-rename must be atomic.
    const tmpFileContents = await readFile(
      path.join(scratchDir, 'resale_inventory_forward_auth.prom.tmp'),
      'utf8',
    ).catch((err: NodeJS.ErrnoException) => err.code);
    expect(tmpFileContents).toBe('ENOENT');
  });

  it('logs a warning (never throws) when the textfile directory does not exist, so a request-path failure is impossible', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.NODE_EXPORTER_TEXTFILE_DIR = path.join(scratchDir, 'does-not-exist');

    await expect(recordForwardAuthOutcome('verified')).resolves.toBeUndefined();

    expect(consoleLogSpy).toHaveBeenCalled();
    const loggedLines = consoleLogSpy.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(
      loggedLines.some(
        (line) => line.event === 'metrics.textfile_write_failed' && line.level === 'warn',
      ),
    ).toBe(true);

    consoleLogSpy.mockRestore();
  });
});
