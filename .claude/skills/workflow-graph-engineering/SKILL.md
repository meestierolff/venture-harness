---
name: workflow-graph-engineering
description: Design, compile, execute, inspect, and improve explicit multi-node workflow graphs with typed state, data-only edges, deterministic routing, bounded parallelism, checkpoints, retries, budgets, evidence, and human interrupts. Use only when explicitly invoked for a genuinely large parallelizable workflow or when maintaining the vh graph runtime; never introduce a graph for small or linear work.
---

<!-- GENERATED FILE - do not edit. Canonical source: skills/workflow-graph-engineering/SKILL.md. Regenerate with: pnpm agents:sync -->

# workflow-graph-engineering

## Purpose

Use the lightweight `vh` runtime to make large workflows inspectable,
resumable, idempotent, and failure-isolated.

## Trigger conditions

- Explicit invocation for work with at least four bounded jobs and real data dependencies.
- Runtime/schema/scheduler work for an existing launch graph.

## When not to use

- Small, linear, or independent checklist work.
- A graph used as decoration or a knowledge graph for launch orchestration.

## Required inputs

Goal, typed node inputs/outputs, active plan, runtime policies, validators,
budgets, authorization envelope, and relevant capability/provider descriptors.

## Documents to read

Read `docs/engineering/WORKFLOW_GRAPHS.md`, the active plan/graph, relevant
ADRs, and `references/planning-v0.1.md` only for migration ambiguity.

## Files this skill may change

Active graph plans, `lib/workflow/**`, graph tests/fixtures, declared node
outputs, sanitized run/launch reports, and runtime docs.

## Files this skill must not change

Anything outside declared node outputs, secrets, append-only memory except via
scripts, or provider state without adapter read-back.

## Execution steps

1. Define bounded nodes with purpose, capability, dependencies, condition,
   structured I/O contract, deterministic validator, transport/model tier,
   effect/risk/auth, idempotency, timeout/retry/backoff, concurrency, budget,
   cache/isolation, compensation, evidence, and completion criterion.
2. Add an edge only when downstream consumes named upstream data. Validate IDs,
   references, cycles, authorization, budgets, and fan-in contracts.
3. Use code for routing, state, retries, aggregation, caching, deduplication, and
   budgets; use models for judgment, synthesis, critique, and writing.
4. Dry-run to inspect critical path, parallel work, effects, cost, approvals,
   manual actions, and verification.
5. Execute with atomic state/events after every transition. Interrupt for real
   approval/manual input and resume the same run.
6. Retry only retryable failures; never repeat a verified idempotency key;
   compensate only when declared safe.
7. Summarize outcomes, trace/cost/timing, failures, and graph-structure lessons.

## Hard rules

- Invocation remains explicit and `implicit_invocation: false`.
- Node states follow the runtime contract; no fabricated substitute output.
- Human interrupts are persisted and never simulated.
- Secrets are redacted before logs, traces, state, or reports.
- Budgets and maximum loop iterations are hard stops.
- Diverse verifiers do not receive the intended answer; code deduplicates
  against every prior finding.

## Expected output

A validated graph, durable run state and trace, declared artifacts, evidence,
and a concise summary of outcomes, limits, cost, and structure lessons.

## Validation

Run graph schema/cycle/scheduling/fan-in/condition/resume/interruption/
idempotency/retry/compensation/budget/redaction/outage tests plus the applicable
quality profile.

## Failure behaviour

Preserve inputs/state, classify retryability, isolate siblings, and stop after
the declared retry/iteration budget. Never restart the full graph merely to
resume one blocked node.

## Human approval boundaries

Authorization nodes gate effects outside the active envelope. Deletion,
destructive production data, nameserver replacement, bulk/cold sending, excess
spend, unauthorized charges, and irreversible store publication remain distinct
checkpoints.
