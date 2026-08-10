---
name: quality-gate
description: Select and run the capability-aware fast, MVP, release, live, or stable verification profile before completion, covering changed code, critical journeys, provider dry runs/read-backs, migrations, security, privacy, truth, accessibility, web crawling, mobile readiness, fixtures, and generated parity. Use before reporting any repository change done or preparing a PR/release; never call a skipped check a pass.
---

<!-- GENERATED FILE - do not edit. Canonical source: skills/quality-gate/SKILL.md. Regenerate with: pnpm agents:sync -->

# quality-gate

## Purpose

Prove the changed behavior at a depth proportionate to capability and risk while
always preserving secrets, PII, prices, truth, migrations, and critical journeys.

## Trigger conditions

- Any task is about to be reported complete, committed for review, or released.
- A staged quality command or launch graph invokes this gate.

## When not to use

- As a substitute for tests or as permission to lower a failing threshold.

## Required inputs

Change set, active capabilities/rail/environment, `config/quality.yaml`, active
plan, provider evidence, and product truth when public claims changed.

## Documents to read

Read the active plan, quality contract, relevant capability runbooks, and
product truth for public surfaces. Load `references/v0.1-monolithic-gate.md`
only for compatibility questions.

## Files this skill may change

Sanitized quality/release reports and unambiguous defect fixes revealed by the
checks. It does not broaden product scope.

## Files this skill must not change

Quality thresholds, provider evidence, generated directories, or product truth
to make checks pass.

## Execution steps

1. Select `fast`, `mvp`, `release`, `live`, or `stable` and resolve the
   capability-to-check map.
2. Always run applicable config/graph, secret, PII, price, product-truth,
   migration, critical-journey, and generated-parity checks.
3. Fast: changed formatting/lint/type/tests plus affected contracts and obvious
   leaks; use for inner loops, never final release evidence.
4. MVP: full typecheck/build, critical unit/integration/journeys, database and
   active payment/email/analytics checks, core accessibility/responsiveness,
   public HTML/metadata/sitemap, and provider dry-run.
5. Release: every applicable deterministic check, full e2e, desktop/mobile
   screenshots, accessibility/crawler passes, checkout/webhook/email contract
   tests, upgrade/rollback, graph resume/idempotency, mobile build/TestFlight
   readiness, ASO, and release report. This profile contains no live provider
   read-back and must be able to reach PASS with nothing connected.
6. Live: only real provider read-back. `INCOMPLETE` is an honest result before
   a real launch and names the provider, missing prerequisite, exact command,
   and expected read-back. It passes only for the scope actually observed.
7. Stable: every release check plus the required live read-back evidence.
8. Run independent checks in parallel when isolation is safe; cache only by
   declared deterministic inputs.
9. Record exact commands, pass/fail/skipped status, artifacts, and limitations.

## Hard rules

- Never report completion before the compatibility `pnpm verify` gate has run.
- A skipped check states why, missing credential/environment, exact command,
  and expected evidence.
- Capability selection removes irrelevant checks, never invariant checks.
- Mock/dry-run provider evidence is labeled and never a live pass.
- Desktop and mobile flows are both exercised for responsive UI changes.
- Never weaken tests, thresholds, truth, consent, or migration safety for green.

## Expected output

A three-sentence progress report backed by a machine/human quality report with
commands, artifacts, passes, failures, skips, limitations, and next action.

## Validation

The selected profile itself must resolve deterministically from capabilities;
every required check is either executed or explicitly skipped with the required
four fields.

## Failure behaviour

Quote the failing command/output. Fix only an unambiguous in-scope defect, then
rerun the affected and enclosing profile; otherwise return the exact blocker.

## Human approval boundaries

This gate verifies only. Green does not deploy, publish, submit, charge, send,
merge, or approve an effect.
