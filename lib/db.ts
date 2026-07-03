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

// Execute migration
const migrationSql = fs.readFileSync(
  path.join(process.cwd(), 'data', 'migrations', '001_init.sql'),
  'utf-8'
);
db.exec(migrationSql);

console.log(`Database initialized at: ${dbPath}`);

// Startup backup routine (plan.md Risk 6 / DR-2). Fire-and-forget: it only
// reads the DB (via SQLite's WAL-safe online backup API), never blocks boot,
// and swallows its own errors — see lib/backup.ts.
void runStartupBackup(db, dbPath);

export default db;
