# GitHub Copilot adapter guide

## Instruction source

Copilot reads
[.github/copilot-instructions.md](../../.github/copilot-instructions.md),
which points to [AGENTS.md](../../AGENTS.md), [PROJECT.md](../../PROJECT.md),
the active plan, and the canonical skills. It deliberately duplicates
nothing.

## Skills

Copilot (chat and coding agent) uses canonical skills from
`skills/<name>/SKILL.md`. Reference them explicitly in prompts or issues
assigned to the coding agent.

## Working with Copilot coding agent

- Put the task's skill reference and the relevant docs in the issue body.
- Require `pnpm verify` in the acceptance criteria.
- PRs from Copilot follow the same run-envelope boundaries. External effects
  need the named provider/environment/effect authorization; publish and merge
  still need explicit human review.

## Known limitations

- Instruction file size is limited; that is why copilot-instructions.md is
  a pointer, not a constitution.
- Inline completion does not read AGENTS.md context reliably; rely on chat
  or the coding agent for harness-aware work.
