# ADR-002: Lightweight durable workflow and provider runtime

- Status: accepted
- Date: 2026-08-04
- Deciders: founder `/goal`

## Context

The v0.1 workflow-graph capability is a planning protocol only. Launches need
parallel provider work, read-back verification, manual interrupts, retries,
resume after process failure, and proof that a side effect will not repeat.
Provider interfaces also differ: some have MCP integrations, some official
CLIs, some APIs, and some only honest human actions.

## Decision

Implement a small TypeScript DAG executor with typed nodes, atomic local state,
event traces, retry classification, budgets, cancellation, compensation hooks,
and checkpoint/resume. Use deterministic code for graph validation, routing,
state transitions, deduplication, and aggregation.

Put repository-local product judgement behind an agent-neutral `BuildAgentHost`.
The production CLI constructs its Codex adapter internally rather than accepting
a caller-supplied host or executor. The adapter starts one direct, ephemeral
Codex CLI process, projects a small environment for CLI authentication, sends a
bounded credential-free prompt through stdin, accepts structured JSONL output,
and persists only sanitized evidence. Rough-prose sharpening runs read-only from
a disposable non-repository directory; product work runs workspace-write inside
the staged child. Provider credentials, provider transports and external-effect
authority remain in the separate provider runtime. Keep quality profiles as
direct code commands.

This is a practical founder-alpha process boundary, not perfect or audited
OS-level read isolation. The Codex CLI necessarily retains access to its own
authentication/configuration state, and its sandbox remains part of the trusted
computing boundary. Fixture hosts remain test infrastructure rather than a
supported operator injection path.

Put provider behavior behind one capability adapter contract. Transport order
is appropriate installed MCP, official CLI, official API, then a precise manual
action. Every adapter declares effects, risk, reversibility, scopes,
idempotency, rate-limit behavior, verification, and redaction. Apply is never
success until read-back verification or an explicitly modeled manual result.

## Alternatives considered

| Alternative                                 | Why not                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| Adopt a heavyweight orchestration framework | It adds opaque state and deployment dependencies before the local graph needs them. |
| Keep graphs as prose                        | Prose cannot guarantee resume, idempotency, or atomic evidence.                     |
| Write one provider-specific launch script   | It would duplicate safety logic and make cross-rail planning brittle.               |
| Browser-automate provider dashboards        | It is fragile and unsafe for account, payment, DNS, and store effects.              |

## Consequences

The runtime and host contract stay inspectable and testable offline, but the
repository owns a state machine and process boundary that need strong invariant
tests. Fake-runner coverage and a locally available CLI do not imply model
quality, live dogfood success, provider success, or strong OS isolation.
Provider-specific gaps remain visible as manual actions. Reconsider a larger
runtime only if measured graph scale, distributed execution, or durability
requirements cannot be met without rebuilding commodity infrastructure.
