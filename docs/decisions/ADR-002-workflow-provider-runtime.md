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
The default Codex adapter uses one direct, ephemeral, workspace-write process,
passes its bounded prompt through stdin, accepts only structured JSONL output,
and persists only sanitized evidence. Keep quality profiles as direct code
commands. An injected product binding may replace this host for tests or another
agent implementation; unavailable hosts fail before a run is created.

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
tests. No live Codex execution is implied by fake-runner coverage. Provider-
specific gaps remain visible as manual actions. Reconsider a larger runtime only
if measured graph scale, distributed execution, or durability requirements
cannot be met without rebuilding commodity infrastructure.
