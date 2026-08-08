# OpenAI Codex adapter guide

Codex reads [AGENTS.md](../../AGENTS.md) as the canonical rule set. No adapter
may contain unique launch, authorization or product-truth policy.

Codex-ready copies under `.agents/skills/` are generated from `skills/`, include
their relevant references/assets/scripts and Codex metadata, and are committed so
discovery needs no build step. Edit only the canonical source, then run:

```bash
pnpm agents:sync
pnpm agents:check
```

Reference a skill by name or let its metadata route the task. Project state stays
in `config/`, `docs/`, `harness.lock` and the redacted `.venture/` runtime—not in
the skill.

Before completion, run `pnpm verify` and the applicable staged quality profile.
An external effect requires both tool permission and a run envelope that names
the provider, effect, environment and limits.
