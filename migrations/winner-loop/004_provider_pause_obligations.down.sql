BEGIN IMMEDIATE;

DROP INDEX IF EXISTS provider_pause_pending;
DROP TABLE IF EXISTS provider_pause_obligations;

COMMIT;
