BEGIN IMMEDIATE;

ALTER TABLE spend_reservations DROP COLUMN reconciled_at;
ALTER TABLE spend_reservations DROP COLUMN reconciliation_outcome;
ALTER TABLE spend_reservations DROP COLUMN pending_at;
ALTER TABLE spend_reservations DROP COLUMN pending_reason;

ALTER TABLE spend_grants DROP COLUMN emergency_platform_minor;
ALTER TABLE spend_grants DROP COLUMN monthly_customer_minor;
ALTER TABLE spend_grants DROP COLUMN daily_customer_minor;

COMMIT;
