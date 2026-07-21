#!/usr/bin/env bash
# Safe hook: warn (never block destructively) when staged/changed files
# contain credential-shaped strings. Read-only; no network; no deploys.
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
pattern='AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-'
if git diff --cached --name-only 2>/dev/null | grep -q .; then
  files=$(git diff --cached --name-only)
else
  files=$(git diff --name-only 2>/dev/null || true)
fi
found=0
for f in $files; do
  [ -f "$f" ] || continue
  if grep -E -q "$pattern" "$f" 2>/dev/null; then
    echo "check-secrets: possible credential in $f" >&2
    found=1
  fi
done
if [ "$found" -eq 1 ]; then
  echo "→ remove the credential and rotate it; see SECURITY.md" >&2
  exit 2
fi
exit 0
