import path from 'node:path';

// This spec runs in a separate Node process from the webServer that
// playwright.config.ts boots. Its @/lib/db connection must open the same
// scratch SQLite file as the server. lib/db.ts reads BOOKSELLER_DB_PATH when
// it loads, so import this module before any module that imports lib/db.
process.env.BOOKSELLER_DB_PATH = path.resolve(__dirname, '../../.playwright-scratch/inventory.db');
