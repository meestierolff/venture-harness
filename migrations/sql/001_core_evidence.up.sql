-- Venture Harness v0.2 core evidence schema.
-- Additive and idempotent: safe to apply repeatedly in one venture database.
begin;

create table if not exists vh_schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists experiment_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  event text not null,
  experiment_id text not null,
  variant_key text,
  visitor_id text not null,
  route text,
  displayed_offer text,
  displayed_price text,
  metric text,
  release_version text,
  event_id text unique
);

create table if not exists commercial_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  event text not null,
  visitor_id text not null,
  plan_key text,
  displayed_price text,
  billing_period text,
  experiment_id text,
  variant_key text,
  qualified boolean,
  qualification_tier text,
  attribution jsonb,
  provider text,
  release_version text,
  event_id text unique,
  constraint commercial_events_attribution_object
    check (attribution is null or jsonb_typeof(attribution) = 'object')
);

-- This is the only core table allowed to hold submitted personal data. API
-- boundaries keep payload values out of product_events and third parties.
create table if not exists submissions (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  form_id text not null,
  -- Compatibility name only: stores a server-generated submission-private
  -- nonce and must never contain the analytics visitor ID.
  visitor_id text not null,
  payload jsonb not null,
  qualified boolean not null,
  qualification_tier text,
  event_id text unique,
  constraint submissions_payload_object check (jsonb_typeof(payload) = 'object')
);

create table if not exists consent_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  event text not null,
  visitor_id text not null,
  from_state text,
  to_state text,
  event_id text unique
);

-- Capability-neutral first-party events for core, auth, onboarding, mobile,
-- feedback, payment lifecycle, and reliability packs. props is validated at
-- the typed API boundary against the active pack before insertion.
create table if not exists product_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  event text not null,
  visitor_id text,
  journey_id text,
  release_version text,
  props jsonb not null default '{}'::jsonb,
  event_id text unique,
  constraint product_events_props_object check (jsonb_typeof(props) = 'object')
);

-- Idempotency ledger for provider webhooks. payload_hash proves which body was
-- processed without retaining a private raw body in this generic table.
create table if not exists provider_webhook_events (
  id bigint generated always as identity primary key,
  provider text not null,
  external_event_id text not null,
  event_type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received',
  payload_hash text not null,
  error_code text,
  unique (provider, external_event_id),
  constraint provider_webhook_status
    check (status in ('received', 'processed', 'failed', 'ignored'))
);

-- Direct-sync ledger retains provenance and limitations. A missing source has
-- no row and must never be converted into a zero-valued dataset.
create table if not exists analytics_sync_runs (
  id bigint generated always as identity primary key,
  dataset_id text not null unique,
  source text not null,
  source_account text not null,
  fetched_at timestamptz not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  timezone text not null,
  quality_status text not null,
  dimensions jsonb not null default '[]'::jsonb,
  limitations jsonb not null default '[]'::jsonb,
  release_version text,
  row_count integer not null,
  constraint analytics_sync_window check (window_end >= window_start),
  constraint analytics_sync_row_count check (row_count >= 0),
  constraint analytics_sync_quality
    check (quality_status in ('complete', 'partial', 'sampled', 'thresholded', 'stale', 'unavailable')),
  constraint analytics_sync_dimensions_array check (jsonb_typeof(dimensions) = 'array'),
  constraint analytics_sync_limitations_array check (jsonb_typeof(limitations) = 'array')
);

create index if not exists experiment_events_experiment_occurred_idx
  on experiment_events (experiment_id, occurred_at);
create index if not exists commercial_events_event_occurred_idx
  on commercial_events (event, occurred_at);
create index if not exists submissions_form_occurred_idx
  on submissions (form_id, occurred_at);
create index if not exists consent_events_visitor_occurred_idx
  on consent_events (visitor_id, occurred_at);
create index if not exists product_events_journey_occurred_idx
  on product_events (journey_id, occurred_at);
create index if not exists provider_webhook_events_status_received_idx
  on provider_webhook_events (status, received_at);
create index if not exists analytics_sync_runs_source_fetched_idx
  on analytics_sync_runs (source, fetched_at desc);

insert into vh_schema_migrations (version)
values ('001_core_evidence')
on conflict (version) do nothing;

commit;
