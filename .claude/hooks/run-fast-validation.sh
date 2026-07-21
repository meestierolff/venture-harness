#!/usr/bin/env bash
# Safe hook: the fast validation slice for end-of-task checks. Runs the
# cheap deterministic validators only (no build, no server, no network).
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
pnpm --silent validate:skills
pnpm --silent validate:docs
pnpm --silent validate:links
pnpm --silent validate:claims
echo "fast validation passed (full gate: pnpm verify)"
