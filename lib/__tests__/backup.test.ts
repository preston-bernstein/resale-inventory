import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { runStartupBackup } from '../backup';

// DR-2 (plan.md Risk 6): startup backup routine. These tests are safe to run
// in-repo — runStartupBackup takes an explicit db + dbPath, never imports
// lib/db and never touches the operator's real data/inventory.db. Each test
// works entirely inside its own mkdtemp scratch directory.

function makeDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY, title TEXT)');
  return db;
}

function stamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

describe('runStartupBackup (DR-2)', () => {
  let dir: string;
  let dbPath: string;
  let backupsDir: string;
  let today: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-backup-'));
    dbPath = path.join(dir, 'inventory.db');
    backupsDir = path.join(dir, 'backups');
    today = stamp(new Date());
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes data/backups/inventory-YYYYMMDD.db beside the source DB', async () => {
    const db = makeDb(dbPath);
    db.prepare('INSERT INTO books (title) VALUES (?)').run('Dune');
    await runStartupBackup(db, dbPath);
    db.close();

    const dest = path.join(backupsDir, `inventory-${today}.db`);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('captures rows still in the WAL (proves .backup is WAL-safe, not a bare copy)', async () => {
    // Keep the connection open with WAL never checkpointed: the row lives only
    // in inventory.db-wal, so a naive `cp inventory.db` would miss it.
    const db = makeDb(dbPath);
    db.prepare('INSERT INTO books (title) VALUES (?)').run('WAL-only row');

    const walPath = `${dbPath}-wal`;
    expect(fs.existsSync(walPath) && fs.statSync(walPath).size > 0).toBe(true);

    await runStartupBackup(db, dbPath);
    db.close();

    const backup = new Database(path.join(backupsDir, `inventory-${today}.db`), {
      readonly: true,
    });
    const count = backup.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number };
    backup.close();
    expect(count.n).toBe(1);
  });

  it('never modifies or deletes the source DB', async () => {
    const db = makeDb(dbPath);
    db.prepare('INSERT INTO books (title) VALUES (?)').run('Original');
    await runStartupBackup(db, dbPath);

    const stillThere = db
      .prepare('SELECT title FROM books')
      .all()
      .map((r) => (r as { title: string }).title);
    db.close();

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(stillThere).toEqual(['Original']);
  });

  it('keeps only the newest 7 daily backups, deleting older ones', async () => {
    const db = makeDb(dbPath);
    fs.mkdirSync(backupsDir, { recursive: true });

    // Seed 9 older daily backups (dates in the past) plus today's, via the
    // routine for today and hand-written stubs for prior days.
    const past = ['20260101', '20260102', '20260103', '20260104', '20260105', '20260106', '20260107', '20260108'];
    for (const p of past) {
      fs.writeFileSync(path.join(backupsDir, `inventory-${p}.db`), 'stub');
    }
    await runStartupBackup(db, dbPath); // creates inventory-<today>.db (a 2026-07 date, newest)
    db.close();

    const remaining = fs
      .readdirSync(backupsDir)
      .filter((n) => /^inventory-\d{8}\.db$/.test(n))
      .sort();

    expect(remaining.length).toBe(7);
    // Newest 7 = the 6 most recent past stubs + today's. Oldest two pruned.
    expect(remaining).not.toContain('inventory-20260101.db');
    expect(remaining).not.toContain('inventory-20260102.db');
    expect(remaining).toContain(`inventory-${today}.db`);
  });

  it('leaves non-backup files (e.g. .gitkeep) untouched while pruning', async () => {
    const db = makeDb(dbPath);
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.writeFileSync(path.join(backupsDir, '.gitkeep'), '');
    for (let i = 1; i <= 8; i++) {
      fs.writeFileSync(path.join(backupsDir, `inventory-2026010${i}.db`), 'stub');
    }
    await runStartupBackup(db, dbPath);
    db.close();

    expect(fs.existsSync(path.join(backupsDir, '.gitkeep'))).toBe(true);
  });

  it('does not overwrite an existing same-day backup (first snapshot of the day wins)', async () => {
    const db = makeDb(dbPath);
    fs.mkdirSync(backupsDir, { recursive: true });
    const dest = path.join(backupsDir, `inventory-${today}.db`);
    fs.writeFileSync(dest, 'EARLIER-SNAPSHOT');

    await runStartupBackup(db, dbPath);
    db.close();

    expect(fs.readFileSync(dest, 'utf-8')).toBe('EARLIER-SNAPSHOT');
  });

  it('skips entirely during `next build` (NEXT_PHASE guard)', async () => {
    const prev = process.env.NEXT_PHASE;
    process.env.NEXT_PHASE = 'phase-production-build';
    try {
      const db = makeDb(dbPath);
      await runStartupBackup(db, dbPath);
      db.close();
      expect(fs.existsSync(backupsDir)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NEXT_PHASE;
      else process.env.NEXT_PHASE = prev;
    }
  });
});
