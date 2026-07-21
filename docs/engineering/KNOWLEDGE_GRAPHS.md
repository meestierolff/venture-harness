# KNOWLEDGE_GRAPHS

Entity/claim/evidence graphs for products with a genuine relational need.
Invoked only via `$knowledge-graph-engineering` — explicitly, and only when
the product need is demonstrated. A knowledge graph is never introduced
because it sounds advanced.

## When it is justified

- The product answers questions that traverse relationships ("which X
  connect to Y through Z"), or
- Claims must carry provenance and confidence across many sources.

If flat storage (Postgres tables, JSONL) answers the need, use that.

## Model

| Concept       | Rule                                            |
| ------------- | ----------------------------------------------- |
| Entity        | normalised, deduplicated, one canonical id      |
| Relationship  | typed, directional, dated                       |
| Claim         | statement + confidence + status                 |
| Evidence      | source + retrieval date, linked to claims       |
| Provenance    | every node/edge traces to evidence              |
| Contradiction | recorded, never silently resolved               |
| Ontology      | small, documented, versioned; grown reluctantly |

## Operations

- Incremental updates over rebuilds.
- Local retrieval (neighbourhood of an entity) and global retrieval
  (community/theme summaries) are separate code paths.
- Grounded answers cite the path through the graph (path explanation).
- Human review gates ontology changes and low-confidence merges.

## Related

- [../../skills/knowledge-graph-engineering/SKILL.md](../../skills/knowledge-graph-engineering/SKILL.md)
