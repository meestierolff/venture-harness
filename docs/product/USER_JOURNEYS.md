# USER_JOURNEYS

- Status: TEMPLATE
- Owner: unassigned
- Last updated: 2026-07-21

## Purpose

The material paths a visitor can take through the validation site, each
mapped to the events that measure it. If a journey has no events, it cannot
be evaluated; if an event maps to no journey, it is probably noise.

## Journey map

| Journey              | Steps                              | Events (config/analytics.yaml)                         | Commercial signal |
| -------------------- | ---------------------------------- | ------------------------------------------------------ | ----------------- |
| Evaluate proposition | land → hero → how-it-works → proof | landing_page_view, section_view, proof_view            | weak              |
| Evaluate price       | land → pricing → details → plan    | pricing_page_view, pricing_details_open, plan_selected | strong            |
| Apply / qualify      | plan → form → submit → qualified   | form_started, form_submitted, qualification_completed  | strongest         |
| Deliberate           | return visit → repeat pricing      | return_visit, repeat_pricing_view                      | strong            |

## Friction notes

<!-- Observed drop-off points and hypotheses, updated from weekly reports. -->

## Evidence

None — template state.

## Assumptions

None recorded.

## Unresolved questions

None recorded.

## Related documents

- [VALIDATION.md](VALIDATION.md)
- [../engineering/ANALYTICS.md](../engineering/ANALYTICS.md)
