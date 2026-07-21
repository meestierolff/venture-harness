# ANALYTICS

- Status: TEMPLATE
- Owner: unassigned
- Last updated: 2026-07-21

## Purpose

The venture's measurement contract. The machine-readable version is
[../../config/analytics.yaml](../../config/analytics.yaml); the typed
implementation is [../../lib/analytics/taxonomy.ts](../../lib/analytics/taxonomy.ts).
`pnpm verify:analytics-events` fails if they drift.

## Providers

| Layer | Provider                                   | Purpose                                                                                          | Consent                                                    |
| ----- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 1     | Vercel Web Analytics (per-venture project) | traffic, routes, referrers, devices, trends                                                      | opt-in (configurable)                                      |
| 2     | Google Analytics 4 (per-venture property)  | acquisition, campaigns, consented funnels, cohorts, return behaviour                             | strict opt-in                                              |
| 3     | Neon Postgres (per-venture database)       | assignments, exposures, exact offers/prices, qualified submissions, server-confirmed conversions | not required (no personal data except submissions.payload) |

Vercel and GA4 are supporting tools. **Neon is the source of truth for
material commercial evidence.**

## Event taxonomy

Defined event-by-event in `config/analytics.yaml` with purpose, trigger,
destinations, allowed properties, consent requirement, Neon persistence,
and experiment relevance. Validation test:
[../../tests/analytics-taxonomy.test.ts](../../tests/analytics-taxonomy.test.ts).

## Consent requirements

Strict mode by default: no third-party script loads and no third-party
event fires before opt-in. Withdrawal is honoured immediately. Consent
events themselves go only to first-party storage. Full inventory:
[../legal/ANALYTICS_AND_CONSENT.md](../legal/ANALYTICS_AND_CONSENT.md).

## Attribution

First-touch and last-touch both stored (UTM parameters + referrer domain
only), attached to qualified submissions and conversions in Neon. No
full-referrer URLs, no click-id enrichment services.

## Prohibited data

Everywhere, all providers: keystrokes, mouse movement, cursor paths,
session replay, clipboard, passwords, form contents, raw search text,
free-form messages, email addresses, names, customer ideas, sensitive URL
parameters, auth tokens, payment details, private user content.
Enforced by `pnpm verify:analytics-pii`.

## Retention

| Store                | Default retention                                     |
| -------------------- | ----------------------------------------------------- |
| Vercel Web Analytics | provider default, aggregate only                      |
| GA4                  | 14 months, advertising features off                   |
| Neon evidence tables | life of the venture; submissions deletable on request |

## Environment behaviour

| Environment | Behaviour                                                                    |
| ----------- | ---------------------------------------------------------------------------- |
| development | providers disabled; events logged to console; Neon optional (JSONL fallback) |
| preview     | providers disabled; Neon preview branch allowed                              |
| production  | providers per consent; Neon required                                         |

## Verification

`pnpm verify:consent`, `pnpm verify:analytics-events`,
`pnpm verify:analytics-pii`, `pnpm verify:experiment-assignment`,
`pnpm verify:pricing-recording`, plus `tests/`.

## Evidence

Template state — contract only, no measured data.

## Assumptions

None recorded.

## Unresolved questions

None recorded.

## Related documents

- [../../config/analytics.yaml](../../config/analytics.yaml)
- [BACKEND.md](BACKEND.md)
- [../legal/ANALYTICS_AND_CONSENT.md](../legal/ANALYTICS_AND_CONSENT.md)
