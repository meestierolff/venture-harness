#!/usr/bin/env bash
# Safe hook: after public-surface edits, run the claims validator so
# untraceable claims surface immediately. Read-only; fast; local only.
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
pnpm --silent validate:claims || {
  echo "→ public copy drifted from docs/product/PRODUCT_TRUTH.md — fix before continuing" >&2
  exit 2
}
exit 0
