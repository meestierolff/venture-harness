PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS spend_grants (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  customer_id TEXT,
  network TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  total_minor INTEGER NOT NULL,
  per_creative_minor INTEGER NOT NULL,
  per_paid_test_minor INTEGER NOT NULL,
  per_campaign_minor INTEGER NOT NULL,
  daily_account_minor INTEGER NOT NULL,
  daily_venture_minor INTEGER NOT NULL,
  monthly_venture_minor INTEGER NOT NULL,
  allowed_creative_ids TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approval_ref TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  grant_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  halted_reason TEXT,
  PRIMARY KEY (organization_id, venture_id, grant_id)
);
CREATE TABLE IF NOT EXISTS spend_reservations (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  creative_id TEXT NOT NULL,
  paid_test_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  held_minor INTEGER NOT NULL,
  conservative_minor INTEGER NOT NULL DEFAULT 0,
  settled_minor INTEGER,
  status TEXT NOT NULL,
  day_key TEXT NOT NULL,
  month_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, reservation_id),
  UNIQUE (organization_id, venture_id, idempotency_key),
  FOREIGN KEY (organization_id, venture_id, grant_id)
    REFERENCES spend_grants(organization_id, venture_id, grant_id)
);
CREATE INDEX IF NOT EXISTS spend_res_grant
  ON spend_reservations(organization_id, venture_id, grant_id, status);
CREATE INDEX IF NOT EXISTS spend_res_day
  ON spend_reservations(organization_id, external_account_id, day_key);
CREATE TABLE IF NOT EXISTS spend_incidents (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, incident_id),
  FOREIGN KEY (organization_id, venture_id, grant_id)
    REFERENCES spend_grants(organization_id, venture_id, grant_id)
);

CREATE TABLE IF NOT EXISTS creative_manifests (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  creative_id TEXT NOT NULL,
  manifest_version INTEGER NOT NULL,
  review_event_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, creative_id, manifest_version),
  UNIQUE (organization_id, venture_id, review_event_id)
);
CREATE INDEX IF NOT EXISTS creative_manifest_current
  ON creative_manifests(organization_id, venture_id, creative_id, manifest_version DESC);

CREATE TABLE IF NOT EXISTS paid_test_proposal_history (
  record_id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS paid_test_history_by_proposal
  ON paid_test_proposal_history(organization_id, venture_id, proposal_id, record_id);
CREATE TABLE IF NOT EXISTS paid_test_proposals (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, proposal_id)
);
CREATE TABLE IF NOT EXISTS paid_test_safety_state (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  tracking_healthy INTEGER NOT NULL,
  attribution_healthy INTEGER NOT NULL,
  provider_eligible INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, proposal_id),
  FOREIGN KEY (organization_id, venture_id, proposal_id)
    REFERENCES paid_test_proposals(organization_id, venture_id, proposal_id)
);

CREATE TABLE IF NOT EXISTS subscription_events (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  revenuecat_project TEXT NOT NULL,
  environment TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, revenuecat_project, environment, provider_event_id)
);
CREATE INDEX IF NOT EXISTS subscription_events_ordered
  ON subscription_events(
    organization_id,
    venture_id,
    revenuecat_project,
    environment,
    occurred_at,
    provider_event_id
  );

CREATE TABLE IF NOT EXISTS winner_loop_evidence (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  creative_id TEXT,
  occurred_at TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, kind, record_id)
);
CREATE INDEX IF NOT EXISTS winner_loop_evidence_creative
  ON winner_loop_evidence(
    organization_id,
    venture_id,
    kind,
    creative_id,
    occurred_at,
    record_id
  );

COMMIT;
