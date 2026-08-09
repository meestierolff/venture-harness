PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS creative_variants (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  creative_id TEXT NOT NULL,
  registration_key TEXT NOT NULL,
  registration_binding TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  content_fingerprint_version TEXT NOT NULL,
  derived_from_creative_id TEXT,
  platform_variant_of_creative_id TEXT,
  variant_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (derived_from_creative_id IS NULL OR derived_from_creative_id <> creative_id),
  CHECK (platform_variant_of_creative_id IS NULL OR platform_variant_of_creative_id <> creative_id),
  CHECK (content_fingerprint_version IN ('v1','v2')),
  PRIMARY KEY (organization_id, venture_id, creative_id),
  UNIQUE (organization_id, venture_id, registration_key),
  FOREIGN KEY (organization_id, venture_id, derived_from_creative_id)
    REFERENCES creative_variants(organization_id, venture_id, creative_id),
  FOREIGN KEY (organization_id, venture_id, platform_variant_of_creative_id)
    REFERENCES creative_variants(organization_id, venture_id, creative_id)
);
CREATE INDEX IF NOT EXISTS creative_variants_lineage
  ON creative_variants(organization_id, venture_id, derived_from_creative_id, created_at);

CREATE TABLE IF NOT EXISTS creative_delivery_variants (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  delivery_variant_id TEXT NOT NULL,
  creative_id TEXT NOT NULL,
  delivery_fingerprint TEXT NOT NULL,
  registration_binding TEXT NOT NULL,
  delivery_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, delivery_variant_id),
  UNIQUE (organization_id, venture_id, creative_id, delivery_variant_id),
  UNIQUE (organization_id, venture_id, creative_id, delivery_fingerprint),
  FOREIGN KEY (organization_id, venture_id, creative_id)
    REFERENCES creative_variants(organization_id, venture_id, creative_id)
);

CREATE TABLE IF NOT EXISTS creative_provider_objects (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  creative_id TEXT NOT NULL,
  delivery_variant_id TEXT,
  external_account_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, provider, object_kind, external_id),
  FOREIGN KEY (organization_id, venture_id, creative_id)
    REFERENCES creative_variants(organization_id, venture_id, creative_id),
  FOREIGN KEY (organization_id, venture_id, creative_id, delivery_variant_id)
    REFERENCES creative_delivery_variants(organization_id, venture_id, creative_id, delivery_variant_id)
);
CREATE INDEX IF NOT EXISTS creative_provider_objects_by_creative
  ON creative_provider_objects(organization_id, venture_id, creative_id, recorded_at);

CREATE TABLE IF NOT EXISTS creative_status_current (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  creative_id TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('tiktok_organic','tiktok_paid','meta_paid')),
  status TEXT NOT NULL CHECK (status IN (
    'DRAFT',
    'READY_FOR_PRODUCTION',
    'RENDERING',
    'ASSET_READY',
    'RIGHTS_BLOCKED',
    'READY_FOR_ORGANIC_REVIEW',
    'ORGANIC_DRAFT',
    'ORGANIC_PUBLISHED',
    'ORGANIC_SIGNAL',
    'BOOST_CANDIDATE',
    'NEEDS_VARIANTS',
    'PAID_TEST_PROPOSED',
    'PAID_TEST_APPROVED',
    'PAID_TEST_RUNNING',
    'PAID_PROOF',
    'SCALE_ELIGIBLE',
    'SCALE_RECOMMENDED',
    'FATIGUED',
    'REJECTED',
    'ARCHIVED'
  )),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, creative_id, network),
  FOREIGN KEY (organization_id, venture_id, creative_id)
    REFERENCES creative_variants(organization_id, venture_id, creative_id)
);

CREATE TABLE IF NOT EXISTS creative_status_history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  creative_id TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('tiktok_organic','tiktok_paid','meta_paid')),
  from_status TEXT CHECK (from_status IS NULL OR from_status IN (
    'DRAFT',
    'READY_FOR_PRODUCTION',
    'RENDERING',
    'ASSET_READY',
    'RIGHTS_BLOCKED',
    'READY_FOR_ORGANIC_REVIEW',
    'ORGANIC_DRAFT',
    'ORGANIC_PUBLISHED',
    'ORGANIC_SIGNAL',
    'BOOST_CANDIDATE',
    'NEEDS_VARIANTS',
    'PAID_TEST_PROPOSED',
    'PAID_TEST_APPROVED',
    'PAID_TEST_RUNNING',
    'PAID_PROOF',
    'SCALE_ELIGIBLE',
    'SCALE_RECOMMENDED',
    'FATIGUED',
    'REJECTED',
    'ARCHIVED'
  )),
  to_status TEXT NOT NULL CHECK (to_status IN (
    'DRAFT',
    'READY_FOR_PRODUCTION',
    'RENDERING',
    'ASSET_READY',
    'RIGHTS_BLOCKED',
    'READY_FOR_ORGANIC_REVIEW',
    'ORGANIC_DRAFT',
    'ORGANIC_PUBLISHED',
    'ORGANIC_SIGNAL',
    'BOOST_CANDIDATE',
    'NEEDS_VARIANTS',
    'PAID_TEST_PROPOSED',
    'PAID_TEST_APPROVED',
    'PAID_TEST_RUNNING',
    'PAID_PROOF',
    'SCALE_ELIGIBLE',
    'SCALE_RECOMMENDED',
    'FATIGUED',
    'REJECTED',
    'ARCHIVED'
  )),
  recorded_at TEXT NOT NULL,
  reason_code TEXT,
  authority_ref TEXT,
  FOREIGN KEY (organization_id, venture_id, creative_id)
    REFERENCES creative_variants(organization_id, venture_id, creative_id)
);
CREATE INDEX IF NOT EXISTS creative_status_history_ordered
  ON creative_status_history(organization_id, venture_id, creative_id, network, sequence);

CREATE TRIGGER IF NOT EXISTS creative_variants_no_replacement
  BEFORE INSERT ON creative_variants
  WHEN EXISTS (
    SELECT 1 FROM creative_variants
    WHERE organization_id = NEW.organization_id
      AND venture_id = NEW.venture_id
      AND (creative_id = NEW.creative_id OR registration_key = NEW.registration_key)
  ) BEGIN
    SELECT RAISE(ABORT, 'creative variants are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS creative_variants_immutable
  BEFORE UPDATE ON creative_variants BEGIN
    SELECT RAISE(ABORT, 'creative variants are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS creative_variants_permanent
  BEFORE DELETE ON creative_variants BEGIN
    SELECT RAISE(ABORT, 'creative variants are permanent');
  END;
CREATE TRIGGER IF NOT EXISTS creative_delivery_variants_immutable
  BEFORE UPDATE ON creative_delivery_variants BEGIN
    SELECT RAISE(ABORT, 'creative delivery variants are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS creative_delivery_variants_no_replacement
  BEFORE INSERT ON creative_delivery_variants
  WHEN EXISTS (
    SELECT 1 FROM creative_delivery_variants
    WHERE organization_id = NEW.organization_id
      AND venture_id = NEW.venture_id
      AND (delivery_variant_id = NEW.delivery_variant_id OR (
        creative_id = NEW.creative_id
        AND delivery_fingerprint = NEW.delivery_fingerprint
      ))
  ) BEGIN
    SELECT RAISE(ABORT, 'creative delivery variants are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS creative_delivery_variants_permanent
  BEFORE DELETE ON creative_delivery_variants BEGIN
    SELECT RAISE(ABORT, 'creative delivery variants are permanent');
  END;
CREATE TRIGGER IF NOT EXISTS creative_provider_objects_immutable
  BEFORE UPDATE ON creative_provider_objects BEGIN
    SELECT RAISE(ABORT, 'creative provider mappings are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS creative_provider_objects_no_replacement
  BEFORE INSERT ON creative_provider_objects
  WHEN EXISTS (
    SELECT 1 FROM creative_provider_objects
    WHERE organization_id = NEW.organization_id
      AND venture_id = NEW.venture_id
      AND provider = NEW.provider
      AND object_kind = NEW.object_kind
      AND external_id = NEW.external_id
  ) BEGIN
    SELECT RAISE(ABORT, 'creative provider mappings are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS creative_provider_objects_permanent
  BEFORE DELETE ON creative_provider_objects BEGIN
    SELECT RAISE(ABORT, 'creative provider mappings are permanent');
  END;
CREATE TRIGGER IF NOT EXISTS creative_status_history_immutable
  BEFORE UPDATE ON creative_status_history BEGIN
    SELECT RAISE(ABORT, 'creative status history is immutable');
  END;
CREATE TRIGGER IF NOT EXISTS creative_status_history_no_replacement
  BEFORE INSERT ON creative_status_history
  WHEN NEW.sequence > 0 AND EXISTS (
    SELECT 1 FROM creative_status_history WHERE sequence = NEW.sequence
  ) BEGIN
    SELECT RAISE(ABORT, 'creative status history is immutable');
  END;
CREATE TRIGGER IF NOT EXISTS creative_status_history_permanent
  BEFORE DELETE ON creative_status_history BEGIN
    SELECT RAISE(ABORT, 'creative status history is permanent');
  END;
CREATE TRIGGER IF NOT EXISTS creative_status_identity_immutable
  BEFORE UPDATE OF organization_id, venture_id, creative_id, network
  ON creative_status_current BEGIN
    SELECT RAISE(ABORT, 'creative status identity is immutable');
  END;
CREATE TRIGGER IF NOT EXISTS creative_status_no_replacement
  BEFORE INSERT ON creative_status_current
  WHEN EXISTS (
    SELECT 1 FROM creative_status_current
    WHERE organization_id = NEW.organization_id
      AND venture_id = NEW.venture_id
      AND creative_id = NEW.creative_id
      AND network = NEW.network
  ) BEGIN
    SELECT RAISE(ABORT, 'creative status records are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS creative_status_permanent
  BEFORE DELETE ON creative_status_current BEGIN
    SELECT RAISE(ABORT, 'creative status records are permanent');
  END;

COMMIT;
