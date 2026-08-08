---
name: venture-bootstrap
description: Convert a founder brief or build prompt into the minimum truthful v0.2 venture contract, explicit assumptions, selected launch mode and rail inputs, compact core documents, and a launch-ready plan. Use when creating a new child venture or upgrading template-empty inputs; do not use for an already-bootstrapped feature, redesign, provider operation, or learning review.
---

# venture-bootstrap

## Purpose

Create enough coherent, reviewable state for `$launch-orchestrator` to start
building without forcing non-critical commercial paperwork.

## Trigger conditions

- `vh create --brief`, a new child repository, or template-empty venture docs.

## When not to use

- Existing venture feature work, redesigns, new experiments, provider apply,
  or central harness development.

## Required inputs

One brief/build prompt containing a specific user/audience, problem/job, useful
outcome, smallest core journey, primary success signal, material constraints,
and known truth/assumptions.

## Documents to read

Read inputs, product truth template, venture/launch/policy contracts, project
state, active plan, and `references/validation-bootstrap-v0.1.md` only when
upgrading an old validation-first venture.

## Files this skill may change

Venture contract/config, `PROJECT.md`, compact product truth, launch plan,
architecture/ADR, measurement plan, decision log, runbook, privacy inventory,
and venture-owned brief artifacts.

## Files this skill must not change

Application code, provider resources, credential values, generated adapters,
or claims beyond the supplied evidence during this bootstrap step.

## Execution steps

1. Parse the brief; separate verified facts, founder assertions, assumptions,
   constraints, unknowns, and contradictions.
2. Block only unintelligible outcome, deception, material unsafe choice that
   cannot default, indispensable credential/action absence, or unauthorized
   irreversible effect.
3. Record all other missing information as labeled assumptions/backlog.
4. Populate the v0.2 venture contract and conservative risk/privacy defaults.
5. Produce inputs for mode/rail/payment/capability routing without preempting
   the deterministic/router decision.
6. Create only the compact core docs relevant to active capabilities.
7. Hand off to `$launch-orchestrator` for `vh plan` and dry run.

## Hard rules

- Never invent market evidence, users, pricing, integrations, metrics, or capability state.
- No mandatory pricing experiment; experiments require traffic and decision value.
- No universal 30/60/90 plan; preserve it only for selected `validate_first`.
- Sample, prototype, planned, and concierge work stays labeled.
- Missing non-critical facts do not block reversible local code.

## Expected output

A valid v0.2 contract, assumptions/backlog, compact core docs, and a launch-plan
handoff with only genuine blockers.

## Validation

Run config/document validation and `vh plan`; verify every public claim status
and active core journey has a primary signal.

## Failure behaviour

Preserve parsed inputs and report the exact blocking field or contradiction.
Do not fill a gap with model invention or silently fall back to validation-first.

## Human approval boundaries

Bootstrap writes local reviewable state only. Provider apply, deployment,
publication, sending, charging, DNS, and store effects remain envelope-gated.
