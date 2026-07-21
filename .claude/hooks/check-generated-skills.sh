#!/usr/bin/env bash
# Safe hook: block edits to generated skill directories. The canonical
# source is skills/; generated copies are overwritten by pnpm agents:sync.
# Reads the tool payload from stdin (Claude Code PreToolUse contract).
set -euo pipefail
payload=$(cat)
path=$(printf '%s' "$payload" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"//;s/"$//')
case "$path" in
  *.agents/skills/*|*.claude/skills/*)
    echo "Edit blocked: $path is GENERATED. Edit skills/<name>/ and run: pnpm agents:sync" >&2
    exit 2
    ;;
esac
exit 0
