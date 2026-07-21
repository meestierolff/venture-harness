@AGENTS.md

# Claude Code adapter

AGENTS.md above contains the canonical project rules. This file adds only
Claude Code specifics. Do not duplicate AGENTS.md here.

## Skills

- Canonical skills live in `skills/<name>/SKILL.md`.
- Claude-ready copies live in `.claude/skills/<name>/` and are **generated**.
  Never edit them directly.
- After changing a canonical skill: `pnpm agents:sync`.
- Before committing skill changes: `pnpm agents:check`.

Skill routing map (canonical → Claude invocation):

| Canonical                    | Claude                       |
| ---------------------------- | ---------------------------- |
| $venture-bootstrap           | /venture-bootstrap           |
| $offer-architect             | /offer-architect             |
| $validation-engine           | /validation-engine           |
| $experiment-analytics-engine | /experiment-analytics-engine |
| $design-director             | /design-director             |
| $seo-aeo-engine              | /seo-aeo-engine              |
| $distribution-engine         | /distribution-engine         |
| $harness-engineering         | /harness-engineering         |
| $workflow-graph-engineering  | /workflow-graph-engineering  |
| $knowledge-graph-engineering | /knowledge-graph-engineering |
| $product-truth               | /product-truth               |
| $quality-gate                | /quality-gate                |
| $weekly-learning             | /weekly-learning             |

## Claude-specific rules

- Use subagents (`.claude/agents/`) for bounded independent research or
  review. Keep the main context focused.
- Use scripts for transformation, validation, and aggregation — see
  `scripts/` and the `pnpm` commands in AGENTS.md.
- Do not invoke graph workflows ($workflow-graph-engineering,
  $knowledge-graph-engineering) for small tasks.
- Subagents must never publish, send, charge, deploy, or merge.
- Prefer plan mode before broad changes.
- Run the relevant checks (at minimum `pnpm verify`) before reporting
  completion.
- Use `/context` when instruction loading is unclear.
