# LEARNINGS

Durable, human-curated lessons distilled from the JSONL streams. The
streams are the record; this file is the digest. Append-only in spirit:
superseded lessons are struck through with a note, never deleted.

## JSONL schemas

All memory files are append-only JSON Lines, written ONLY via the scripts
(`pnpm outcome:add`, `pnpm experiment:add`). No personal data — entries
are committed to git.

`outcomes.jsonl` / `corrections.jsonl` / `customer-language.jsonl`:

```json
{
  "date": "YYYY-MM-DD",
  "type": "outcome|correction|customer-language",
  "summary": "...",
  "detail": "...",
  "source": "..."
}
```

`experiments.jsonl`:

```json
{
  "date": "YYYY-MM-DD",
  "id": "exp-NNN-slug",
  "decision": "adopt|reject|rerun|inconclusive",
  "exposures": { "control": 0 },
  "primary": { "control": 0.0 },
  "limitations": "..."
}
```

Rules: negative outcomes are retained; corrections that recur get
promoted (see docs/engineering/HARNESS_ENGINEERING.md); customer language
is verbatim but anonymized.

## Lessons

(none yet — template state)
