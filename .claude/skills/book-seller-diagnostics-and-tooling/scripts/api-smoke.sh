#!/bin/bash
# api-smoke.sh — GET-only smoke suite for the book-seller API.
# NEVER issues POST/PATCH/DELETE. Safe against live data.
# Usage: ./api-smoke.sh [port]     (auto-detects via find-port.sh if omitted)
# Exit: 0 all PASS, 1 any FAIL.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-}"
if [ -z "$PORT" ]; then
  PORT=$("$DIR/find-port.sh") || exit 1
fi
BASE="http://127.0.0.1:${PORT}"
fails=0

check() { # name, condition-result (0/1)
  if [ "$2" -eq 0 ]; then echo "PASS  $1"; else echo "FAIL  $1"; fails=$((fails+1)); fi
}

# 1. dashboard shape
body=$(curl -s --max-time 5 "$BASE/api/dashboard")
echo "$body" | grep -q '"held_count"' && echo "$body" | grep -q '"held_acquisition_cost"' \
  && echo "$body" | grep -q '"by_condition"' && echo "$body" | grep -q '"by_status"'
check "GET /api/dashboard returns held_count/held_acquisition_cost/by_condition/by_status" $?

# 2. books list envelope
body=$(curl -s --max-time 5 "$BASE/api/books")
echo "$body" | grep -q '"items"' && echo "$body" | grep -q '"total"' \
  && echo "$body" | grep -q '"page"' && echo "$body" | grep -q '"limit"'
check "GET /api/books returns items/total/page/limit envelope" $?

# 3. limit bounds guard (expects HTTP 400)
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$BASE/api/books?limit=999")
[ "$code" = "400" ]
check "GET /api/books?limit=999 -> HTTP 400 (got $code)" $?

# 4. invalid ISBN guard (expects HTTP 400 + message)
resp=$(curl -s -w "\n%{http_code}" --max-time 5 "$BASE/api/isbn/notanisbn")
code=$(echo "$resp" | tail -1)
body=$(echo "$resp" | head -1)
[ "$code" = "400" ] && echo "$body" | grep -q "Invalid ISBN format."
check "GET /api/isbn/notanisbn -> HTTP 400 Invalid ISBN format (got $code)" $?

# 5. export headers (GET, read-only)
hdrs=$(curl -s -D - -o /dev/null --max-time 10 "$BASE/api/export")
echo "$hdrs" | grep -qi "content-type: text/csv" && echo "$hdrs" | grep -qi "content-disposition: attachment"
check "GET /api/export -> text/csv + attachment disposition" $?

echo "----"
if [ "$fails" -eq 0 ]; then echo "SMOKE: all checks passed on port $PORT"; exit 0
else echo "SMOKE: $fails check(s) FAILED on port $PORT"; exit 1; fi
