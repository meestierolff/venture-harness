# Skills index

Canonical skills live in `skills/<name>/SKILL.md`. Generated copies:
`.agents/skills/` (Codex) and `.claude/skills/` (Claude Code), produced by
`pnpm agents:sync` and verified by `pnpm agents:check`.

| Skill                                                                            | Description                                                                   | Invocation trigger                      |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------- |
| [venture-bootstrap](../../skills/venture-bootstrap/SKILL.md)                     | Turn briefs into a coherent venture repository and measurable validation plan | new venture, empty project docs         |
| [offer-architect](../../skills/offer-architect/SKILL.md)                         | Define and stress-test ICP, offer, pricing, and thirty-day economics          | offer work, pricing changes             |
| [validation-engine](../../skills/validation-engine/SKILL.md)                     | Design demand hypotheses, tests, thresholds, and decision rules               | validation planning, gate reviews       |
| [experiment-analytics-engine](../../skills/experiment-analytics-engine/SKILL.md) | Implement and verify tracking, consent, assignment, attribution, analysis     | analytics or experiment implementation  |
| [design-director](../../skills/design-director/SKILL.md)                         | Run the original-design process from brief to audited system                  | new design, redesign, design review     |
| [seo-aeo-engine](../../skills/seo-aeo-engine/SKILL.md)                           | Search and answer-engine visibility, crawlability, weekly SEO analysis        | SEO work, GSC/Bing data arrival         |
| [distribution-engine](../../skills/distribution-engine/SKILL.md)                 | Customer habitat mapping, channel strategy, human-gated outreach prep         | distribution planning                   |
| [harness-engineering](../../skills/harness-engineering/SKILL.md)                 | Make the repository easier for the next agent run                             | repeated corrections, drift, friction   |
| [workflow-graph-engineering](../../skills/workflow-graph-engineering/SKILL.md)   | Explicit multi-node agent workflow graphs                                     | explicitly invoked, large parallel work |
| [knowledge-graph-engineering](../../skills/knowledge-graph-engineering/SKILL.md) | Entity/claim/evidence graphs for genuine relational needs                     | explicitly invoked, proven need         |
| [product-truth](../../skills/product-truth/SKILL.md)                             | Maintain the claims register; audit public surfaces                           | claim changes, pre-launch, pre-publish  |
| [quality-gate](../../skills/quality-gate/SKILL.md)                               | Pre-completion verification of any change                                     | before reporting any task done          |
| [weekly-learning](../../skills/weekly-learning/SKILL.md)                         | Weekly demand/funnel/SEO review; one proposed change                          | explicitly invoked, weekly cadence      |

Skill format: see [../../skills/venture-bootstrap/SKILL.md](../../skills/venture-bootstrap/SKILL.md)
as the reference example — frontmatter (name, description), purpose,
triggers, non-triggers, inputs, documents to read, file boundaries,
execution steps, hard rules, expected output, validation, failure
behaviour, and human approval boundaries.
