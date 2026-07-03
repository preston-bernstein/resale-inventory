import type BetterSqlite3 from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Startup backup routine (plan.md Risk 6 / DR-2).
//
// data/inventory.db is the sole copy of all inventory data. On server startup
// we snapshot it to data/backups/inventory-YYYYMMDD.db, keeping the newest
// RETENTION copies, to protect against accidental deletion or corruption.
//
// Hard rules (book-seller-change-control non-negotiable (g)):
//   - Only ever READ the source DB, and only via SQLite's online backup API
//     (db.backup) — a bare file copy is unsafe under WAL mode because recent
//     committed writes live in inventory.db-wal until checkpoint
//     (book-seller-run-and-operate / failure-archaeology).
//   - Never delete or write to data/inventory.db (or its -wal/-shm). Pruning
//     only ever touches files matching the daily-backup name pattern inside
//     the backups directory.
//   - Never crash or block boot: a backup failure is logged and swallowed.

const RETENTION = 7;

// Matches exactly the names this routine creates, e.g. inventory-20260703.db.
// The strictness is a safety guard: prune() will never delete anything that
// isn't one of our own daily backups (so .gitkeep and stray files survive).
const BACKUP_NAME_RE = /^inventory-\d{8}\.db$/;

function dateStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Snapshot the live DB to data/backups/inventory-YYYYMMDD.db and prune to the
 * newest RETENTION copies. Fire-and-forget: resolves (never rejects) so an
 * unhandled rejection can't take down the boot path.
 *
 * @param db     the open better-sqlite3 connection (source; read-only here)
 * @param dbPath resolved absolute path of the source DB — backups land in a
 *               `backups/` dir beside it, so a test DB pointed at by
 *               BOOKSELLER_DB_PATH backs up into its own scratch tree, never
 *               the operator's real data/backups/.
 */
export async function runStartupBackup(
  db: BetterSqlite3.Database,
  dbPath: string,
): Promise<void> {
  try {
    // Skip during `next build`: build workers load lib/db.ts too, and a build
    // is not a server start. This also avoids multiple build workers racing on
    // the same destination file.
    if (process.env.NEXT_PHASE === 'phase-production-build') {
      return;
    }

    const backupsDir = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });

    const destPath = path.join(backupsDir, `inventory-${dateStamp(new Date())}.db`);

    // First snapshot of the day wins. If we've already backed up today, don't
    // overwrite it with possibly-worse current state (e.g. a restart loop after
    // corruption). Daily granularity matches the YYYYMMDD spec.
    if (fs.existsSync(destPath)) {
      prune(backupsDir);
      return;
    }

    // Online backup API: consistent snapshot even under WAL, reads only.
    await db.backup(destPath);
    console.log(`Backup written: ${destPath}`);

    prune(backupsDir);
  } catch (err) {
    // A backup failure must never crash or block server startup.
    console.error('Startup backup failed (continuing without backup):', err);
  }
}

/** Delete all but the newest RETENTION daily backups in `backupsDir`. */
function prune(backupsDir: string): void {
  const backups = fs
    .readdirSync(backupsDir)
    .filter((name) => BACKUP_NAME_RE.test(name))
    .sort(); // YYYYMMDD sorts chronologically as plain strings

  const excess = backups.slice(0, Math.max(0, backups.length - RETENTION));
  for (const name of excess) {
    fs.rmSync(path.join(backupsDir, name), { force: true });
  }
}
