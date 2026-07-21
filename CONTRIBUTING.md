# Contributing to Venture Harness

Thanks for improving the harness. This repository is a template for building
ventures; contributions should improve the _framework_, not add venture facts.

## Ground rules

- Read [AGENTS.md](AGENTS.md) first. It applies to humans too.
- One conceptual change per pull request.
- Deterministic work belongs in `scripts/`, judgement belongs in `skills/`.
- Never commit secrets, real customer data, or real analytics exports.
- Never edit generated directories (`.agents/skills/`, `.claude/skills/`)
  directly — edit `skills/` and run `pnpm agents:sync`.

## Workflow

1. Fork and branch from `main`.
2. Make your change. Update docs in the same PR when behaviour changes.
3. Run the full gate locally:

   ```bash
   pnpm install
   pnpm agents:sync
   pnpm verify
   ```

4. Open a PR using the template. State what changed, what you verified, and
   what remains unknown.

## What we accept

- Bug fixes in scripts, checks, and the web foundation.
- Sharper skill procedures backed by real usage (say which agent/model).
- New verification checks that catch real failure modes.
- Documentation that removes ambiguity.

## What we decline

- Branded styling, marketing copy, or venture-specific content.
- Always-on instruction growth (new global rules in AGENTS.md) when a
  script, test, or skill-local rule would do.
- Features that require paid services to pass CI.
- Anything that lets an agent send, publish, charge, deploy, or merge
  without human approval.

## Reporting issues

Use the issue templates. For security problems see [SECURITY.md](SECURITY.md).
