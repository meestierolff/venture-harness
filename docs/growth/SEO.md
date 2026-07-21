# SEO

- Status: TEMPLATE
- Owner: unassigned
- Last updated: 2026-07-21

## Purpose

Route-level search strategy: which page owns which query, with what intent,
metadata, and conversion goal. Maintained by `$seo-aeo-engine` from weekly
Search Console / Bing exports in `data/seo/inbox/`.

## Page register

<!-- One row per indexable route. "Answer block" = the plain-HTML direct
     answer in the first viewport. -->

| Page     | Primary query | Secondary queries | Intent        | Title | H1  | Answer block | Internal links | Structured data | Conversion goal         | Current performance | Status   | Evidence source |
| -------- | ------------- | ----------------- | ------------- | ----- | --- | ------------ | -------------- | --------------- | ----------------------- | ------------------- | -------- | --------------- |
| /        | —             | —                 | commercial    | —     | —   | —            | —              | Organization    | qualification_completed | —                   | template | —               |
| /pricing | —             | —                 | transactional | —     | —   | —            | —              | Product+Offer   | plan_selected           | —                   | template | —               |

## Query opportunities

<!-- From weekly analysis: impressions without a dedicated page, positions
     6–20, low CTR at useful positions, emerging commercial queries,
     missing comparison pages, cannibalisation. -->

## Answer-engine readiness

Plain-HTML product and price facts on every commercial page · entity
anchoring (consistent organisation name, sameAs links) · organisation and
author transparency · `llms.txt` optional, treated as supporting
documentation only.

## Evidence

None — template state.

## Assumptions

None recorded.

## Unresolved questions

None recorded.

## Related documents

- [CONTENT.md](CONTENT.md)
- [../../config/content.yaml](../../config/content.yaml)
- [../engineering/FRONTEND.md](../engineering/FRONTEND.md)
