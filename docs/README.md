# Documentation

The repository has a compact operational core. A child venture fills in only
the documents its launch mode and capabilities need.

## Start here

1. [PROJECT.md](../PROJECT.md) — current repository state
2. [PRODUCT_TRUTH.md](product/PRODUCT_TRUTH.md) — allowed capability claims
3. [ARCHITECTURE.md](../ARCHITECTURE.md) — runtime and trust boundaries
4. [FEATURE_STATUS.md](product/FEATURE_STATUS.md) — local, fixture, and live-pending evidence
5. [FIRST_LAUNCH.md](operations/FIRST_LAUNCH.md) — founder workflow
6. [OPERATING_CADENCE.md](operations/OPERATING_CADENCE.md) — data and learning

## Venture core

| Need                            | Source                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Venture and capability contract | [config/venture.yaml](../config/venture.yaml)                                                                          |
| Launch decision and assumptions | [config/launch.yaml](../config/launch.yaml)                                                                            |
| Truthful public capabilities    | [product/PRODUCT_TRUTH.md](product/PRODUCT_TRUTH.md)                                                                   |
| Framework feature status        | [product/FEATURE_STATUS.md](product/FEATURE_STATUS.md), [product/ROADMAP.md](product/ROADMAP.md)                       |
| Architecture and decisions      | [ARCHITECTURE.md](../ARCHITECTURE.md), [decisions/](decisions/index.md)                                                |
| Measurement and privacy         | [engineering/ANALYTICS.md](engineering/ANALYTICS.md), [legal/ANALYTICS_AND_CONSENT.md](legal/ANALYTICS_AND_CONSENT.md) |
| Deployment and recovery         | [engineering/DEPLOYMENT.md](engineering/DEPLOYMENT.md), [operations/ROLLBACK.md](operations/ROLLBACK.md)               |
| Active work                     | [plans/active/](plans/active/)                                                                                         |

Commercial, product, brand and growth documents remain available under their
named folders. They are completed when relevant; they are not universal gates
for reversible local work.

## Engineering and authoring

| Need                                          | Guide                                                   |
| --------------------------------------------- | ------------------------------------------------------- |
| One command across direct/REST/CLI/MCP/SDK/UI | [Agent Surfaces](engineering/AGENT_SURFACES.md)         |
| Provider capability and lifecycle             | [Provider authoring](engineering/PROVIDER_AUTHORING.md) |
| Optional capability bundle                    | [Pack authoring](engineering/PACK_AUTHORING.md)         |
| Independent venture starting point            | [Seed authoring](engineering/SEED_AUTHORING.md)         |
| Recursive customer outcome contract           | [Service Blueprints](engineering/SERVICE_BLUEPRINTS.md) |
| Creative-to-economics evidence loop           | [Winner Loop](engineering/WINNER_LOOP.md)               |

The workspace architecture and its compatibility layers are mapped in
[ARCHITECTURE.md](../ARCHITECTURE.md). Authoring guides describe locally or
fixture-verified boundaries; they do not upgrade a provider claim to live.

## Operations

The [operations index](operations/README.md) covers first launch, provider
authentication, MijnDomein DNS, Vercel, Neon, Stripe, RevenueCat, Brevo,
Google, Bing, iOS/TestFlight, troubleshooting, credential rotation, rollback,
child and Fleet upgrades, offboarding, launch reports and the learning cadence.

## Agent support

Agent-neutral rules live in [AGENTS.md](../AGENTS.md). Canonical procedures live
in `skills/`; [agents/SKILLS.md](agents/SKILLS.md) is the routing index.
