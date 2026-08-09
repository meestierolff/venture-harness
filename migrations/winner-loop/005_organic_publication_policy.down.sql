BEGIN IMMEDIATE;

-- Drop the organization-and-venture-scoped policy and reservation ledger.
DROP INDEX IF EXISTS organic_publication_duplicate;
DROP INDEX IF EXISTS organic_publication_daily;
DROP TABLE IF EXISTS organic_publication_reservations;
DROP TABLE IF EXISTS organic_review_approvals;
DROP INDEX IF EXISTS organic_provider_current;
DROP TABLE IF EXISTS organic_provider_snapshots;
DROP INDEX IF EXISTS organic_policy_current;
DROP TABLE IF EXISTS organic_policy_snapshots;

COMMIT;
