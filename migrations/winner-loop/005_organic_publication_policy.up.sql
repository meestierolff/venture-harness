PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

-- Apply-time organic policy evidence. Policy, account health, and human review
-- are immutable HMAC-bound snapshots; reservations serialize account/day caps,
-- duplicate policy, and request-bound idempotency before provider transport.
CREATE TABLE IF NOT EXISTS organic_policy_snapshots (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  integrity_proof TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, snapshot_id)
);
CREATE INDEX IF NOT EXISTS organic_policy_current
  ON organic_policy_snapshots(
    organization_id, venture_id, captured_at DESC, snapshot_id DESC
  );

CREATE TABLE IF NOT EXISTS organic_provider_snapshots (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  account_state_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  integrity_proof TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, snapshot_id)
);
CREATE INDEX IF NOT EXISTS organic_provider_current
  ON organic_provider_snapshots(
    organization_id, venture_id, provider_id, provider_account_id,
    observed_at DESC, snapshot_id DESC
  );

CREATE TABLE IF NOT EXISTS organic_review_approvals (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  integrity_proof TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, approval_id)
);

CREATE TABLE IF NOT EXISTS organic_publication_reservations (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  creative_id TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  variation_fingerprint TEXT,
  day_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'reserved',
    'accepted_unverified',
    'pending_reconciliation',
    'verified_draft',
    'published',
    'confirmed_absent',
    'failed_no_effect',
    'conflict'
  )),
  provider_operation_id TEXT,
  evidence_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  integrity_proof TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, reservation_id),
  UNIQUE (organization_id, venture_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS organic_publication_daily
  ON organic_publication_reservations(
    organization_id, venture_id, provider_account_id, day_key, state
  );
CREATE INDEX IF NOT EXISTS organic_publication_duplicate
  ON organic_publication_reservations(
    organization_id, venture_id, content_fingerprint, variation_fingerprint,
    provider_account_id, state
  );

COMMIT;
