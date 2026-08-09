# EXPERIMENTS

- Status: TEMPLATE — optional
- Owner: founder
- Last updated: 2026-08-04

## Purpose

Record controlled experiments only when traffic and decision value justify
assignment overhead. Exploration, interviews, product use and simple before/after
learning remain valid evidence when labeled correctly.

## Standing rules

- Change one conceptual hypothesis per affected journey.
- Declare population, assignment, exposure, primary metric, guardrails, minimum
  observations and stop rules before launch.
- Use `experiment_exposed`, never assignment alone, as the denominator.
- Store the exact offer and price displayed with exposure and conversion.
- State consent population, data gaps and limitations.
- “Inconclusive” is a valid outcome. Do not manufacture a winner.
- A copy or product change without controlled assignment is exploration.

## Register

| Id              | Journey           | Concept        | Status | Primary metric | Decision |
| --------------- | ----------------- | -------------- | ------ | -------------- | -------- |
| exp-000-example | synthetic example | no active test | draft  | —              | —        |

## Results log

For each decided experiment, record dated exposures by variant, the primary and
guardrail results, excluded observations, limitations, decision and evidence
references. Archive; do not delete.

## Evidence

None — the template contains no live experiment exposure or result.

## Assumptions

No experiment is required merely because a venture has pricing.

## Unresolved questions

Whether the first child venture has sufficient traffic for a controlled test.

## Related documents

- [../../config/experiments.yaml](../../config/experiments.yaml)
- [VALIDATION.md](VALIDATION.md)
- [../engineering/ANALYTICS.md](../engineering/ANALYTICS.md)
