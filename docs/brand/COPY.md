# COPY

- Status: TEMPLATE
- Owner: unassigned
- Last updated: 2026-07-21

## Purpose

Canonical public copy: hero, section headers, pricing copy, CTAs, FAQ
answers, consent text. Pages render what is recorded here (or an assigned
experiment variant of it). Copy uses customer language from
`memory/customer-language.jsonl` and respects `config/content.yaml`.

## Copy blocks

| Block id         | Surface | Text                                                                                                                                                                                                                                                                                       | PRODUCT_TRUTH ids referenced |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| hero.headline    | /       | A launch path you can inspect before it touches the world.                                                                                                                                                                                                                                 | —                            |
| hero.subheadline | /       | Venture Harness includes a locally and fixture-tested standalone app seed with optional advanced packs excluded by default. Its locally tested Launch Contract keeps the user, outcome, journey, capability map, truth boundaries, and not-building list in one reviewable object.         | truth-033, truth-029         |
| hero.cta_primary | /       | Open the five-minute quickstart                                                                                                                                                                                                                                                            | —                            |
| consent.banner   | all     | In this locally tested prototype, optional Google Analytics stays off until you allow it; declining leaves the core site available, and Analytics settings lets this browser change or withdraw its choice. The prototype may record that consent choice first-party without form content. | truth-041                    |

## Experiment variants

<!-- Variant copy lives with its experiment in config/experiments.yaml;
     this table indexes it. -->

## Evidence

None — template state.

## Assumptions

None recorded.

## Unresolved questions

None recorded.

## Related documents

- [BRAND.md](BRAND.md)
- [../product/PRODUCT_TRUTH.md](../product/PRODUCT_TRUTH.md)
- [../../config/content.yaml](../../config/content.yaml)
