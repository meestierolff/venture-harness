---
name: offer-architect
description: Define and stress-test the ICP, offer, pricing, and thirty-day economics of a venture. Use when creating or revising the commercial offer, pricing structure, guarantees, or unit economics. Do not use for implementing pricing pages or running pricing experiments.
---

# offer-architect

## Purpose

Produce a commercial offer strong enough to test: a starving-crowd ICP, a
value-equation-driven promise, a priced offer stack, and a deterministic
thirty-day cash model — then attack it until the weaknesses are explicit.

## Trigger conditions

- Bootstrap step 3 (called by $venture-bootstrap).
- Any request to create or revise offer, pricing, guarantee, or economics.
- Weekly-learning evidence suggests the offer, not the page, is the problem.

## When not to use

- Implementing pricing UI (that is build work under an active plan).
- Designing pricing experiments (that is $validation-engine +
  $experiment-analytics-engine).
- Copywriting polish (that is $design-director / content work).

## Required inputs

- `inputs/VENTURE_BRIEF.md`, `inputs/RESEARCH.md`
- `memory/customer-language.jsonl` (may be empty early)
- Current `docs/business/*` and `config/offer.yaml`

## Documents to read

AGENTS.md, docs/business/OFFER.md, ICP.md, PRICING.md, ECONOMICS.md,
COMPETITION.md, docs/product/PRODUCT_TRUTH.md, config/offer.yaml,
references/offer-checklist.md (in this skill).

## Files this skill may change

`docs/business/*`, `config/offer.yaml`, `PROJECT.md` (pending decisions),
`memory/*.jsonl` via append scripts.

## Files this skill must not change

`app/**`, `components/**`, `lib/**`, `config/experiments.yaml` (propose to
$validation-engine instead), `docs/product/PRODUCT_TRUTH.md` (propose to
$product-truth), `skills/**`, `scripts/**`.

## Execution steps

1. Score the market: starving crowd, pain, purchasing power, targetability,
   urgency, frequency — each with evidence or a labeled assumption.
2. Write the offer sentence in the required structure:
   _We help [specific customer] achieve [specific outcome] without
   [specific delay, effort, risk or sacrifice]._
   Reject generic ICPs unless meaningfully narrowed.
3. Build the value equation: dream outcome, perceived likelihood, available
   proof, missing proof, time delay, day-one win, effort and sacrifice.
4. Inventory friction step by step; mark done-for-you opportunities.
5. Construct the offer stack: core offer, setup fee, annual offer with
   setup-fee waiver decision, day-one upsell, conditional guarantee.
6. Fill `config/offer.yaml` (pricing + economics assumptions).
7. Run the deterministic calculator and paste its verbatim output into
   ECONOMICS.md:
   `pnpm tsx skills/offer-architect/scripts/thirty-day-cash.ts`
   Never substitute model arithmetic.
8. Define competitive separation: wedge, expansion, moat hypothesis; and
   kill criteria.
9. Attack pass: argue against the offer (weak ICP, no purchasing power,
   commodity risk, unclear outcome, weak economics). Record surviving
   weaknesses as open questions. Optionally dispatch the offer-critic
   subagent for an independent pass.
10. Update PROJECT.md pending decisions with anything unresolved.

## Hard rules

- Calculations come from the script, never from a model call.
- Every score cites evidence or is labeled an assumption.
- No proof may be claimed that PRODUCT_TRUTH.md cannot back.
- Unpriced service work is a blocker, not a footnote.
- Thirty-day payback is the default target; deviating requires an ADR.

## Expected output

Completed OFFER.md, ICP.md, PRICING.md, ECONOMICS.md (with calculator
output), COMPETITION.md; filled `config/offer.yaml`; explicit kill
criteria; a list of surviving weaknesses.

## Validation

`pnpm verify` passes; calculator output in ECONOMICS.md matches a fresh
run; offer sentence matches the required structure; no "—" placeholders
remain in the market-quality table.

## Failure behaviour

If evidence is too thin to score a factor, record the factor as UNKNOWN
with the exact research needed, add it to PROJECT.md pending decisions,
and stop short of inventing a score.

## Human approval boundaries

This skill defines the offer; it never publishes it, prices a live page,
or charges anyone. Pricing changes on a live site require an approved plan
and a recorded decision.
