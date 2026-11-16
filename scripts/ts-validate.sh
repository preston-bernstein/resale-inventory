#!/usr/bin/env bash
# Validation gate for agent-written TypeScript. Pack: typescript, rule ts-one-gate-command.
#
#   ts-validate.sh [ROOT]
#
# Order: tsc --noEmit -> eslint . -> vitest run -> playwright test (only when TS_E2E=1).
# Tools are the project's own, from node_modules/.bin (install with the lockfile first).
# Every tool is checked before any step runs. A missing tool fails the gate with exit 127. Nothing is skipped.
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

fail() { echo "ts-validate: $*" >&2; exit "${2:-1}"; }
BIN="$PWD/node_modules/.bin"
need() { [ -x "$BIN/$1" ] || fail "missing tool: $1 in node_modules/.bin (install dependencies first; the gate never skips a step)" 127; }

if [ ! -f tsconfig.json ]; then
  echo "ts-validate: no tsconfig.json, nothing to check"
  exit 0
fi

need tsc
need eslint
need vitest
[ "${TS_E2E:-0}" != 1 ] || need playwright

"$BIN/tsc" --noEmit
"$BIN/eslint" .
"$BIN/vitest" run
if [ "${TS_E2E:-0}" = 1 ]; then "$BIN/playwright" test; fi
echo "ts-validate: all checks passed"
