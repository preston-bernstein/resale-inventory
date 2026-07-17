#!/bin/bash
# db-integrity.sh — read-only invariant sweep of data/inventory.db.
# Opens the DB with mode=ro; CANNOT write. Safe while the server runs.
# Usage: ./db-integrity.sh [repo-root]   (default /Users/prestonbernstein/dev/resale-inventory)
# Exit: 0 all clean, 1 any violation (integrity/orphans/invariants/dups).
set -u
ROOT="${1:-/Users/prestonbernstein/dev/resale-inventory}"
DB="file:${ROOT}/data/inventory.db?mode=ro"
Q() { sqlite3 "$DB" "$1"; }
bad=0

echo "== PRAGMA integrity_check (expect: ok)"
r=$(Q "PRAGMA integrity_check;")
echo "$r"
[ "$r" = "ok" ] || bad=1

echo "== Orphan item_platforms rows (expect: 0)"
r=$(Q "SELECT COUNT(*) FROM item_platforms ip LEFT JOIN items i ON i.id=ip.item_id WHERE i.id IS NULL;")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== Orphan item_photos rows (expect: 0)"
r=$(Q "SELECT COUNT(*) FROM item_photos ph LEFT JOIN items i ON i.id=ph.item_id WHERE i.id IS NULL;")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== Orphan price_history rows (expect: 0)"
r=$(Q "SELECT COUNT(*) FROM price_history ph LEFT JOIN items i ON i.id=ph.item_id WHERE i.id IS NULL;")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== Items missing their category's satellite detail row (expect: 0 — every item must have exactly one of book_details/clothing_details)"
r=$(Q "SELECT COUNT(*) FROM items i WHERE (i.category='book' AND NOT EXISTS (SELECT 1 FROM book_details bd WHERE bd.item_id=i.id)) OR (i.category='clothing' AND NOT EXISTS (SELECT 1 FROM clothing_details cd WHERE cd.item_id=i.id));")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== Listed/Sale Pending rows missing listing_price (expect: 0 — CHECK-guaranteed)"
r=$(Q "SELECT COUNT(*) FROM items WHERE status IN ('Listed','Sale Pending') AND listing_price IS NULL;")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== Sold rows missing sale fields (expect: 0 — CHECK-guaranteed)"
r=$(Q "SELECT COUNT(*) FROM items WHERE status='Sold' AND (sale_price IS NULL OR sale_date IS NULL OR sale_platform IS NULL);")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== Rows outside status enum (expect: 0 — CHECK-guaranteed)"
r=$(Q "SELECT COUNT(*) FROM items WHERE status NOT IN ('Unlisted','Listed','Sale Pending','Sold','Removed','Donated','Discarded');")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== book_details rows outside the book condition enum (expect: 0 — CHECK-guaranteed)"
r=$(Q "SELECT COUNT(*) FROM book_details WHERE condition NOT IN ('Poor','Acceptable','Good','Very Good','Like New');")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== clothing_details rows outside the clothing condition enum (expect: 0 — CHECK-guaranteed)"
r=$(Q "SELECT COUNT(*) FROM clothing_details WHERE condition NOT IN ('NWT','NWOT','EUC','GUC','Fair');")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== Duplicate non-null ISBNs (expect: 0 — unique-index-guaranteed)"
r=$(Q "SELECT COUNT(*) FROM (SELECT isbn FROM book_details WHERE isbn IS NOT NULL GROUP BY isbn HAVING COUNT(*)>1);")
echo "$r"; [ "$r" = "0" ] || bad=1

echo "== Row counts per status (informational)"
Q "SELECT status, COUNT(*) FROM items GROUP BY status ORDER BY status;"
echo "== Row counts per category (informational)"
Q "SELECT category, COUNT(*) FROM items GROUP BY category ORDER BY category;"
echo "== Totals: items / item_platforms / item_photos / price_history (informational)"
Q "SELECT (SELECT COUNT(*) FROM items), (SELECT COUNT(*) FROM item_platforms), (SELECT COUNT(*) FROM item_photos), (SELECT COUNT(*) FROM price_history);"

echo "----"
if [ "$bad" -eq 0 ]; then echo "DB-INTEGRITY: clean"; exit 0
else echo "DB-INTEGRITY: VIOLATIONS FOUND (see above)"; exit 1; fi
