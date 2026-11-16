#!/usr/bin/env bash
# Validation gate for agent-written Postgres SQL and migrations. Pack: postgres, rule pg-one-gate-command.
#
#   pg-validate.sh [ROOT]
#
# Order: applied migrations unchanged (git) -> static checks (primary keys, superuser roles, end-of-life images)
#        -> squawk (safety) -> sqlfluff (style).
# Applied migrations are files in a migrations/ or migration/ folder that exist on the base ref: they may not be
# modified, renamed or deleted. Add a new migration instead.
# Every tool is checked before any step runs. A missing tool fails the gate with exit 127. Nothing is skipped.
# Env:
#   PG_BASE_REF       ref the migrations are compared with (default origin/main)
#   PG_ALLOW_NO_BASE  1 = allow a missing base ref (a brand-new repo); the immutability check is then not run
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"
BASE="${PG_BASE_REF:-origin/main}"

fail() { echo "pg-validate: $*" >&2; exit "${2:-1}"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing tool: $1 (the gate never skips a step)" 127; }

in_git=0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 && in_git=1

files=()
while IFS= read -r f; do files+=("$f"); done < <(
  find . -mindepth 1 \( -name node_modules -o -name vendor -o -name '.*' \) -prune -o -type f -name '*.sql' -print | sort)

# .pg-allow: `<glob> <reason>` per line leaves legacy applied migrations (which may not be edited) or non-Postgres SQL out of the
# linters. The immutability check below still covers them.
if [ -f .pg-allow ]; then
  pg_skip=()
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    case "$line" in "" | "#"*) continue ;; esac
    read -r glob reason <<<"$line"
    [ -n "${reason:-}" ] || fail ".pg-allow:$n: needs '<glob> <reason>', the reason is required" 2
    pg_skip+=("$glob")
  done <.pg-allow
  kept=()
  for f in "${files[@]+"${files[@]}"}"; do
    rel="${f#./}"
    skip=0
    for g in "${pg_skip[@]+"${pg_skip[@]}"}"; do
      # shellcheck disable=SC2254 # the glob comes from .pg-allow on purpose
      case "$rel" in $g) skip=1 ;; esac
    done
    [ "$skip" = 1 ] || kept+=("$f")
  done
  files=("${kept[@]+"${kept[@]}"}")
fi

# SQLite SQL (AUTOINCREMENT, PRAGMA, INSERT OR ..., backtick names, RAISE()) is not Postgres: squawk and sqlfluff would only report
# dialect noise, so those files are left out.
sqlite_re='AUTOINCREMENT|^[[:space:]]*PRAGMA[[:space:]]|INSERT[[:space:]]+OR[[:space:]]+(IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)|WITHOUT[[:space:]]+ROWID|RAISE[[:space:]]*\(|`'
pg_files=()
skipped=0
for f in "${files[@]+"${files[@]}"}"; do
  if grep -Eiq "$sqlite_re" "$f"; then skipped=$((skipped + 1)); else pg_files+=("$f"); fi
done
files=("${pg_files[@]+"${pg_files[@]}"}")
[ "$skipped" -eq 0 ] || echo "pg-validate: skipped $skipped SQLite file(s); they are not Postgres SQL"

if [ "${#files[@]}" -eq 0 ] && [ "$in_git" = 0 ]; then
  echo "pg-validate: no .sql files, nothing to check"
  exit 0
fi
if [ "${#files[@]}" -gt 0 ]; then
  need squawk
  need sqlfluff
fi

# 1. applied migrations are immutable (checked even when every migration was deleted)
if [ "$in_git" = 1 ]; then
  if git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null 2>&1; then
    changed="$(git diff --name-status --diff-filter=MDR "$BASE" -- ':(glob)**/migrations/**' ':(glob)**/migration/**' || true)"
    if [ -n "$changed" ]; then
      echo "$changed" >&2
      fail "applied migrations are immutable: these files exist on $BASE and were modified, renamed or deleted; add a new migration instead"
    fi
  elif [ "${#files[@]}" -gt 0 ] && [ "${PG_ALLOW_NO_BASE:-0}" != 1 ]; then
    fail "base ref '$BASE' not found, so migration immutability cannot be checked (set PG_BASE_REF, or PG_ALLOW_NO_BASE=1 for a new repo)" 2
  fi
fi

if [ "${#files[@]}" -eq 0 ]; then
  echo "pg-validate: no .sql files, nothing more to check"
  exit 0
fi

# 2. static checks that need no database
for f in "${files[@]}"; do
  # every CREATE TABLE has a primary key (temporary tables, CTAS, partitions and LIKE copies are exempt)
  missing="$(sed 's/--.*$//' "$f" | awk -v RS=';' '
    { s = tolower($0) }
    s ~ /create[ \t\n]+(unlogged[ \t\n]+)?table/ && s !~ /create[ \t\n]+(global[ \t\n]+|local[ \t\n]+)?(temp|temporary)/ \
      && s !~ /[ \t\n]as[ \t\n]+(select|with|table|values)/ && s !~ /partition[ \t\n]+of/ && s !~ /\(\s*like[ \t\n]/ \
      && s !~ /primary[ \t\n]+key/ { gsub(/^[ \t\n]+/, "", $0); split($0, l, "\n"); print "  " l[1] }')"
  if [ -n "$missing" ]; then
    echo "$missing" >&2
    fail "$f: a table has no primary key (every table needs one)"
  fi
  # roles must not be superuser or bypass row-level security
  if sed 's/--.*$//' "$f" | grep -Eiq '(^|[^a-z_])(superuser|bypassrls)([^a-z_]|$)'; then
    fail "$f: grants SUPERUSER or BYPASSRLS; use NOSUPERUSER and NOBYPASSRLS for application roles"
  fi
done

# end-of-life PostgreSQL majors in images (14 and older)
eol="$(grep -RIEn --include='*.yml' --include='*.yaml' --include='Dockerfile*' --exclude-dir=node_modules --exclude-dir=vendor --exclude-dir='.?*' \
  '(image:|FROM)[[:space:]]+(docker\.io/library/)?postgres:(9|10|11|12|13|14)([^0-9]|$)' . 2>/dev/null || true)"
if [ -n "$eol" ]; then
  echo "$eol" >&2
  fail "an image pins an end-of-life PostgreSQL major (14 or older); use a supported major"
fi

# 3. linters
squawk "${files[@]}"
sqlfluff lint --dialect postgres "${files[@]}"
echo "pg-validate: all checks passed"
