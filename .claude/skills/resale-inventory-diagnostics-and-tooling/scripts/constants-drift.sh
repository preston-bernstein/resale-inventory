#!/bin/bash
# constants-drift.sh — detect drift in duplicated constants and known gaps.
# Baselines re-recorded 2026-07-12 against the post-multi-category-migration,
# post-QA-hardening codebase (see resale-inventory-config-and-constants
# ledger). A count change means: a home was added/removed -> update the
# ledger, this script's baselines, and re-check all homes agree on the value.
# Usage: ./constants-drift.sh [repo-root]
# Exit: 0 no drift, 1 drift detected.
set -u
ROOT="${1:-/Users/prestonbernstein/dev/resale-inventory}"
cd "$ROOT" || exit 1
drift=0

expect() { # label, actual, baseline
  if [ "$2" = "$3" ]; then echo "OK    $1 = $2"
  else echo "DRIFT $1 = $2 (baseline $3)"; drift=1; fi
}

# Condition vocabulary homes (files containing the literal 'Like New').
# Consolidated into lib/constants.ts's BOOK_CONDITIONS during the
# multi-category migration, so this dropped from the original 9.
n=$(grep -rln "Like New" app lib components data/migrations 2>/dev/null | wc -l | tr -d ' ')
expect "condition-vocabulary file homes ('Like New')" "$n" "5"

# ISBN_PATTERN definitions
n=$(grep -rln "ISBN_PATTERN" app lib 2>/dev/null | wc -l | tr -d ' ')
expect "ISBN_PATTERN homes" "$n" "2"

# Date-shape regex homes (named DATE_RE or inline literal). Consolidated to
# a single lib/constants.ts DATE_RE export, so this dropped from 3 to 1.
n=$(grep -rln 'd{4}-\\d{2}-\\d{2}' app lib 2>/dev/null | wc -l | tr -d ' ')
expect "date-regex file homes" "$n" "1"

# Money cap homes (code homes + lib/__tests__/money.test.ts assertions)
n=$(grep -rln "100_000_000" app lib 2>/dev/null | wc -l | tr -d ' ')
expect "money-cap file homes (incl. lib/__tests__ assertions)" "$n" "5"

# Pragmas present in lib/db.ts
n=$(grep -c "journal_mode = WAL\|foreign_keys = ON" lib/db.ts 2>/dev/null)
expect "lib/db.ts pragmas (WAL + foreign_keys)" "$n" "2"

# middleware.ts (CSRF Origin check, DR-1) — fixed since the original baseline;
# now checking it stays present rather than checking it stays absent.
if [ -e middleware.ts ] || [ -e app/middleware.ts ] || [ -e src/middleware.ts ]; then
  echo "OK    middleware.ts present (DR-1 fix, CSRF Origin check)"
else
  echo "DRIFT middleware.ts is MISSING — DR-1 regression, CSRF Origin check gone"; drift=1
fi

# process.env usage in app/+lib/: no longer a "known gap" at 0 — the
# BOOKSELLER_DB_PATH/BOOKSELLER_PHOTOS_PATH test-safety overrides
# (lib/db.ts, lib/photos.ts) and a couple of other reads now use it
# deliberately. A count of 0 here would itself be drift (those overrides
# would be gone, meaning tests could target the real DB by default again).
n=$(grep -rln "process.env" app lib 2>/dev/null | wc -l | tr -d ' ')
expect "files reading process.env in app/+lib/ (BOOKSELLER_DB_PATH/BOOKSELLER_PHOTOS_PATH overrides + others)" "$n" "5"

echo "----"
if [ "$drift" -eq 0 ]; then echo "CONSTANTS-DRIFT: no drift vs 2026-07-12 baselines"; exit 0
else echo "CONSTANTS-DRIFT: drift detected — update ledger + baselines"; exit 1; fi
