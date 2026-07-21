# RELIABILITY

A validation site that drops evidence is worse than no site: it produces
confident wrong answers. Reliability here means evidence integrity first,
uptime second.

## Evidence integrity

- Qualified submissions persist before any tracking fires; tracking
  failures never fail the submission (and vice versa the submission failure
  is surfaced to the visitor).
- Evidence API writes are idempotent per (visitor_id, event, occurred_at
  bucket) to tolerate retries.
- Deterministic experiment assignment means a lost cookie re-derives the
  same variant for the same visitor id.
- Weekly analysis reports data gaps explicitly (days with zero events are
  flagged, not smoothed over).

## Uptime and performance

- Static-first rendering; the site works with JavaScript disabled except
  for form enhancement and consented tracking.
- Performance budgets in `config/quality.yaml` (LCP ≤ 2.5s mobile p75,
  CLS ≤ 0.1, INP ≤ 200ms).
- `page_error` events surface breakage; weekly report lists error routes.

## Failure behaviour

| Failure                   | Behaviour                                                          |
| ------------------------- | ------------------------------------------------------------------ |
| Neon unreachable (prod)   | form shows retry message; error logged; no silent drop             |
| GA blocked/declined       | site fully functional; Layer 3 unaffected                          |
| Experiment config invalid | variant falls back to control; `experiment_guardrail_event` logged |
| Analytics script error    | swallowed after logging; never breaks the page                     |
