# Generic frontier-agent guide

For any coding agent that can read repository files (Cursor, Windsurf, and
future agents). A ready-made bootstrap prompt lives at
[examples/prompts/generic-agent-bootstrap.md](../../examples/prompts/generic-agent-bootstrap.md).

## Procedure

1. Read [AGENTS.md](../../AGENTS.md) — constitution, navigation map, hard
   rules, definition of done.
2. Read [PROJECT.md](../../PROJECT.md) — current venture state.
3. Read the active plan under [docs/plans/active/](../plans/active/).
4. Read the relevant canonical skill: `skills/<name>/SKILL.md`. The skill
   routing table in AGENTS.md maps tasks to skills.
5. Read the task-relevant source-of-truth docs (the skill lists them).
6. Preserve product truth: no public claim beyond
   [docs/product/PRODUCT_TRUTH.md](../product/PRODUCT_TRUTH.md).
7. Use the deterministic scripts (`package.json` scripts) for
   transformation, validation, and aggregation — do not re-derive them.
8. Run verification before reporting completion:

   ```bash
   pnpm verify
   ```

9. Do not perform human-gated actions: sending messages, publishing
   content, charging customers, changing production infrastructure,
   deploying, merging self-improvement proposals, or enabling scheduled
   external actions.

## Cursor and Windsurf

Both read `AGENTS.md` as the canonical general instruction source. Do not
create `.cursorrules` or Windsurf rule files that duplicate it; if a thin
pointer file is desired, it should contain only "Read AGENTS.md first" and
the verification command.
