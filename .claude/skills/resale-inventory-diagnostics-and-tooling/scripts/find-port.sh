#!/bin/bash
# find-port.sh — locate the port actually serving the resale-inventory app.
# Discriminates against impostors (e.g., the Flutter app that often squats
# on :3000 and answers HTTP 200 with HTML) by requiring the /api/dashboard
# JSON signature ("held_count").
# Usage: ./find-port.sh            -> prints the port, exit 0
#        exit 1 if not found on 3000-3010.
set -u
for port in $(seq 3000 3010); do
  body=$(curl -s --max-time 2 "http://127.0.0.1:${port}/api/dashboard" 2>/dev/null | head -c 200)
  case "$body" in
    *held_count*)
      echo "$port"
      exit 0
      ;;
  esac
done
echo "resale-inventory not found on ports 3000-3010 (is the server running? npm run dev)" >&2
exit 1
