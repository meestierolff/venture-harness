# EXPERIMENTS

- Status: TEMPLATE
- Owner: unassigned
- Last updated: 2026-07-21

## Purpose

The experiment program: what is being tested, how variants are assigned and
exposed, which metrics decide, and what every result's limitations were.
Definitions live in `config/experiments.yaml` (machine-checked); this
document holds interpretation and history. The `$validation-engine` decides
_what_ to test; the `$experiment-analytics-engine` decides _how_ it is
assigned, tracked, stored, and analysed.

## Standing rules

- One core concept per experiment.
- Assignment: deterministic hash, first-party cookie, recorded in Neon.
- Analysis denominators use `experiment_exposed`, never assignment alone.
- Displayed offer and price are stored verbatim with each exposure.
- Stopping rules and minimum observations are declared before start.
- No winner is declared from weak evidence; "inconclusive" is a result.
- Exploration (unassigned copy changes) is recorded as exploration, never
  reported as a controlled test.

## Register

| Id                             | Type    | Concept             | Status | Primary metric          | Decision |
| ------------------------------ | ------- | ------------------- | ------ | ----------------------- | -------- |
| exp-000-example-pricing-anchor | pricing | (synthetic example) | draft  | qualification_completed | —        |

## Test-type notes

| Type                 | What it varies         | What must stay fixed                             |
| -------------------- | ---------------------- | ------------------------------------------------ |
| ICP test             | who the page addresses | offer, price, layout                             |
| Headline / hero test | the promise framing    | audience, price                                  |
| Proof test           | which proof is shown   | promise, price                                   |
| CTA test             | action framing         | promise, proof                                   |
| Pricing test         | price/structure shown  | promise, audience                                |
| Fake-door test       | existence of an option | everything else; disclosure required after click |

## Consent limitations

GA4-side funnel views cover consented visitors only; Neon-side exposure and
conversion records are consent-independent (anonymous visitor id, no
personal data). Every analysis states which population it used.

## Results log

<!-- One dated entry per decided experiment: exposures per variant, primary
     metric per variant, guardrails, limitations, decision. Archived
     experiments move to the bottom, never deleted. -->

## Evidence

None — template state.

## Assumptions

None recorded.

## Unresolved questions

None recorded.

## Related documents

- [../../config/experiments.yaml](../../config/experiments.yaml)
- [VALIDATION.md](VALIDATION.md)
- [../engineering/ANALYTICS.md](../engineering/ANALYTICS.md)
