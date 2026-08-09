#!/usr/bin/env bash
#
# The quality gate. Runs from `pnpm check` and from .githooks/pre-push.
#
# Everything here is scoped to what changed against a base ref, not the whole
# tree. The repo predates both Biome and fallow, so a full-tree run reports
# ~130 lint findings and ~340 fallow findings that nobody is about to fix. A
# gate that always fails is a gate people learn to bypass. Scoping to the diff
# means existing debt stays put and only new debt is blocked.
#
# Usage: scripts/check.sh [base-ref]
set -uo pipefail

cd "$(dirname "$0")/.."

# Base ref precedence: explicit arg (the pre-push hook passes the remote's
# current SHA) > this branch's upstream > origin/main > main.
resolve_base() {
  if [ $# -gt 0 ] && [ -n "$1" ]; then
    echo "$1"; return
  fi
  local upstream
  upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)
  if [ -n "$upstream" ]; then echo "$upstream"; return; fi
  if git rev-parse --verify --quiet origin/main >/dev/null; then echo "origin/main"; return; fi
  echo "main"
}

BASE=$(resolve_base "$@")

if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "check: base ref '$BASE' not found — skipping (nothing to compare against)"
  exit 0
fi

echo "check: comparing against $BASE"
failed=0

step() {
  local name=$1; shift
  echo
  echo "── $name ───────────────────────────────"
  if "$@"; then
    echo "✓ $name"
  else
    echo "✗ $name"
    failed=1
  fi
}

# Format + lint, changed files only. `biome check` covers both; run
# `pnpm lint:fix` to auto-apply what it can.
# --no-errors-on-unmatched: an empty changeset (docs-only push, or a re-push
# with nothing new) matches no files, which biome otherwise treats as an error.
step "biome" pnpm exec biome check --changed --since="$BASE" --no-errors-on-unmatched

# Typecheck is whole-project by nature — tsc has no meaningful diff mode, and
# a change in one file can break a consumer three modules away.
step "typecheck" pnpm exec tsc --noEmit

# --gate new-only (fallow's default) attributes findings against a snapshot of
# the base ref, so pre-existing dead code and complexity don't fail the gate.
step "fallow" pnpm exec fallow audit --base "$BASE" --gate new-only

echo
if [ "$failed" -ne 0 ]; then
  cat <<'EOF'
✗ check failed

  formatting/lint  pnpm lint:fix
  types            pnpm typecheck
  dead code        pnpm fallow:audit   (or `fallow fix --dry-run` to preview)

  To push anyway: git push --no-verify
EOF
  exit 1
fi

echo "✓ check passed"
