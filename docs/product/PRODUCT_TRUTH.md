# PRODUCT_TRUTH

- Status: TEMPLATE
- Owner: unassigned
- Last updated: 2026-07-21

## Purpose

The single register of what is true about this product. Every public claim —
homepage, pricing, feature pages, metadata, structured data, emails,
onboarding, sample interfaces, consent text, analytics claims — must trace
to a row here. Maintained by `$product-truth`; checked by
`pnpm validate:claims` and the product-truth-auditor subagent.

## Statuses

| Status       | Meaning                        | Allowed public wording                    |
| ------------ | ------------------------------ | ----------------------------------------- |
| LIVE         | Works in production, verified  | present tense, plain claims               |
| CONCIERGE    | Delivered manually by humans   | must disclose human delivery              |
| PROTOTYPE    | Works in demo conditions only  | must be labeled prototype/demo            |
| PLANNED      | Not built                      | future tense only, no availability claims |
| UNDER REVIEW | Truth currently being verified | must not appear publicly                  |
| UNVERIFIED   | Asserted, no evidence          | must not appear publicly                  |

## Claims register

<!-- Row format is mandatory. "Evidence" is a link or path, not prose.
     Add rows via $product-truth only. -->

| Id        | Claim                                                                                              | Status | Evidence                                                    | Owner   | Last verified | Allowed wording                 | Forbidden wording                              |
| --------- | -------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------- | ------- | ------------- | ------------------------------- | ---------------------------------------------- |
| truth-000 | (template example) The validation site records the exact price displayed with every plan selection | LIVE   | lib/analytics/taxonomy.ts, tests/analytics-taxonomy.test.ts | harness | 2026-07-21    | "records the exact price shown" | "guarantees revenue", any customer-count claim |

## Surfaces inspected

Homepage · pricing · feature pages · metadata · structured data · emails ·
onboarding · sample interfaces · consent text · analytics claims.

## Evidence

Row truth-000 is verified by this repository's tests; it is the only
non-template row allowed in template state.

## Assumptions

None recorded.

## Unresolved questions

None recorded.

## Related documents

- [PRODUCT.md](PRODUCT.md)
- [../business/COMPETITION.md](../business/COMPETITION.md)
- [../../skills/product-truth/SKILL.md](../../skills/product-truth/SKILL.md)
