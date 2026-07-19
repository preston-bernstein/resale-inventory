import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { runStartupBackup } from './backup';

// DB path is configurable via BOOKSELLER_DB_PATH so tests can point at a
// throwaway file instead of the operator's real inventory (T1 wipe trap).
// Unset → the historical cwd default, so behavior is unchanged in production.
const dbPath =
  process.env.BOOKSELLER_DB_PATH ?? path.join(process.cwd(), 'data', 'inventory.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// Open database connection
const db = new Database(dbPath);

// Enable WAL mode and foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Next.js's build-time page-data collection spins up several separate
// worker processes, each importing this module and racing to migrate the
// same on-disk file (surfaced once this repo grew past ~14 routes / 4
// migrations — "table already exists" / "duplicate column" errors from two
// workers both reading user_version=0 and applying the same migration).
// busy_timeout makes a worker that loses the write lock WAIT instead of
// throwing SQLITE_BUSY immediately.
db.pragma('busy_timeout = 5000');

const migrationsDir = path.join(process.cwd(), 'data', 'migrations');

// Versioned migrations, including the baseline. There is no version table, so
// we key off PRAGMA user_version (0 on legacy/fresh DBs). Each numbered
// migration runs at most once, in a transaction, and bumps user_version to
// its number — so a boot against an already-migrated DB is a no-op
// (idempotent). This is the minimal runner sanctioned by
// resale-inventory-change-control §4.3.
//
// 001_init.sql MUST stay gated behind user_version < 1 like every other
// migration — do not hoist it back out to run unconditionally on every boot.
// It uses `CREATE TABLE IF NOT EXISTS books/book_platforms/...`, which was
// harmless while those tables were permanent, but 003_multi_category.sql
// renames books → books_archived and book_platforms → book_platforms_archived.
// If 001 ran unconditionally after that, its IF NOT EXISTS guard would
// silently resurrect empty books/book_platforms tables on the very next boot
// — a silent data-shape regression. Gating it here (version 1) means a fresh
// DB runs it once and an already-migrated DB never touches it again.
const VERSIONED_MIGRATIONS = [
  { version: 1, file: '001_init.sql' },
  { version: 2, file: '002_price_history_nullable.sql' },
  { version: 3, file: '003_multi_category.sql' },
  { version: 4, file: '004_phone_pairing_tokens.sql' },
  { version: 5, file: '005_tenants.sql' },
  { version: 6, file: '006_tenant_scoping.sql' },
  { version: 7, file: '007_platform_connections.sql' },
  { version: 8, file: '008_consent_capture.sql' },
  { version: 9, file: '009_item_platforms_external_id.sql' },
  { version: 10, file: '010_poshmark_pacing.sql' },
  { version: 11, file: '011_clothing_brand_and_size_system.sql' },
  { version: 12, file: '012_clothing_vocabularies.sql' },
  { version: 13, file: '013_credential_column_floor.sql' },
];
// Each migration re-checks user_version FRESH, from inside its own
// immediate-lock transaction, rather than once for the whole loop — .immediate()
// grabs SQLite's write lock upfront (instead of lazily on first write), so two
// worker processes racing this loop serialize on each migration in turn: the
// loser re-reads user_version once it finally gets the lock and, seeing the
// winner already bumped it, skips the migration it would otherwise redo.
for (const { version, file } of VERSIONED_MIGRATIONS) {
  db.transaction(() => {
    const schemaVersion = db.pragma('user_version', { simple: true }) as number;
    if (schemaVersion < version) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
      console.log(`Applied migration ${file} (user_version → ${version})`);
    }
  }).immediate();
}

console.log(`Database initialized at: ${dbPath}`);

// Startup backup routine (plan.md Risk 6 / DR-2). Fire-and-forget: it only
// reads the DB (via SQLite's WAL-safe online backup API), never blocks boot,
// and swallows its own errors — see lib/backup.ts.
void runStartupBackup(db, dbPath);

export default db;
