#!/bin/bash
# db-integrity.sh — read-only invariant sweep of data/inventory.db.
# Opens the DB with mode=ro; CANNOT write. Safe while the server runs.
# Usage: ./db-integrity.sh [repo-root]   (default /Users/prestonbernstein/dev/book-seller)
# Exit: 0 all clean, 1 any violation (integrity/orphans/invariants/dups).
set -u
ROOT="${1:-/Users/prestonbernstein/dev/book-seller}"
DB="file:${ROOT}/data/inventory.db?mode=ro"
Q() { sqlite3 "$DB" "$1"; }
bad=0

echo "== PRAGMA integrity_check (expect: ok)"
r=$(Q "PRAGMA integrity_check;")
echo "$r"
[ "$r" = "ok" ] || bad=1

echo "== Orphan book_platforms rows (expect: 0)"
r=$(Q "SELECT COUNT(*) FROM book_platforms bp LEFT JOIN books b ON b.id=bp.book_id WHERE b.id IS NULL;")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== Orphan price_history rows (expect: 0)"
r=$(Q "SELECT COUNT(*) FROM price_history ph LEFT JOIN books b ON b.id=ph.book_id WHERE b.id IS NULL;")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== Listed/Sale Pending rows missing listing_price (expect: 0 — CHECK-guaranteed)"
r=$(Q "SELECT COUNT(*) FROM books WHERE status IN ('Listed','Sale Pending') AND listing_price IS NULL;")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== Sold rows missing sale fields (expect: 0 — CHECK-guaranteed)"
r=$(Q "SELECT COUNT(*) FROM books WHERE status='Sold' AND (sale_price IS NULL OR sale_date IS NULL OR sale_platform IS NULL);")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== Rows outside status/condition enums (expect: 0 — CHECK-guaranteed)"
r=$(Q "SELECT COUNT(*) FROM books WHERE status NOT IN ('Unlisted','Listed','Sale Pending','Sold','Removed','Donated','Discarded') OR condition NOT IN ('Poor','Acceptable','Good','Very Good','Like New');")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== Duplicate non-null ISBNs (expect: 0 — unique-index-guaranteed)"
r=$(Q "SELECT COUNT(*) FROM (SELECT isbn FROM books WHERE isbn IS NOT NULL GROUP BY isbn HAVING COUNT(*)>1);")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== Row counts per status (informational)"
Q "SELECT status, COUNT(*) FROM books GROUP BY status ORDER BY status;"
echo "== Totals: books / platforms / price_history (informational)"
Q "SELECT (SELECT COUNT(*) FROM books), (SELECT COUNT(*) FROM book_platforms), (SELECT COUNT(*) FROM price_history);"

echo "----"
if [ "$bad" -eq 0 ]; then echo "DB-INTEGRITY: clean"; exit 0
else echo "DB-INTEGRITY: VIOLATIONS FOUND (see above)"; exit 1; fi
