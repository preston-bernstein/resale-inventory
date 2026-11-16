#!/usr/bin/env bash
# Validation gate for agent-written JavaScript on Node. Pack: javascript-node, rule js-one-gate-command.
#
#   js-validate.sh [ROOT]
#
# Order: package-check.mjs (package.json, lockfile, release age) -> eslint . -> npm test.
# Copy package-check.mjs to scripts/ in the project. Tools are the project's own (node_modules/.bin).
# Every tool is checked before any step runs. A missing tool fails the gate with exit 127. Nothing is skipped.
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

fail() { echo "js-validate: $*" >&2; exit "${2:-1}"; }
BIN="$PWD/node_modules/.bin"
need_bin() { [ -x "$BIN/$1" ] || fail "missing tool: $1 in node_modules/.bin (install dependencies first; the gate never skips a step)" 127; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "missing tool: $1 (the gate never skips a step)" 127; }

if [ ! -f package.json ]; then
  echo "js-validate: no package.json, nothing to check"
  exit 0
fi

need_cmd node
need_cmd npm
need_bin eslint
[ -f scripts/package-check.mjs ] || fail "scripts/package-check.mjs is missing (copy it from the pack templates)" 2

node scripts/package-check.mjs .
"$BIN/eslint" .
npm test
echo "js-validate: all checks passed"
