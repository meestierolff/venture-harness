---
name: launch-orchestrator
description: Turn one founder brief or build prompt into a typed launch mode, product rail, capability set, resumable execution graph, verified MVP, and concise launch report. Use for vh create/plan/launch/resume flows and web, iOS, or hybrid launches; do not use for isolated feature edits or for bypassing provider authorization.
---

# launch-orchestrator

## Purpose

Compile an honest brief into the smallest useful, risk-bounded launch and drive
it through the deterministic `vh` runtime.

## Trigger conditions

- A founder asks to create, plan, launch, resume, or explain a venture run.
- Launch mode, rail, capabilities, or critical-path decisions are needed.

## When not to use

- One isolated code change, provider-only maintenance, or weekly evidence review.
- Any attempt to infer authorization for production effects not in the envelope.

## Required inputs

The brief/build prompt; venture, launch, provider, policy, loop, mobile, and
quality contracts; product truth; credential status; active authorization.

## Documents to read

Read `PROJECT.md`, the active plan, relevant ADRs, `ARCHITECTURE.md`, and only
the rail/provider documents activated by the compiled plan.

## Files this skill may change

Venture-owned code/docs/config, launch graph inputs, migration-safe contracts,
tests, fixtures, and sanitized launch reports declared by the active run.

## Files this skill must not change

Credential values, another venture, provider state without read-back evidence,
product-truth claims without evidence, or centrally managed files outside an
upgrade transaction.

## Execution steps

1. Parse the brief and label known truth, assumptions, constraints, and gaps.
2. Block only unintelligible outcome, deception, unsafe non-defaultable choice,
   missing indispensable credential/action, or unauthorized irreversible effect.
3. Select `validate_first`, `thin_mvp`, `product_first`, or `concierge_first`;
   record confidence, rationale, rejected modes, and change evidence.
4. Select web, iOS, cross-platform, or hybrid rail and one entitlement source.
5. Resolve the smallest capability and event-pack set.
6. Run `vh plan` and inspect effects, cost, approvals, manual actions, critical
   path, parallel nodes, and verification.
7. Run dry-run before apply. Execute only inside the envelope; checkpoint and
   resume instead of restarting.
8. Run capability-aware gates and emit JSON plus human launch reports.

## Hard rules

- Reversible local work is not blocked by non-critical commercial unknowns.
- No mock/manual result becomes verified provider state.
- No duplicate side effect, dual entitlement source, fabricated output, or
  silent provider no-op.
- Keep secrets out of config/logs and PII out of analytics.
- Production deploy, charge, DNS, sending, store, deletion, and spend effects
  obey the authorization envelope.

## Expected output

A typed decision, durable run, verified artifacts, concise launch report, and
only unavoidable manual actions with exact resume inputs.

## Validation

Run fixture/local graph checks plus the active fast, MVP, or release profile.
Provider success requires read-back evidence.

## Failure behaviour

Persist the failure, classify retryability, continue independent nodes, and
report exact remediation. Never substitute prose for a failed artifact.

## Human approval boundaries

The active envelope governs effects. Distinct approval remains mandatory for
deletion, destructive production data, nameserver replacement, bulk/cold send,
cap overrun, unauthorized real charge, and irreversible store publication.
