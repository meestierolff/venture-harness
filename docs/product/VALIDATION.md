# VALIDATION

- Status: TEMPLATE
- Owner: unassigned
- Last updated: 2026-07-21

## Purpose

The 30-to-90-day demand-validation plan: what must be proven, by which
behaviour, at which thresholds, and what happens at each gate. Maintained by
`$validation-engine`. Thresholds mirror `config/venture.yaml` (validation
block) and are set before launch.

## Demand hypotheses

| #   | Hypothesis | Falsifiable by | Threshold |
| --- | ---------- | -------------- | --------- |
| H1  | —          | —              | —         |

## Test setup

| Element            | Value                                |
| ------------------ | ------------------------------------ |
| Audience           | —                                    |
| Offer shown        | —                                    |
| Traffic sources    | —                                    |
| Conversion events  | — (names from config/analytics.yaml) |
| Primary conversion | —                                    |
| Qualification rule | — (enforced server-side)             |

## Qualified behaviour, not vanity

Commercial validation relies on qualified behaviour: high-intent actions,
conversations, accepted pilots, reservations, and purchases where
deliverable — not page views or email signups alone.

## Success / failure definitions

| Outcome       | Definition                                             |
| ------------- | ------------------------------------------------------ |
| Success       | —                                                      |
| Failure       | —                                                      |
| Sample limits | — (minimum qualified observations before any decision) |

## Decision gates

| Gate   | Day | Question                                             | Possible outcomes                             |
| ------ | --- | ---------------------------------------------------- | --------------------------------------------- |
| Gate 1 | 30  | Is qualified traffic arriving at all?                | iterate channels / reposition / continue      |
| Gate 2 | 60  | Is qualified intent converting at threshold?         | build / iterate offer / reposition / continue |
| Gate 3 | 90  | Final call — no extensions without a decision record | build / reposition / stop                     |

## Decision rules

<!-- Written before launch. Include: who decides, what evidence is required
     in the room, and the rule that weak evidence defaults to "do nothing
     further", not to "build". -->

## Stop rules

<!-- Explicit kill criteria. Mirrors config/venture.yaml stop_threshold. -->

## Product-truth disclosures

<!-- What the validation site must disclose (prototype status, concierge
     delivery, sample data labels). Links to PRODUCT_TRUTH.md ids. -->

## Evidence

None — template state.

## Assumptions

None recorded.

## Unresolved questions

None recorded.

## Related documents

- [EXPERIMENTS.md](EXPERIMENTS.md)
- [PRODUCT_TRUTH.md](PRODUCT_TRUTH.md)
- [../business/OFFER.md](../business/OFFER.md)
- [../../config/venture.yaml](../../config/venture.yaml)
