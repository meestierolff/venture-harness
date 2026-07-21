# .claude/

Claude Code adapter directory. Canonical rules live in
[../AGENTS.md](../AGENTS.md); Claude specifics in [../CLAUDE.md](../CLAUDE.md).

## skills/ (GENERATED)

Generated from [../skills/](../skills/) by `pnpm agents:sync` — never edit
here. Parity is CI-enforced (`pnpm agents:check`).

## agents/

Eight bounded subagents: market-researcher, offer-critic,
evidence-verifier, product-truth-auditor, visual-reviewer, seo-auditor,
experiment-analyst, security-reviewer. Each has one responsibility, clear
inputs and output, and prohibited actions — none may deploy, publish,
send, charge, or merge.

## hooks/

Optional safe scripts. None are enabled by default: `settings.json` is
deliberately not committed (commit it only after validating its schema
and confirming safe defaults for your machine). To enable, wire them in
your local `.claude/settings.json`, e.g.:

| Script                      | Suggested hook                     | What it does                           |
| --------------------------- | ---------------------------------- | -------------------------------------- |
| `check-generated-skills.sh` | PreToolUse (Edit/Write)            | blocks edits to generated skill copies |
| `check-secrets.sh`          | PreToolUse (Bash git commit)       | warns on credential-shaped strings     |
| `check-product-truth.sh`    | PostToolUse (app/components edits) | runs the claims validator              |
| `check-analytics-pii.sh`    | PostToolUse (analytics edits)      | runs the PII checks                    |
| `check-consent.sh`          | PostToolUse (consent edits)        | runs the consent checks                |
| `run-fast-validation.sh`    | Stop                               | fast validator slice before finishing  |

All hooks are read-only-plus-local-validation. None deploy, send, merge,
rewrite repository sections, call paid services, upload source, or expose
environment variables. Keep it that way.
