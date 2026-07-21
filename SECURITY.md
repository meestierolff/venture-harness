# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's "Report a
vulnerability" flow (repository → Security tab → Advisories). Do not open
a public issue for exploitable problems.

Include: affected file or script, reproduction steps, and impact. You should
receive an acknowledgement within a few days.

## Scope

This is a template repository. It ships no production service, but ventures
created from it will run real websites. Security-relevant surfaces:

- `app/api/*` route handlers (lead intake, evidence persistence).
- `scripts/*` (run locally and in CI).
- `.claude/hooks/*` (run by Claude Code on contributor machines).
- CI workflows under `.github/workflows/`.

## Design commitments

- No secrets in the repository. `.env*` is gitignored; only `.env.example`
  is committed. `pnpm release:check` scans for leaked credentials.
- Hooks and scripts never deploy, send messages, charge, upload source, or
  expose environment variables.
- Analytics code excludes personal data by construction; see
  `docs/engineering/ANALYTICS.md` and `scripts/verify-analytics-pii.ts`.
- First-party evidence storage (Neon) is per-venture and never shared.

## Supported versions

Only the latest `main` of the template is supported. Ventures should pull
framework fixes deliberately, not automatically.
