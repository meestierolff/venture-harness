# Architecture Decision Records

Decisions that shape the harness or the venture, with alternatives and
consequences. One file per decision, numbered, never rewritten — superseded
decisions get a new ADR that references the old one.

Template: [ADR-000-template.md](ADR-000-template.md)

## Register

| #   | Title                                                              | Status   | Date       |
| --- | ------------------------------------------------------------------ | -------- | ---------- |
| 000 | (template)                                                         | —        | —          |
| 001 | Progressive commitment and launch modes                            | accepted | 2026-08-04 |
| 002 | Lightweight durable workflow and provider runtime                  | accepted | 2026-08-04 |
| 003 | Provider-neutral credential references and authorization envelopes | accepted | 2026-08-04 |
| 004 | Versioned managed-file upgrades                                    | accepted | 2026-08-04 |

## When an ADR is required

- Changing validation thresholds after launch.
- Adding or removing an analytics provider or event destination.
- Introducing a workflow graph or knowledge graph.
- Weakening any consent, PII, or approval rule (requires explicit human
  sign-off recorded in the ADR).
- Expanding product scope past the validation site.

## Harness v0.2 decisions

- [ADR-001](ADR-001-progressive-commitment.md)
- [ADR-002](ADR-002-workflow-provider-runtime.md)
- [ADR-003](ADR-003-credentials-and-authorization.md)
- [ADR-004](ADR-004-versioned-upgrades.md)
