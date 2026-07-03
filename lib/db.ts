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

// Execute baseline migration. 001 is all `CREATE ... IF NOT EXISTS`, so it is
// idempotent and safe to run on every boot.
const migrationsDir = path.join(process.cwd(), 'data', 'migrations');
db.exec(fs.readFileSync(path.join(migrationsDir, '001_init.sql'), 'utf-8'));

// Versioned migrations beyond the baseline. There is no version table, so we
// key off PRAGMA user_version (0 on legacy/fresh DBs). Each numbered migration
// runs at most once, in a transaction, and bumps user_version to its number —
// so a boot against an already-migrated DB is a no-op (idempotent). This is the
// minimal runner sanctioned by book-seller-change-control §4.3.
const VERSIONED_MIGRATIONS = [
  { version: 2, file: '002_price_history_nullable.sql' },
];
const schemaVersion = db.pragma('user_version', { simple: true }) as number;
for (const { version, file } of VERSIONED_MIGRATIONS) {
  if (schemaVersion < version) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
    console.log(`Applied migration ${file} (user_version → ${version})`);
  }
}

console.log(`Database initialized at: ${dbPath}`);

// Startup backup routine (plan.md Risk 6 / DR-2). Fire-and-forget: it only
// reads the DB (via SQLite's WAL-safe online backup API), never blocks boot,
// and swallows its own errors — see lib/backup.ts.
void runStartupBackup(db, dbPath);

export default db;
