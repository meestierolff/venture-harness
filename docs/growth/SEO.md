# SEO

- Status: TEMPLATE
- Owner: unassigned
- Last updated: 2026-08-04

## Purpose

Route-level search strategy: which page owns which query, with what intent,
metadata, answer block and conversion goal. Maintained by `$seo-aeo-engine`
from provenance-aware GSC and Bing datasets produced by `vh data sync`; manual
exports are an explicit fallback, not the default source.

## Page register

<!-- One row per indexable route. "Answer block" = the plain-HTML direct
     answer in the first viewport. -->

| Page | Primary query | Secondary queries | Intent        | Title                             | H1                                                                             | Answer block                                        | Internal links                      | Structured data    | Conversion goal             | Current performance | Status    | Evidence source               |
| ---- | ------------- | ----------------- | ------------- | --------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------- | ----------------------------------- | ------------------ | --------------------------- | ------------------- | --------- | ----------------------------- |
| /    | —             | —                 | informational | Launch operating-system prototype | One brief becomes a launch plan you can inspect, authorize, pause, and resume. | Local prototype scope and provider-state limitation | Status and repository documentation | SoftwareSourceCode | inspect the local prototype | —                   | prototype | docs/product/PRODUCT_TRUTH.md |

## Query opportunities

<!-- From direct-data analysis: impressions without a dedicated page, positions
     6–20, low CTR at useful positions, emerging commercial queries,
     missing comparison pages, cannibalisation. -->

## Answer-engine readiness

Plain-HTML product facts and decisive limitations on each intended public owner
· page-appropriate structured data that matches visible facts · author and
repository transparency · `llms.txt` optional, treated as supporting
documentation only. This prototype has no price-bearing public owner.

## Evidence

The route and schema are locally inspectable prototype surfaces. Query demand,
traffic, indexation and conversion evidence are unavailable.

## Assumptions

None recorded.

## Unresolved questions

None recorded.

## Related documents

- [CONTENT.md](CONTENT.md)
- [../../config/content.yaml](../../config/content.yaml)
- [../engineering/FRONTEND.md](../engineering/FRONTEND.md)
