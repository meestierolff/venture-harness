@AGENTS.md

# Claude Code adapter

`AGENTS.md` is the canonical rule set. This file adds only Claude-specific
routing; it must not redefine authorization or product truth.

## Skills

Canonical skills live in `skills/<name>/`. Claude copies under
`.claude/skills/` are generated: edit the canonical source, run
`pnpm agents:sync`, then `pnpm agents:check`.

| Canonical                      | Claude                         |
| ------------------------------ | ------------------------------ |
| `$launch-orchestrator`         | `/launch-orchestrator`         |
| `$venture-bootstrap`           | `/venture-bootstrap`           |
| `$provider-operations`         | `/provider-operations`         |
| `$mobile-launch`               | `/mobile-launch`               |
| `$offer-architect`             | `/offer-architect`             |
| `$validation-engine`           | `/validation-engine`           |
| `$experiment-analytics-engine` | `/experiment-analytics-engine` |
| `$learning-loops`              | `/learning-loops`              |
| `$design-director`             | `/design-director`             |
| `$seo-aeo-engine`              | `/seo-aeo-engine`              |
| `$distribution-engine`         | `/distribution-engine`         |
| `$workflow-graph-engineering`  | `/workflow-graph-engineering`  |
| `$knowledge-graph-engineering` | `/knowledge-graph-engineering` |
| `$product-truth`               | `/product-truth`               |
| `$quality-gate`                | `/quality-gate`                |
| `$harness-engineering`         | `/harness-engineering`         |
| `$weekly-learning`             | `/weekly-learning`             |

## Claude-specific practice

- Use subagents for bounded independent work; keep provider effects and final
  integration in the main context.
- Generated `.claude/skills/` and `.agents/skills/` are never hand-edited.
- Before completion, invoke `/quality-gate` and run `pnpm verify` plus the
  capability-appropriate staged profile.
- Tool approval does not broaden the run authorization envelope. Both must allow
  an external effect.
