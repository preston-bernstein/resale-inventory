#!/usr/bin/env bash
# Installs the tools the gate scripts need, at pinned versions with hashes. CI and developers run it the same way:
#   bash .github/gate-tools/install.sh        then add the bin directory it prints to PATH.
# The tools install outside the repo (GATE_TOOLS_DIR, default ~/.cache/gate-tools) because a virtualenv inside the
# project root breaks `next build`, which scans the whole tree.
# Python tools: hash-locked in requirements.txt. Node tools: integrity hashes in package-lock.json.
# Go binaries (actionlint, vale): SHA-256 checked below. To bump one, change the version and the hash together.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${GATE_TOOLS_DIR:-$HOME/.cache/gate-tools}"
BIN="$DEST/bin"
ACTIONLINT_VERSION=1.7.12
ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
VALE_VERSION=3.27.0
VALE_SHA256=c80d62f6bce87b81843ac5b512a26e63213927b957adba0a64fc594570da2000

fetch_binary() { # name url sha256 archive-member
  local name="$1" url="$2" sha="$3" member="$4" tmp
  tmp="$(mktemp -d)"
  curl -fsSL --retry 3 "$url" -o "$tmp/archive.tgz"
  echo "$sha  $tmp/archive.tgz" | sha256sum -c - >/dev/null || { echo "install: checksum mismatch for $name" >&2; exit 1; }
  tar xzf "$tmp/archive.tgz" -C "$tmp" "$member"
  install -m 0755 "$tmp/$member" "$BIN/$name"
  rm -rf "$tmp"
}

mkdir -p "$BIN"
cp "$HERE/package.json" "$HERE/package-lock.json" "$DEST/"

python3 -m venv "$DEST/venv"
"$DEST/venv/bin/pip" install --quiet --require-hashes --no-deps -r "$HERE/requirements.txt"
for tool in lizard zizmor sqlfluff; do ln -sf "../venv/bin/$tool" "$BIN/$tool"; done

(cd "$DEST" && npm ci --ignore-scripts --no-audit --no-fund --silent)
for tool in jscpd squawk; do ln -sf "../node_modules/.bin/$tool" "$BIN/$tool"; done

fetch_binary actionlint \
  "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" \
  "$ACTIONLINT_SHA256" actionlint
fetch_binary vale \
  "https://github.com/vale-cli/vale/releases/download/v${VALE_VERSION}/vale_${VALE_VERSION}_Linux_64-bit.tar.gz" \
  "$VALE_SHA256" vale

echo "install: done. Run: export PATH=\"$BIN:\$PATH\""
