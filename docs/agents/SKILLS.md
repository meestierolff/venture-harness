# Skills index

Canonical procedures live in `skills/<name>/SKILL.md`. Generated Codex and
Claude copies are produced by `pnpm agents:sync` and checked by
`pnpm agents:check`; never edit generated copies directly.

| Skill                                                                            | Responsibility                                             | Trigger                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| [launch-orchestrator](../../skills/launch-orchestrator/SKILL.md)                 | Route a brief and coordinate plan/apply/resume/report      | new launch or interrupted launch            |
| [venture-bootstrap](../../skills/venture-bootstrap/SKILL.md)                     | Turn inputs into the progressive venture core              | new child venture or empty core docs        |
| [provider-operations](../../skills/provider-operations/SKILL.md)                 | Auth, doctor, provider plans, read-back and manual actions | provider or DNS work                        |
| [mobile-launch](../../skills/mobile-launch/SKILL.md)                             | Expo/SwiftUI, Apple, EAS, RevenueCat and TestFlight        | mobile or hybrid rail                       |
| [offer-architect](../../skills/offer-architect/SKILL.md)                         | ICP, offer, pricing and thirty-day economics               | commercial decision needed                  |
| [validation-engine](../../skills/validation-engine/SKILL.md)                     | Demand hypotheses, tests, thresholds and stop rules        | validation strategy or gate                 |
| [experiment-analytics-engine](../../skills/experiment-analytics-engine/SKILL.md) | Event packs, consent, assignment, attribution and analysis | measurement or experiment implementation    |
| [learning-loops](../../skills/learning-loops/SKILL.md)                           | Direct-data daily/weekly/biweekly/monthly decisions        | learning cadence                            |
| [design-director](../../skills/design-director/SKILL.md)                         | Original identity and responsive system                    | design creation or audit                    |
| [seo-aeo-engine](../../skills/seo-aeo-engine/SKILL.md)                           | Web SEO/AEO/GEO, search providers and ASO discovery        | discovery/crawl/index/store work            |
| [distribution-engine](../../skills/distribution-engine/SKILL.md)                 | Human-gated channel/outreach preparation                   | distribution planning                       |
| [workflow-graph-engineering](../../skills/workflow-graph-engineering/SKILL.md)   | Explicit runtime graph design                              | large parallel workflow, explicitly invoked |
| [knowledge-graph-engineering](../../skills/knowledge-graph-engineering/SKILL.md) | Relational claim/entity/evidence systems                   | explicitly invoked after demonstrated need  |
| [product-truth](../../skills/product-truth/SKILL.md)                             | Claims register and surface audit                          | claim change or pre-publication             |
| [quality-gate](../../skills/quality-gate/SKILL.md)                               | Capability-aware completion evidence                       | before reporting completion                 |
| [harness-engineering](../../skills/harness-engineering/SKILL.md)                 | Promote repeated friction into durable checks/docs         | recurring corrections or drift              |
| [weekly-learning](../../skills/weekly-learning/SKILL.md)                         | Compatibility wrapper to the weekly loop                   | explicitly requested weekly review          |

Every skill declares inputs, file boundaries, validation, failure behavior and
human approval boundaries. Tool permission never expands a run authorization
envelope.
