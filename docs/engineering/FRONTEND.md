# FRONTEND

The web foundation: visually neutral and locally tested. A child venture is not
production-ready until its active capabilities and critical journeys pass the
applicable quality profile and provider read-back.

## Stack

Next.js App Router, TypeScript strict, React server components by default.
Client components only where interaction demands it (consent banner, forms,
experiment-rendered variants, trackers).

## Structure

| Path                        | Role                                                                        |
| --------------------------- | --------------------------------------------------------------------------- |
| `app/layout.tsx`            | metadata defaults, consent + analytics providers                            |
| `app/page.tsx`              | placeholder public home; replace or remove when the rail has no public site |
| `app/api/lead/route.ts`     | qualified-lead intake (Layer 3)                                             |
| `app/api/evidence/route.ts` | assignment/exposure/intent persistence (Layer 3)                            |
| `components/`               | consent banner, lead form, optional pricing table, trackers, truth wrapper  |
| `lib/analytics/`            | typed taxonomy + track() — the only path to GA/Vercel                       |
| `lib/experiments.ts`        | deterministic assignment                                                    |
| `lib/consent.ts`            | consent state machine                                                       |

## Rules

- Server-render everything a crawler needs: title, canonical, H1, core
  content, price text, product facts, internal links, structured data.
  `pnpm verify:raw-html` checks the raw response with browser, Googlebot-like
  and bingbot-like user agents.
- No direct `gtag`/analytics calls in components — only
  `lib/analytics/track.ts` (lint-enforced).
- Every public capability statement is wrapped in `<TruthClaim id>` linking
  it to `docs/product/PRODUCT_TRUTH.md` (checked by `pnpm validate:claims`).
- Sample data and illustrative interfaces carry a visible label component.
- Public web is optional. When active, mobile web is re-composed rather than
  stacked and desktop/mobile critical paths are both tested.
- PricingTable and its exact-price evidence contract are reusable only when a
  Launch Contract selects commerce; the neutral root application does not mount
  a pricing surface.
- The template's visual style is deliberately neutral. `$design-director`
  replaces it per venture; the operational components stay.

## Related

- [ANALYTICS.md](ANALYTICS.md)
- [../brand/DESIGN.md](../brand/DESIGN.md)
