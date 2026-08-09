BEGIN IMMEDIATE;

DROP TRIGGER IF EXISTS creative_status_permanent;
DROP TRIGGER IF EXISTS creative_status_no_replacement;
DROP TRIGGER IF EXISTS creative_status_identity_immutable;
DROP TRIGGER IF EXISTS creative_status_history_permanent;
DROP TRIGGER IF EXISTS creative_status_history_no_replacement;
DROP TRIGGER IF EXISTS creative_status_history_immutable;
DROP TRIGGER IF EXISTS creative_provider_objects_permanent;
DROP TRIGGER IF EXISTS creative_provider_objects_no_replacement;
DROP TRIGGER IF EXISTS creative_provider_objects_immutable;
DROP TRIGGER IF EXISTS creative_delivery_variants_permanent;
DROP TRIGGER IF EXISTS creative_delivery_variants_no_replacement;
DROP TRIGGER IF EXISTS creative_delivery_variants_immutable;
DROP TRIGGER IF EXISTS creative_variants_permanent;
DROP TRIGGER IF EXISTS creative_variants_immutable;
DROP TRIGGER IF EXISTS creative_variants_no_replacement;

DROP INDEX IF EXISTS creative_status_history_ordered;
DROP INDEX IF EXISTS creative_provider_objects_by_creative;
DROP INDEX IF EXISTS creative_variants_lineage;

DROP TABLE IF EXISTS creative_status_history;
DROP TABLE IF EXISTS creative_status_current;
DROP TABLE IF EXISTS creative_provider_objects;
DROP TABLE IF EXISTS creative_delivery_variants;
DROP TABLE IF EXISTS creative_variants;

COMMIT;
