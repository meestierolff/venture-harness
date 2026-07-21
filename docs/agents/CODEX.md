# OpenAI Codex adapter guide

## Instruction source

Codex reads [AGENTS.md](../../AGENTS.md) natively from the repository root.
There is no separate Codex constitution — AGENTS.md is canonical for every
agent.

## Skills

Codex-ready skill copies live in `.agents/skills/<name>/`, generated from
`skills/<name>/` by `pnpm agents:sync`. Each generated folder contains the
skill's `SKILL.md` (with a generated-file marker after the frontmatter),
its `references/`, `scripts/`, `assets/`, and the Codex metadata file
`agents/openai.yaml`.

Do not edit `.agents/skills/` directly. Edit `skills/` and re-sync.

## Invocation

Reference a skill in your prompt ("use the offer-architect skill") or let
Codex select it from the metadata descriptions. The skill's SKILL.md is the
procedure; project state lives in `docs/` and `config/`.

## Verification

Before reporting completion:

```bash
pnpm verify
```

## Boundaries

Codex must not send, publish, charge, deploy, or merge. Those actions are
human-gated everywhere in this repository.
