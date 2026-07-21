# GitHub Copilot instructions

This repository's canonical rules live in [AGENTS.md](../AGENTS.md). Read
it first — it is short by design. Do not look for rules here; this file is
a pointer.

For any substantial task:

1. Read [AGENTS.md](../AGENTS.md) (constitution, skill routing, hard
   rules, definition of done).
2. Read [PROJECT.md](../PROJECT.md) (current venture state).
3. Read the active plan under `docs/plans/active/`.
4. Read the relevant canonical skill: `skills/<name>/SKILL.md`.

Before reporting completion:

```bash
pnpm verify
```

Never send messages, publish content, charge customers, deploy, or merge
without human approval. More detail: [docs/agents/GITHUB_COPILOT.md](../docs/agents/GITHUB_COPILOT.md).
