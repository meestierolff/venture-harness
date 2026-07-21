#!/usr/bin/env bash
# Safe hook: verify consent gating after edits to consent/analytics code.
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
pnpm --silent verify:consent || {
  echo "→ consent gating regressed — see output above" >&2
  exit 2
}
exit 0
