# VALIDATION

- Status: TEMPLATE — complete when the selected launch strategy uses a demand test
- Owner: founder
- Last updated: 2026-08-04

## Purpose

Define falsifiable demand or product-usage evidence without making a 30–90-day
validation site compulsory. The launch router records the mode in
[../../config/launch.yaml](../../config/launch.yaml).

## Strategy by launch mode

| Mode              | First evidence                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `validate_first`  | Qualified commercial behavior before meaningful product scope. Optional day 30/60/90 gates fit here. |
| `thin_mvp`        | Usage of the smallest reversible core journey plus a commercial signal.                              |
| `product_first`   | Product outcome completion; demand is interpreted alongside real use.                                |
| `concierge_first` | Honest human delivery, willingness to continue/pay, and evidence about repeatable steps.             |

## Progressive commitment

Before build, record the specific audience, problem/job, intended outcome,
smallest core journey, primary success signal, material constraints, known
truths and assumptions. Missing non-critical commercial detail becomes a
labeled assumption or backlog item. Block only for deception, unintelligible
outcome, unsafe non-defaultable security/legal/payment choices, indispensable
missing auth, or unauthorized irreversible effects.

## Demand hypotheses

| Id  | Hypothesis | Population and window | Signal | Threshold | Stop rule |
| --- | ---------- | --------------------- | ------ | --------- | --------- |
| —   | —          | —                     | —      | —         | —         |

## Optional decision gates

Use these only for `validate_first` when the evidence window justifies them.

| Gate   | Question                                                       | Possible decision                             |
| ------ | -------------------------------------------------------------- | --------------------------------------------- |
| Day 30 | Is qualified traffic or reachable demand present?              | channel iteration, reposition, continue, stop |
| Day 60 | Does qualified intent meet the predeclared threshold?          | build, offer iteration, reposition, stop      |
| Day 90 | Is the evidence strong enough for a final allocation decision? | build, reposition, stop                       |

An experiment is optional. Use one only when traffic, assignment integrity and
decision value justify it. Qualified observations, exposure denominators and
limitations are required before reporting a result.

## Evidence

None — no venture or market evidence is loaded in the template.

## Assumptions

None recorded for a child venture.

## Unresolved questions

The founder must choose thresholds and decision ownership before interpreting
live evidence.

## Related documents

- [EXPERIMENTS.md](EXPERIMENTS.md)
- [PRODUCT_TRUTH.md](PRODUCT_TRUTH.md)
- [../business/OFFER.md](../business/OFFER.md)
- [../../config/venture.yaml](../../config/venture.yaml)
