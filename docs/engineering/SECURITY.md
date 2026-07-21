# SECURITY (engineering practice)

Repository-level policy lives in [/SECURITY.md](../../SECURITY.md). This
file covers venture-runtime practice.

## Surfaces and controls

| Surface           | Control                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| Forms / API input | Zod validation, unknown fields rejected, size limits                        |
| Lead data         | only in Neon `submissions`; never in analytics, logs, or client state       |
| Secrets           | env vars only; `.env*` gitignored; per-venture, never shared                |
| Admin access      | none in template; any future admin surface requires auth + ADR              |
| Dependencies      | lockfile committed; review on update; no postinstall scripts added casually |
| Analytics         | PII prohibition enforced by scripts + tests                                 |
| Consent           | strict default; state changes logged first-party                            |
| CI                | no secrets in workflows; parity and release checks required                 |

## Abuse considerations for a validation site

- Rate-limit lead endpoints (per-IP token bucket) to keep evidence clean.
- Honeypot field on forms; failed honeypots are recorded as spam, not leads.
- Never echo submitted content back unescaped.
- Bot traffic is filtered before demand analysis (see weekly analysis).

## Security review

The `security-reviewer` subagent (`.claude/agents/security-reviewer.md`)
covers authentication, forms, data, secrets, admin access, analytics, and
consent before launch and after material changes.
