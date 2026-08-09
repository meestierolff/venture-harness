# WORKFLOW GRAPHS

The launch runtime is a small TypeScript DAG executor. Large planning work can
also use `$workflow-graph-engineering`; neither needs a heavyweight orchestration
framework.

## Node contract

Each node declares purpose, kind, capability, dependencies, input/output
validators, transport, effect, risk, authorization, idempotency key, timeout,
retry/backoff, concurrency group, cost/budget, cache, isolation, compensation,
evidence and completion criteria.

Exact node states are:

`pending`, `ready`, `running`, `waiting_for_approval`,
`waiting_for_manual_action`, `succeeded`, `failed_retryable`,
`failed_terminal`, `skipped`, `compensated`.

## Scheduling

The executor validates dependencies and cycles, runs independent nodes in
parallel, serializes shared concurrency groups, waits at fan-in edges, evaluates
conditions deterministically, applies bounded retry/backoff and stops at budget,
iteration, timeout or terminal failure limits.

Manual or approval nodes pause honestly while independent work continues. They
request structured fields and evidence; they do not hide an unavoidable task in
a log paragraph.

## Durability and resume

`.venture/runs/<run-id>/state.json` is replaced atomically and
`events.jsonl` is append-only. Both are redacted and gitignored. A resume must
load the same graph fingerprint and registered handlers. Verified effects and
run cache prevent blind replay; providers still read state back because local
idempotency alone cannot prove external state.

Known provider estimates are reserved in this durable state before transport.
Reservations are attempt-scoped, audited, and accumulated against the active
run-envelope ceiling, so individually valid operations cannot exceed it in
aggregate.

Use:

```bash
vh status [run-id]
vh explain [run-id] <node-id>
vh resume <run-id>
vh resume <run-id> --authorization <same-profile>
vh cancel <run-id> --reason "..."
```

Cancellation persists before optional compensation. Compensation is used only
when declared and safe; it is not a promise that every external effect can be
reversed.

## Model boundary

Code handles validation, routing, dependency plumbing, redaction, caching,
budgets and provider execution. Model nodes are reserved for ambiguous product
decisions, design, qualitative synthesis and critique. Private chain-of-thought
is never stored; concise rationale and evidence references are.

## Related

- [../../lib/workflow/](../../lib/workflow/)
- [../../skills/workflow-graph-engineering/SKILL.md](../../skills/workflow-graph-engineering/SKILL.md)
- [../operations/TROUBLESHOOTING.md](../operations/TROUBLESHOOTING.md)
