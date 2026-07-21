# BACKEND

Server-side surface of the validation site: small by design.

## Evidence store (Layer 3)

Per-venture Neon Postgres, connection via `DATABASE_URL`. Development
fallback: JSONL under `.data/` (gitignored) when
`EVIDENCE_LOCAL_FALLBACK=true`. Production requires Neon; the API refuses
silent no-op persistence.

### Schema

```sql
-- experiment lifecycle
create table if not exists experiment_events (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  event       text not null,          -- experiment_eligible|assigned|exposed|primary_conversion|guardrail_event
  experiment_id text not null,
  variant_key text,
  visitor_id  text not null,          -- anonymous first-party id, no PII
  route       text,
  displayed_offer text,
  displayed_price text,               -- EXACT string shown to the visitor
  metric      text
);

-- commercial intent and conversions
create table if not exists commercial_events (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  event       text not null,          -- plan_selected|pilot_selected|checkout_intent|reservation_intent|form_submission_confirmed|qualification_completed|...
  visitor_id  text not null,
  plan_key    text,
  displayed_price text,
  billing_period  text,
  experiment_id   text,
  variant_key     text,
  qualified   boolean,
  qualification_tier text,
  attribution jsonb                    -- {first_touch, last_touch, utm_*} — domains and utm values only
);

-- qualified submissions (the only table holding personal data)
create table if not exists submissions (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  form_id     text not null,
  visitor_id  text not null,
  payload     jsonb not null,          -- form answers; NEVER copied to analytics
  qualified   boolean not null,
  qualification_tier text
);

-- consent ledger (anonymous)
create table if not exists consent_events (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  event       text not null,
  visitor_id  text not null,
  from_state  text,
  to_state    text
);
```

## Rules

- High-intent submissions must survive analytics failures: the form POST is
  its own request; tracking is fire-and-forget after persistence succeeds.
- Personal data lives only in `submissions.payload`. Nothing joins it to
  analytics providers.
- `displayed_price` is stored verbatim as rendered; analysis never
  reconstructs prices from config history.
- Rate-limit and validate all API input with Zod; reject unknown fields.
- No shared databases between ventures, ever.

## Related

- [ANALYTICS.md](ANALYTICS.md)
- [SECURITY.md](SECURITY.md)
- [DEPLOYMENT.md](DEPLOYMENT.md)
