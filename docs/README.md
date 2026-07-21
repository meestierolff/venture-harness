# docs/

Source-of-truth documents for the venture and the framework.

## Rule of placement

- **Project state** (what this venture is, believes, and has measured) lives
  here and in `config/`. It never lives inside skills.
- **Procedures** (how to do recurring work) live in `skills/`.
- **Deterministic checks** live in `scripts/`.

## Map

| Directory                    | Holds                                                          | Written by                                             |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| [business/](business/)       | offer, ICP, pricing, economics, competition                    | $offer-architect                                       |
| [product/](product/)         | product truth, validation plan, experiments, journeys, roadmap | $venture-bootstrap, $validation-engine, $product-truth |
| [brand/](brand/)             | brand, design system, copy, references                         | $design-director                                       |
| [growth/](growth/)           | SEO, distribution, content, outreach, channels                 | $seo-aeo-engine, $distribution-engine                  |
| [engineering/](engineering/) | architecture practice, analytics, security, deployment         | $harness-engineering                                   |
| [agents/](agents/)           | per-agent adapter guides, skills index, compatibility          | harness maintainers                                    |
| [decisions/](decisions/)     | architecture decision records                                  | anyone, via ADR template                               |
| [plans/](plans/)             | active and completed execution plans, tech debt                | any skill; one active focus                            |
| [public/](public/)           | release checklist, launch notes, template maintenance          | harness maintainers                                    |
| [legal/](legal/)             | license notes, analytics/consent inventory                     | harness maintainers + counsel                          |

## Document contract

Every project document (business, product, brand, growth) carries:
Status / Owner / Last updated metadata and Purpose, Evidence, Assumptions,
Unresolved questions, Related documents sections.
`pnpm validate:docs` enforces this.

Template state: files below contain structure and instructions, never
invented venture facts.
