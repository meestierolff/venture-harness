---
name: knowledge-graph-engineering
description: Build entity/claim/evidence knowledge graphs with provenance, contradiction handling, and grounded retrieval - only when the product has a demonstrated relational need. Use only when explicitly invoked. Never introduce a knowledge graph because it sounds advanced.
---

# knowledge-graph-engineering

## Purpose

When — and only when — the product genuinely needs relational knowledge
(multi-hop questions, provenance-carrying claims across sources), design
and maintain an entity/relationship/claim/evidence graph with honest
confidence and contradiction handling.

## Trigger conditions

- Explicit invocation only, with a written product-specific relational
  need (an ADR or active plan section naming the queries flat storage
  cannot answer).

## When not to use

- Flat storage answers the need (Postgres tables, JSONL) — use that.
- "It would be cool" / architectural ambition — rejected by definition.
- Small lookup tables or tag systems.

## Required inputs

- The ADR/plan stating the relational need and example queries.
- Source data inventory with licences and provenance.

## Documents to read

AGENTS.md, docs/engineering/KNOWLEDGE_GRAPHS.md, the authorising ADR,
docs/engineering/BACKEND.md (storage), ARCHITECTURE.md.

## Files this skill may change

Graph schema/storage code under `lib/` (new module), ingestion scripts
under `scripts/`, tests, docs/engineering/KNOWLEDGE_GRAPHS.md (project
specifics), the authorising plan.

## Files this skill must not change

`config/analytics.yaml`, consent/PII rules, `docs/product/PRODUCT_TRUTH.md`
directly, `memory/*` except via append scripts.

## Execution steps

1. Confirm the relational need: write the 3–5 queries flat storage cannot
   answer well. If they can be answered flat, stop and say so.
2. Define a minimal ontology: entity types, relationship types, claim and
   evidence shapes. Version it; grow it reluctantly.
3. Design normalisation and deduplication (code, deterministic keys where
   possible; model-assisted matching flagged for review).
4. Every claim carries: source evidence, retrieval date, confidence,
   status. Contradictions are recorded, surfaced, never silently
   resolved.
5. Implement incremental updates (no full rebuilds as routine).
6. Implement retrieval paths: local (entity neighbourhood) and global
   (community/theme summaries) as separate code paths.
7. Grounded answers cite the path through the graph (path explanation);
   answers without a path are labeled ungrounded.
8. Human review gates ontology changes and low-confidence merges.

## Hard rules

- No knowledge graph without the written relational need.
- Provenance on every node and edge; no orphan facts.
- Contradictions preserved; confidence honest; no silent merges.
- Personal data rules from the analytics contract apply to graph content.

## Expected output

Justification (or a documented "flat storage suffices" verdict), minimal
ontology, storage + ingestion + retrieval code with tests, grounded-answer
path explanations.

## Validation

Example queries from step 1 answered with path explanations; ingestion
idempotent (re-run produces no duplicates); `pnpm verify` passes.

## Failure behaviour

If sources conflict beyond confidence thresholds, the graph records the
contradiction and the answer surfaces it. If the ontology cannot express
a needed fact, extend it via the versioned process — never shoehorn.

## Human approval boundaries

Ontology changes, low-confidence merges, and any externally visible
graph-derived claims require human review. Public claims still route
through $product-truth.
