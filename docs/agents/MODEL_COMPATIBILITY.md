# Model compatibility

Per-agent integration status. "Verified" means a maintainer ran the listed
flow against this repository on the stated date. Do not claim native
behaviour that has not been tested — untested rows say so.

| Agent                  | Canonical instructions | Adapter file                                         | Skill location        | Invocation style                                     | Verification command | Known limitations                                          | Last verified                                        |
| ---------------------- | ---------------------- | ---------------------------------------------------- | --------------------- | ---------------------------------------------------- | -------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| OpenAI Codex           | AGENTS.md              | — (native)                                           | `.agents/skills/`     | prompt names skill; metadata in `agents/openai.yaml` | `pnpm verify`        | skill auto-selection depends on Codex version              | untested — structure follows Codex docs              |
| Claude Code            | AGENTS.md              | CLAUDE.md (`@AGENTS.md`)                             | `.claude/skills/`     | `/skill-name` slash command                          | `pnpm verify`        | generated skills must be re-synced after canonical edits   | 2026-07-21 (repo built and checked with Claude Code) |
| Gemini CLI             | AGENTS.md              | GEMINI.md (plain pointers, no import syntax assumed) | `skills/` (canonical) | prompt names skill file path                         | `pnpm verify`        | no auto skill discovery                                    | untested — pointer file only                         |
| GitHub Copilot         | AGENTS.md              | `.github/copilot-instructions.md`                    | `skills/` (canonical) | reference skill in prompt/issue                      | `pnpm verify`        | instruction size limits; inline completions ignore context | untested — pointer file only                         |
| Cursor                 | AGENTS.md              | — (reads AGENTS.md)                                  | `skills/` (canonical) | prompt names skill                                   | `pnpm verify`        | agent mode required for multi-file work                    | untested                                             |
| Windsurf               | AGENTS.md              | — (reads AGENTS.md)                                  | `skills/` (canonical) | prompt names skill                                   | `pnpm verify`        | same as Cursor                                             | untested                                             |
| Generic frontier agent | AGENTS.md              | docs/agents/GENERIC_AGENT.md                         | `skills/` (canonical) | follow the 9-step procedure                          | `pnpm verify`        | manual read order                                          | n/a — procedure, not integration                     |

## Maintenance

When you verify an agent against this template, update its row with the
date and any limitation you hit, in the same PR as any fix. Rows older than
six months should be re-verified before being cited.
