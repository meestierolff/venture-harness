#!/usr/bin/env bash
# Safe hook: after edits under lib/analytics, components, or app, run the
# PII checks. Read-only; no network beyond localhost; no paid services.
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
pnpm --silent verify:analytics-pii || {
  echo "→ a prohibited property is reaching analytics — see output above" >&2
  exit 2
}
exit 0
