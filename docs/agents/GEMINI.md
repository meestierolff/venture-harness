# Gemini CLI adapter guide

## Instruction source

Gemini CLI reads [GEMINI.md](../../GEMINI.md) at the repository root. That
file is a thin pointer: it instructs Gemini to read
[AGENTS.md](../../AGENTS.md), [PROJECT.md](../../PROJECT.md), the active
plan, and the relevant canonical skill. It assumes no import syntax —
plain "read these files" instructions only.

## Skills

Gemini uses the canonical skills directly from `skills/<name>/SKILL.md`.
No generated copies are produced for Gemini; the canonical files are
already plain Markdown.

## Invocation

Name the skill in the prompt: "Follow skills/validation-engine/SKILL.md to
design the demand hypotheses." Paste or reference the file path — Gemini
CLI can read repository files natively.

## Verification

```bash
pnpm verify
```

## Known limitations

- No native skill discovery: the operator or prompt must name the skill.
- Instruction files are not auto-chained; GEMINI.md lists the read order
  explicitly for this reason.
