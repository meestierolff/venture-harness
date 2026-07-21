# ECONOMICS

- Status: TEMPLATE
- Owner: unassigned
- Last updated: 2026-07-21

## Purpose

The unit-economic model: can this venture recover acquisition cost within
thirty days, and what has to be true for the margin to hold? All arithmetic
comes from the deterministic calculator
(`skills/offer-architect/scripts/thirty-day-cash.ts`), never from model
calls. Assumptions live in `config/offer.yaml` (economics block).

## Model

| Input                            | Value | Source              |
| -------------------------------- | ----- | ------------------- |
| Cash collected in first 30 days  | —     | pricing + setup fee |
| Blended CAC assumption           | —     | channel plan        |
| Delivery cost / customer / month | —     | —                   |
| Onboarding cost / customer       | —     | —                   |
| Contribution margin              | —     | calculator output   |
| Payback period                   | —     | calculator output   |

## Calculator output

<!-- Paste the verbatim output of:
     pnpm tsx skills/offer-architect/scripts/thirty-day-cash.ts
     including the assumptions block it prints. -->

## Sensitivity

<!-- Which single assumption breaks the model first? At what value? -->

## Unpriced service work

<!-- List any concierge/done-for-you labour not yet priced. Unpriced service
     work is a bootstrap blocker (see $venture-bootstrap). -->

## Evidence

None — template state.

## Assumptions

None recorded.

## Unresolved questions

None recorded.

## Related documents

- [OFFER.md](OFFER.md)
- [PRICING.md](PRICING.md)
- [../../config/offer.yaml](../../config/offer.yaml)
