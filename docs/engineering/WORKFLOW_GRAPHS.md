# WORKFLOW_GRAPHS

Explicit multi-step agent workflows, modeled as graphs. Invoked only via
`$workflow-graph-engineering` — never implicitly, and never for small tasks.

## Model

- **Node** — one bounded job with structured inputs and validated outputs.
- **Edge** — a data dependency. An edge exists only when downstream work
  consumes upstream data. No decorative edges.
- **Patterns** — fan-out (parallel independent nodes), fan-in (aggregation
  node), barrier (all inputs present before start), pipeline (linear),
  router (deterministic dispatch by code), verifier (adversarial check
  node), convergent cycle (repeat until validated output stabilizes, with
  deduplication against all previously seen results).

## Division of labour

| Work                                                               | Who               |
| ------------------------------------------------------------------ | ----------------- |
| Flattening, filtering, sorting, deduplication, validation, routing | code (`scripts/`) |
| Judgement, synthesis, critique, writing                            | model nodes       |

Model tiering: cheap models for extraction and formatting nodes, capable
models for judgement nodes. Record expected latency and cost per node in
the plan.

## Safety

- Failure isolation: one node failing must not corrupt sibling outputs.
- Worktree isolation for nodes that edit files.
- Diverse review lenses on verifier fan-ins (different prompts, not copies).
- Human approval nodes are explicit graph nodes, never skipped.

## Plan template

Use [../../skills/workflow-graph-engineering/assets/graph-plan.yaml](../../skills/workflow-graph-engineering/assets/graph-plan.yaml).
A graph plan is reviewed before execution like any other plan.

## Related

- [../../skills/workflow-graph-engineering/SKILL.md](../../skills/workflow-graph-engineering/SKILL.md)
