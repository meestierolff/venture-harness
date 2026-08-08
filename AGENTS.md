# Venture Harness

## Mission

Turn one founder brief into the smallest trustworthy web, iOS, or hybrid
product that can produce useful evidence. Use progressive commitment: unresolved
non-critical detail becomes an assumption, not a universal build block.

## Read first

1. [PROJECT.md](PROJECT.md)
2. [docs/product/PRODUCT_TRUTH.md](docs/product/PRODUCT_TRUTH.md)
3. [config/venture.yaml](config/venture.yaml), [config/launch.yaml](config/launch.yaml), and [config/policies.yaml](config/policies.yaml)
4. [ARCHITECTURE.md](ARCHITECTURE.md)
5. The active plan under [docs/plans/active/](docs/plans/active/)

Read offer, validation, experiment, brand, analytics, provider, mobile, or
operations docs only when the task needs them. Config holds reviewable
hypotheses and policy; code remains the executable contract.

## Skill routing

Canonical skills live in `skills/<name>/SKILL.md`.

| Skill                          | Use when                                                            |
| ------------------------------ | ------------------------------------------------------------------- |
| `$launch-orchestrator`         | Routing a brief and coordinating a launch or resume.                |
| `$venture-bootstrap`           | Turning founder inputs into the progressive venture core.           |
| `$provider-operations`         | Provider auth, plans, apply, verification, DNS or manual actions.   |
| `$mobile-launch`               | Expo, SwiftUI, RevenueCat, App Store Connect or TestFlight work.    |
| `$offer-architect`             | ICP, offer, pricing or unit economics decisions.                    |
| `$validation-engine`           | Demand hypotheses, thresholds, gates and stop rules.                |
| `$experiment-analytics-engine` | Tracking, consent, assignment, attribution and experiment analysis. |
| `$learning-loops`              | Direct-data daily, weekly, biweekly or monthly learning.            |
| `$design-director`             | Original visual identity and responsive design review.              |
| `$seo-aeo-engine`              | Web SEO/AEO/GEO, crawlability, GSC/Bing and ASO discovery work.     |
| `$distribution-engine`         | Human-gated channel and outreach preparation.                       |
| `$workflow-graph-engineering`  | Explicit runtime graphs for large parallel work.                    |
| `$product-truth`               | Claims register and public-surface audit.                           |
| `$quality-gate`                | Capability-aware pre-completion verification.                       |
| `$harness-engineering`         | Repeated friction, drift, weak checks or repository operability.    |
| `$knowledge-graph-engineering` | Only when explicitly invoked for a proven relational product need.  |
| `$weekly-learning`             | Compatibility wrapper for an explicitly requested weekly review.    |

## Hard rules

- Never fabricate capabilities, providers, customers, testimonials, results,
  integrations, demand signals, analytics, verification or live state.
- Label samples, fixtures, prototypes, concierge delivery and planned work.
- Store only `cred://...` references in the repository. Never log, commit, copy
  between ventures, or place credential values in durable workflow state.
- Keep private form, search, email, name, message and user-content fields out of
  analytics and normalized learning datasets.
- Record exact displayed prices on price-bearing evidence events.
- External effects require the active run envelope. Never exceed its providers,
  capabilities, environments, expiry, spend, recipients or forbidden actions.
- Deletion, destructive production data changes, nameserver replacement, bulk or
  cold sending, unapproved charges and irreversible publication need a distinct
  checkpoint.
- Provider success requires read-back evidence. A request acceptance is not a
  deployment, indexation, email delivery, payment, TestFlight upload or release.
- Do not block reversible local work for missing non-critical commercial detail.
  Do block deception, unsafe defaults, indispensable missing auth, or effects
  outside authorization.
- Use deterministic code for plumbing and models for judgement. Do not introduce
  a knowledge graph or heavyweight orchestrator without a demonstrated need.
- Preserve venture-specific product code and identity during harness upgrades.
- Never send, publish, deploy, charge, merge, or mutate production unless the
  user has clearly authorized that exact effect.

## Definition of done

- Behavior matches the active plan, typed config and product truth.
- Applicable capability checks pass; skipped live checks name the credential,
  command and evidence still required.
- Workflow resume, idempotency, redaction and migration safety are tested when
  relevant.
- Critical desktop/mobile journeys, accessibility, analytics/consent and raw HTML
  are checked for the active rail.
- Docs match behavior and remaining manual actions are explicit.
- `pnpm verify` has run; use the applicable staged quality profile as well.

## Progress reports

Start every report with three plain sentences:

1. What changed.
2. What failed or remains unknown.
3. What should happen next.
