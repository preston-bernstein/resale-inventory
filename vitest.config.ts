import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// SAFETY: lib/db.ts resolves its DB file from BOOKSELLER_DB_PATH, falling
// back to <cwd>/data/inventory.db — the operator's real, live inventory —
// when unset. tests/integration.test.ts deletes rows in its beforeEach, so
// running the suite without this env var wipes real data (this was a known,
// documented trap — resale-inventory-architecture-contract W2). Setting it here,
// in test.env, makes `vitest run` safe BY DEFAULT for every test file and
// every future contributor, rather than relying on remembering to export it
// by hand. Any test that genuinely needs the real DB must opt in explicitly
// and deliberately — none should, and none currently do.
const scratchDbPath = path.resolve(__dirname, '.vitest-scratch/inventory.db');

// SAFETY: lib/photos.ts resolves the photo-upload directory the same way —
// BOOKSELLER_PHOTOS_PATH, falling back to <cwd>/data/photos otherwise. Photo
// route tests write real files to disk; without this they'd land in the
// operator's real photos tree (discovered the hard way: an early route-test
// pass left orphaned UUID directories under data/photos/ before this was
// wired in — cleaned up, not repeated).
const scratchPhotosPath = path.resolve(__dirname, '.vitest-scratch/photos');

export default defineConfig({
  // Without this, Vite/rolldown has no TSX/TS-stripping transform wired in,
  // so the v8 coverage provider's AST remap chokes on plain `interface`/type
  // syntax in components/*.tsx files that no test currently imports (it
  // still tries to parse them directly to report them as 0%, per coverage.all
  // semantics) — every component silently fell out of the coverage report
  // instead of counting against the threshold. This also makes React
  // Testing Library-style .tsx test files viable going forward.
  plugins: [react()],
  test: {
    // Default environment is 'node' — route/lib tests need real filesystem
    // + better-sqlite3 access, which jsdom doesn't provide. Component tests
    // opt into jsdom per-file via a `// @vitest-environment jsdom` docblock
    // at the top of the file instead of flipping this globally.
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Every DB-touching test file shares one physical scratch SQLite file
    // (by design — it's what makes them safe-by-default, see above). Under
    // Vitest's default cross-file worker parallelism, one file's beforeEach
    // table truncation races concurrent inserts from another file's test,
    // intermittently throwing FOREIGN KEY constraint errors that have
    // nothing to do with the code under test. Running files sequentially
    // costs some wall-clock time but is correct; this is a single-user local
    // app's test suite, not a distributed one worth parallelizing at this
    // granularity.
    fileParallelism: false,
    // tests/e2e/** are Playwright specs (run via `npm run test:e2e`), not
    // Vitest ones — without this, Vitest's default glob picks them up too
    // and they fail immediately since they call Playwright's test.describe()
    // outside a Playwright runner.
    exclude: ['**/node_modules/**', 'tests/e2e/**'],
    env: {
      BOOKSELLER_DB_PATH: scratchDbPath,
      BOOKSELLER_PHOTOS_PATH: scratchPhotosPath,
    },
    coverage: {
      provider: 'v8',
      // 'json' adds coverage-final.json (Istanbul format) alongside the
      // human-facing reporters — CI feeds it to `fallow audit --coverage`
      // for exact per-function CRAP scores instead of fallow's own
      // export-reference estimate.
      reporter: ['text', 'html', 'lcov', 'json'],
      include: [
        'app/api/**/*.ts',
        'app/**/page.tsx',
        'lib/**/*.ts',
        'components/**/*.tsx',
      ],
      exclude: [
        'lib/__tests__/**',
        'lib/types.ts',
        '**/*.d.ts',
      ],
      thresholds: {
        // Deliberately strict, and deliberately not yet met everywhere —
        // see docs/QA.md. Never lower these to make a run pass; write the
        // missing tests or fix the code instead.
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
  },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
});
