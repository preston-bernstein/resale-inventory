import { rename, writeFile } from 'fs/promises';
import path from 'path';
import { logEvent } from '@/lib/log';

// ---------------------------------------------------------------------------
// Forward-auth verification outcome counters (2026-08-01 security fix).
//
// Why not a `/metrics` HTTP route: this app fronts a public domain
// (resale-inventory.houseoflight.dev via Caddy). Adding a new unauthenticated
// route is a new public attack surface on a service this task was scoped to
// make MORE conservative, not less -- and CONVENTIONS.md #18's own minimum
// metric set for a long-lived service assumes Prometheus can already reach
// it, which nothing in this repo controls (the scrape config lives in the
// home-infra repo, a separate deploy). Given that, the safer, fully
// self-contained choice is the node-exporter TEXTFILE COLLECTOR path
// CONVENTIONS.md #18 documents for services it can't scrape directly: write a
// `.prom` file to a directory node-exporter already watches on the same
// host. Nothing here is reachable over the network.
//
// Wiring `NODE_EXPORTER_TEXTFILE_DIR` to the real host path
// (`/opt/docker/observability/node-exporter-textfiles/`) plus the
// corresponding Prometheus alert rule is a home-infra-side, deploy-time
// change -- explicitly OUT OF SCOPE for this change (see the commit message
// and PR description: "DO NOT DEPLOY", deploy is sequenced separately). Until
// that env var is set on the deployed unit, this module still tracks counts
// in-process (inspectable by tests, and by whatever wires the env var later)
// but writes nothing to disk -- see writeForwardAuthTextfile's early return.
// ---------------------------------------------------------------------------

const FORWARD_AUTH_OUTCOME_COUNTS = new Map<string, number>();

const TEXTFILE_NAME = 'resale_inventory_forward_auth.prom';

/**
 * Record one forward-auth verification attempt's outcome. `outcome` is
 * either the literal `'verified'` or a ForwardAuthFailureReason (kept as a
 * plain `string` here, not the imported union type, so this module has no
 * compile-time dependency on lib/forwardAuth.ts's exact reason set --
 * metrics code should not need updating every time a new failure reason is
 * added there).
 *
 * Returns the textfile-write promise so tests can `await` it for
 * determinism; production callers (middleware.ts) deliberately do NOT await
 * it -- a metrics-write failure/slowness must never delay or affect the
 * request whose outcome triggered it. writeForwardAuthTextfile itself never
 * throws (see its own try/catch), so an un-awaited call here can't produce
 * an unhandled rejection either way.
 */
export function recordForwardAuthOutcome(outcome: string): Promise<void> {
  FORWARD_AUTH_OUTCOME_COUNTS.set(outcome, (FORWARD_AUTH_OUTCOME_COUNTS.get(outcome) ?? 0) + 1);
  return writeForwardAuthTextfile();
}

/** Read-only snapshot for tests. Not used by production code. */
export function getForwardAuthOutcomeCounts(): ReadonlyMap<string, number> {
  return FORWARD_AUTH_OUTCOME_COUNTS;
}

/** Test-only reset so counter state doesn't leak between test cases/files. */
export function resetForwardAuthOutcomeCountsForTests(): void {
  FORWARD_AUTH_OUTCOME_COUNTS.clear();
}

async function writeForwardAuthTextfile(): Promise<void> {
  const dir = process.env.NODE_EXPORTER_TEXTFILE_DIR;
  if (dir === undefined || dir === '') {
    return;
  }

  try {
    // Prometheus text format requires each metric NAME's `# HELP`/`# TYPE`
    // pair to appear exactly once, immediately before that metric's samples
    // -- never once per sample, and never omitted. A malformed file (or one
    // missing HELP/TYPE for any metric it emits) makes node-exporter's
    // textfile collector reject the ENTIRE file
    // (node_textfile_scrape_error=1), silencing every metric from this
    // service, not just the malformed one. Verified against
    // `promtool check metrics` (see tests/metrics.test.ts) -- a prior
    // version of this function emitted the last-write-timestamp sample with
    // no HELP/TYPE at all, which promtool rejects ("no help text").
    const lines: string[] = [
      '# HELP resale_inventory_forward_auth_outcomes_total Forward-auth (Authentik) JWT verification attempts by outcome.',
      '# TYPE resale_inventory_forward_auth_outcomes_total counter',
    ];
    for (const [outcome, count] of FORWARD_AUTH_OUTCOME_COUNTS) {
      lines.push(`resale_inventory_forward_auth_outcomes_total{outcome="${outcome}"} ${count}`);
    }
    lines.push(
      '# HELP resale_inventory_forward_auth_last_write_timestamp_seconds Unix timestamp (seconds) of the last time this textfile was written.',
      '# TYPE resale_inventory_forward_auth_last_write_timestamp_seconds gauge',
      `resale_inventory_forward_auth_last_write_timestamp_seconds ${Math.floor(Date.now() / 1000)}`,
    );

    const finalPath = path.join(dir, TEXTFILE_NAME);
    const tmpPath = `${finalPath}.tmp`;
    // Write to a temp file then rename -- an atomic replace within the same
    // directory, so node-exporter's own scrape of this directory never
    // observes a half-written file (CONVENTIONS.md #18: "a malformed .prom
    // file... silences node-exporter's entire textfile collector").
    await writeFile(tmpPath, `${lines.join('\n')}\n`, 'utf8');
    await rename(tmpPath, finalPath);
  } catch (err) {
    logEvent('warn', 'metrics.textfile_write_failed', 'Failed to write forward-auth metrics textfile', {
      err_type: err instanceof Error ? err.name : 'Unknown',
      err_msg: err instanceof Error ? err.message : String(err),
    });
  }
}
