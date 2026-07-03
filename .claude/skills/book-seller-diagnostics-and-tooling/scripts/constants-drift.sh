#!/bin/bash
# constants-drift.sh — detect drift in duplicated constants and known gaps.
# Baselines recorded 2026-07-02 (see book-seller-config-and-constants ledger).
# A count change means: a home was added/removed -> update the ledger,
# this script's baselines, and re-check all homes agree on the value.
# Usage: ./constants-drift.sh [repo-root]
# Exit: 0 no drift, 1 drift detected.
set -u
ROOT="${1:-/Users/prestonbernstein/dev/book-seller}"
cd "$ROOT" || exit 1
drift=0

expect() { # label, actual, baseline
  if [ "$2" = "$3" ]; then echo "OK    $1 = $2"
  else echo "DRIFT $1 = $2 (baseline $3)"; drift=1; fi
}

# Condition vocabulary homes (files containing the literal 'Like New')
n=$(grep -rln "Like New" app lib components data/migrations 2>/dev/null | wc -l | tr -d ' ')
expect "condition-vocabulary file homes ('Like New')" "$n" "9"

# ISBN_PATTERN definitions
n=$(grep -rln "ISBN_PATTERN" app lib 2>/dev/null | wc -l | tr -d ' ')
expect "ISBN_PATTERN homes" "$n" "2"

# Date-shape regex homes (named DATE_RE or inline literal)
n=$(grep -rln 'd{4}-\\d{2}-\\d{2}' app lib 2>/dev/null | wc -l | tr -d ' ')
expect "date-regex file homes" "$n" "3"

# Money cap homes (4 code homes + lib/__tests__/money.test.ts = 5 files)
n=$(grep -rln "100_000_000" app lib 2>/dev/null | wc -l | tr -d ' ')
expect "money-cap file homes (incl. lib/__tests__ assertions)" "$n" "5"

# Pragmas present in lib/db.ts
n=$(grep -c "journal_mode = WAL\|foreign_keys = ON" lib/db.ts 2>/dev/null)
expect "lib/db.ts pragmas (WAL + foreign_keys)" "$n" "2"

# Known gap: middleware.ts absent (CSRF Origin check unimplemented, DR-1)
if [ -e middleware.ts ] || [ -e app/middleware.ts ] || [ -e src/middleware.ts ]; then
  echo "DRIFT middleware.ts now EXISTS — DR-1 may be fixed; update failure-archaeology + skills"; drift=1
else
  echo "OK    middleware.ts still absent (known gap DR-1)"
fi

# Known gap: no env vars read anywhere (config model = hardcoded constants)
n=$(grep -rln "process.env" app lib 2>/dev/null | wc -l | tr -d ' ')
expect "files reading process.env in app/+lib/ (config model unchanged)" "$n" "0"

echo "----"
if [ "$drift" -eq 0 ]; then echo "CONSTANTS-DRIFT: no drift vs 2026-07-02 baselines"; exit 0
else echo "CONSTANTS-DRIFT: drift detected — update ledger + baselines"; exit 1; fi
