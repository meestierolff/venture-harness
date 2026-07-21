# Venture Harness

## Mission

Build and validate one venture.
Prove demand before expanding product scope.
Turn corrections and market outcomes into durable repository knowledge.

The validation website is the first product. It is a measured commercial
experiment, not a decorative pre-launch page. Blank canvas visually — not
blank infrastructure.

## Read first

1. [PROJECT.md](PROJECT.md) — current venture state
2. [docs/business/OFFER.md](docs/business/OFFER.md)
3. [docs/product/VALIDATION.md](docs/product/VALIDATION.md)
4. [docs/product/EXPERIMENTS.md](docs/product/EXPERIMENTS.md)
5. [docs/product/PRODUCT_TRUTH.md](docs/product/PRODUCT_TRUTH.md)
6. [docs/brand/DESIGN.md](docs/brand/DESIGN.md)
7. [docs/engineering/ANALYTICS.md](docs/engineering/ANALYTICS.md)
8. [ARCHITECTURE.md](ARCHITECTURE.md)
9. The active plan under [docs/plans/active/](docs/plans/active/)

Read additional documents only when the task needs them.
Config files under [config/](config/) hold reviewable hypotheses, not code.

## Skill routing

Canonical skills live in `skills/<name>/SKILL.md`. Invoke by need:

| Skill                        | Use when                                                  |
| ---------------------------- | --------------------------------------------------------- |
| $venture-bootstrap           | Turning briefs in `inputs/` into a coherent venture       |
| $offer-architect             | Defining or stress-testing ICP, offer, pricing, economics |
| $validation-engine           | Designing demand hypotheses, tests, and decision rules    |
| $experiment-analytics-engine | Tracking, consent, assignment, attribution, analysis      |
| $design-director             | Creating or reviewing the venture's visual identity       |
| $seo-aeo-engine              | Search and answer-engine visibility, crawlability         |
| $distribution-engine         | Channels, outreach, community, content distribution       |
| $harness-engineering         | Improving this repository for the next agent run          |
| $workflow-graph-engineering  | Explicit multi-step agent workflow graphs                 |
| $knowledge-graph-engineering | Explicit entity/claim/evidence graphs                     |
| $product-truth               | Auditing public claims against verified capability        |
| $quality-gate                | Pre-completion verification of any change                 |
| $weekly-learning             | Weekly demand, funnel, and SEO review                     |

## Hard rules

- No fabricated product capabilities, customers, testimonials, results,
  integrations, certifications, benchmarks, demand signals, or analytics data.
- Label sample data, illustrative interfaces, prototypes, concierge services,
  planned functionality, and synthetic examples.
- Do not build features merely because they are easy.
- Keep personal data out of analytics. No form values, search text, email
  addresses, names, or free-form messages in third-party analytics.
- Never copy production secrets between ventures.
- Never send, publish, charge, deploy, or merge without human approval.
- Change one experimental concept at a time.
- Use code for deterministic work; use agents for judgement.
- Preserve the venture's distinct visual identity. Never copy a reference
  site pixel for pixel.
- Update docs when behaviour changes.
- Track material behavioural and commercial signals — not everything
  collectable. Do not collect raw private form or search content.
- Do not report an experiment result without exposure data and limitations.

## Writing rules

Short words when they preserve precision. Active voice. No stale metaphors,
no filler, no generic achievement language, no "Successfully implemented",
no emoji status wall.

## Definition of done

- Implementation matches the active plan.
- Claims match [docs/product/PRODUCT_TRUTH.md](docs/product/PRODUCT_TRUTH.md).
- Analytics are present where relevant; consent behaviour matches docs.
- Experiment variants are recorded correctly.
- Desktop and mobile flows were tested.
- Docs match behaviour; remaining limitations are stated.
- `pnpm verify` passes.

## Progress reports

Start every report with three plain sentences:

1. What changed.
2. What failed or remains unknown.
3. What should happen next.
