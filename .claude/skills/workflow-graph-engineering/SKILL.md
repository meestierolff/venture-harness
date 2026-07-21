---
name: workflow-graph-engineering
description: Design explicit multi-node agent workflow graphs - bounded jobs as nodes, data dependencies as edges, deterministic code for plumbing, model calls for judgement, human approval as explicit nodes. Use only when explicitly invoked for large parallelisable work. Never use implicitly or for small tasks.
---

<!-- GENERATED FILE - do not edit. Canonical source: skills/workflow-graph-engineering/SKILL.md. Regenerate with: pnpm agents:sync -->

# workflow-graph-engineering

## Purpose

Plan and run large agent workloads as explicit graphs: bounded nodes,
real data-dependency edges, deterministic plumbing, isolated failures,
and human approval as first-class nodes.

## Trigger conditions

- Explicit invocation only. Implicit invocation is false.
- The work genuinely decomposes into ≥4 bounded jobs with real data
  dependencies (e.g. multi-page content production with verification, a
  full-site audit with several lenses).

## When not to use

- Small tasks (one or two steps) — just do them.
- Work without real data dependencies — a flat checklist beats a graph.
- As a way to look sophisticated. A graph must earn its overhead.

## Required inputs

- A goal with decomposable structure; assets/graph-plan.yaml (template);
  the active plan authorising the work.

## Documents to read

AGENTS.md, docs/engineering/WORKFLOW_GRAPHS.md, the active plan,
assets/graph-plan.yaml (in this skill).

## Files this skill may change

A new graph plan file under `docs/plans/active/`, node output artifacts
in the locations the plan declares, `reports/**` for run summaries.

## Files this skill must not change

Anything outside the declared node outputs; `memory/*` except via append
scripts; `config/**` unless a node's declared output.

## Execution steps

1. Write the graph plan from assets/graph-plan.yaml: nodes (bounded jobs
   with structured inputs and validated outputs), edges (only where
   downstream consumes upstream data), patterns (fan-out, fan-in,
   barriers, pipelines, routers, verifier nodes), model tier per node,
   expected latency and cost, failure isolation, worktree isolation for
   file-editing nodes, human approval nodes.
2. Review the plan against: every edge justified by consumed data; no
   node both judges and aggregates; verifier nodes use diverse review
   lenses (different prompts, not copies); convergent cycles declare a
   stability condition and deduplicate against all previously seen
   results.
3. Use code (scripts) for flattening, filtering, sorting, deduplication,
   validation, and deterministic routing between nodes. Use models only
   for judgement, synthesis, critique, and writing.
4. Execute with failure isolation: a failed node reports and is retried
   or dropped without corrupting siblings; barriers wait for complete
   inputs.
5. Summarise the run: node outcomes, cost/latency vs estimate, what the
   graph structure got wrong.

## Hard rules

- Explicit invocation only; set implicit invocation false wherever the
  agent platform supports the setting.
- An edge exists only when downstream work consumes upstream data.
- Human approval nodes are never skipped or simulated.
- Model tiering is declared per node (cheap for extraction/format,
  capable for judgement).
- Deduplication is code, compared against all seen results, not model
  memory.

## Expected output

A reviewed graph plan, executed node artifacts in declared locations, a
run summary with costs and deviations.

## Validation

Plan validates against the template's required fields; node outputs pass
their declared validators; `pnpm verify` after any repo-affecting node.

## Failure behaviour

A node that fails validation is retried at most its declared retry count,
then reported as failed with its inputs preserved for inspection. The
graph never silently substitutes fabricated output for a failed node.

## Human approval boundaries

Graph plans that touch public surfaces, config, or memory require plan
approval before execution. Approval nodes inside the graph gate: sending,
publishing, charging, deploying, merging — always.
