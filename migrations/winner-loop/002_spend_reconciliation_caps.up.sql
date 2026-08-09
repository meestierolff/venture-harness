-- Applied once by the migration runner. The runtime SQLite adapter also checks
-- these columns individually so older local ledgers fail safe during upgrade.
BEGIN IMMEDIATE;

ALTER TABLE spend_grants
  ADD COLUMN daily_customer_minor INTEGER NOT NULL DEFAULT 9007199254740991;
ALTER TABLE spend_grants
  ADD COLUMN monthly_customer_minor INTEGER NOT NULL DEFAULT 9007199254740991;
ALTER TABLE spend_grants
  ADD COLUMN emergency_platform_minor INTEGER NOT NULL DEFAULT 9007199254740991;
UPDATE spend_grants SET daily_customer_minor = total_minor;
UPDATE spend_grants SET monthly_customer_minor = total_minor;
UPDATE spend_grants SET emergency_platform_minor = total_minor;

ALTER TABLE spend_reservations ADD COLUMN pending_reason TEXT;
ALTER TABLE spend_reservations ADD COLUMN pending_at TEXT;
ALTER TABLE spend_reservations ADD COLUMN reconciliation_outcome TEXT;
ALTER TABLE spend_reservations ADD COLUMN reconciled_at TEXT;

COMMIT;
