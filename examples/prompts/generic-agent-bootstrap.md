# Generic frontier-agent bootstrap prompt

For Cursor, Windsurf, Gemini CLI, or any agent that can read repository
files:

```
This repository is a venture harness. Its constitution is AGENTS.md —
read it first and follow it for everything below.

Task: bootstrap the venture.

1. Read PROJECT.md and docs/plans/active/000-adopt-harness.md.
2. Read skills/venture-bootstrap/SKILL.md and follow it exactly. It
   defines inputs (inputs/*.md), the files you may and may not change,
   the execution steps, and the blockers that forbid application code.
3. Treat docs/ and config/ as sources of truth. Respect
   docs/product/PRODUCT_TRUTH.md: never claim a capability without a
   register row.
4. Use the deterministic scripts instead of re-deriving anything:
   pnpm tsx skills/offer-architect/scripts/thirty-day-cash.ts for
   economics; the pnpm validate:*/verify:* commands for checks.
5. When done: run pnpm verify, then report three sentences — what
   changed, what failed or remains unknown, what should happen next.

Hard boundaries: do not send, publish, charge, deploy, or merge anything.
Do not invent facts the briefs do not contain — record gaps as open
questions.
```
