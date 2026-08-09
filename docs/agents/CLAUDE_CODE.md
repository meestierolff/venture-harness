# Claude Code adapter guide

[CLAUDE.md](../../CLAUDE.md) imports [AGENTS.md](../../AGENTS.md), then adds only
Claude invocation names. Claude-ready skill copies under `.claude/skills/` are
generated from `skills/`; Codex-only metadata is excluded.

Do not edit generated skills. Run:

```bash
pnpm agents:sync
pnpm agents:check
```

Use subagents for bounded independent research/review, but keep run
authorization, provider effects and final integration in the controlling
context. A tool approval does not expand the active authorization envelope.

Optional hooks are documented in `.claude/README.md`; none may hide a provider
effect, store a secret or enable scheduled external actions by default.
