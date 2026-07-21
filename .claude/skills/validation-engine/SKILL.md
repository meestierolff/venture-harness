---
name: validation-engine
description: Design and maintain demand hypotheses, validation tests, success thresholds, stop rules, and build/iterate/reposition/kill decision rules. Use when planning what to validate and how to judge it. Do not use for implementing tracking or analysing experiment data — that is experiment-analytics-engine.
---

<!-- GENERATED FILE - do not edit. Canonical source: skills/validation-engine/SKILL.md. Regenerate with: pnpm agents:sync -->

# validation-engine

## Purpose

Decide **what should be tested** and **what the evidence must show**:
demand hypotheses, test designs (ICP, hero, proof, pricing, CTA,
fake-door, pilot), qualification rules, thresholds, stop rules, and the
30/60/90-day decision gates.

## Trigger conditions

- Bootstrap step 4 (called by $venture-bootstrap).
- New hypothesis to test; a gate review approaching; a decision needed.
- A weekly report shows a threshold crossed.

## When not to use

- Implementing assignment, tracking, storage, or analysis — that is
  $experiment-analytics-engine.
- Choosing channels — that is $distribution-engine.

## Required inputs

- docs/business/OFFER.md and ICP.md (coherent)
- config/venture.yaml (validation block)
- memory/experiments.jsonl and outcomes.jsonl (history, may be empty)

## Documents to read

AGENTS.md, docs/product/VALIDATION.md, EXPERIMENTS.md, PRODUCT_TRUTH.md,
docs/business/OFFER.md, config/experiments.yaml, config/analytics.yaml.

## Files this skill may change

`docs/product/VALIDATION.md`, `docs/product/EXPERIMENTS.md` (register and
interpretation), `config/experiments.yaml` (definitions, status: draft),
`config/venture.yaml` (validation block), `PROJECT.md` (pending decisions).

## Files this skill must not change

`lib/**`, `app/**`, `components/**` (implementation belongs to
$experiment-analytics-engine under a plan), `docs/product/PRODUCT_TRUTH.md`
(propose to $product-truth), `memory/*` except via append scripts.

## Execution steps

1. Write demand hypotheses as falsifiable statements with thresholds.
2. Define the test setup: audience, offer shown, traffic source,
   conversion events (names from config/analytics.yaml), qualification
   fields and rule.
3. Design tests one concept at a time: ICP tests, hero tests, proof tests,
   pricing hypotheses, CTA tests, fake-door flows (with post-click
   disclosure), pilot flows.
4. Declare per test: primary metric, secondary metrics, guardrails,
   sample limits, stopping rules, attribution requirements — before start.
5. Set success/failure definitions and the 30/60/90-day gates; write stop
   rules into VALIDATION.md and config/venture.yaml.
6. Record product-truth disclosures the tests require (prototype labels,
   concierge disclosure, sample-data labels).
7. Hand implementable definitions to $experiment-analytics-engine via
   config/experiments.yaml entries (status: draft).
8. At decision time: apply the pre-declared rules to the evidence and
   record build / iterate / reposition / kill with limitations.

## Hard rules

- No fake testimonials, customers, or transactions. No payment collected
  for an undeliverable service. No hidden ownership or rights transfer.
- Label sample and demo data.
- Optimise for high-intent behaviour, not page views or signups.
- Store exact offers and prices shown (delegated to the analytics engine).
- Distinguish exploration from a controlled test; report them differently.
- Document sample limitations with every result.
- Do not declare winners from weak evidence; "inconclusive" is a result.
- Change one experimental concept at a time.

## Expected output

Updated VALIDATION.md (hypotheses, setup, definitions, gates, stop rules,
disclosures), experiment definitions in config/experiments.yaml (draft),
updated EXPERIMENTS.md register, decisions recorded with limitations.

## Validation

`pnpm verify` passes; every hypothesis has a threshold; every experiment
has primary metric + stopping rule + minimum observations; gates have
dates once launch_date is set.

## Failure behaviour

When evidence is insufficient for a decision, the recorded outcome is
"insufficient evidence — continue / stop per pre-declared rule", never a
softened win. Missing thresholds block launch, and the block is reported.

## Human approval boundaries

The founder approves: activating any experiment (draft → approved),
fake-door tests, pilot terms, and all gate decisions. This skill prepares;
humans decide.
