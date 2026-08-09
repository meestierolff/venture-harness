PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

-- A local halt is immediate, but it is not proof that a running provider
-- campaign stopped. This durable outbox records the immutable pause request and
-- keeps every unresolved provider outcome visible across worker restarts.
CREATE TABLE IF NOT EXISTS provider_pause_obligations (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  obligation_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  network TEXT NOT NULL,
  provider_adapter_id TEXT,
  external_account_id TEXT NOT NULL,
  campaign_id TEXT,
  target_key TEXT NOT NULL,
  operation_id TEXT,
  idempotency_key TEXT,
  request_hash TEXT,
  payload_json TEXT,
  reasons_json TEXT NOT NULL,
  incident_ids_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending',
    'attempting',
    'accepted_unverified',
    'unknown',
    'failed',
    'blocked',
    'verified'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider_operation_id TEXT,
  last_diagnostic_code TEXT,
  last_diagnostic_message TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_attempted_at TEXT,
  last_apply_state TEXT CHECK (last_apply_state IS NULL OR last_apply_state IN (
    'accepted_unverified',
    'unknown',
    'failed',
    'blocked'
  )),
  last_read_back_state TEXT CHECK (last_read_back_state IS NULL OR last_read_back_state IN (
    'matched',
    'missing',
    'conflict',
    'unknown',
    'blocked'
  )),
  last_read_back_at TEXT,
  last_reconciled_at TEXT,
  verified_at TEXT,
  PRIMARY KEY (organization_id, venture_id, obligation_id),
  UNIQUE (organization_id, venture_id, grant_id, target_key),
  FOREIGN KEY (organization_id, venture_id, grant_id)
    REFERENCES spend_grants(organization_id, venture_id, grant_id)
);
CREATE INDEX IF NOT EXISTS provider_pause_pending
  ON provider_pause_obligations(organization_id, venture_id, grant_id, state, created_at);

COMMIT;
