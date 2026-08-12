import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { initializeSqliteWal } from "@venture-harness/core";
import {
  LEGACY_UNSCOPED_ORGANIZATION_ID,
  LEGACY_ADOPTION_INVALIDATION_REASON,
  adoptLegacyTenantPayload,
  assertAddressableTenantScope,
  assertLegacyTenantAdoptionJournalCompatibility,
  recordLegacyTenantAdoptions,
  type LegacyAdoptionOptions,
  type LegacyTenantAdoptionJournalResolution,
  type LegacyTenantTarget,
} from "./legacy-adoption";
import {
  CREATIVE_NETWORKS,
  CREATIVE_STATUSES,
  type CreativeNetwork,
  type CreativeProviderObject,
  type CreativeStatus,
  type CreativeVariant,
  type DeliveryVariant,
} from "./types";

export interface CreativeStatusHistoryEntry {
  readonly sequence: number;
  readonly organizationId: string;
  readonly ventureId: string;
  readonly creativeId: string;
  readonly network: CreativeNetwork;
  readonly fromStatus: CreativeStatus | null;
  readonly toStatus: CreativeStatus;
  readonly recordedAt: string;
  readonly reasonCode: string | null;
  readonly authorityRef: string | null;
}

export type CreativeStoreWriteOutcome<T> =
  { kind: "created" | "replay"; value: T } | { kind: "conflict"; reason: string };

export interface CreativeLedgerScope {
  readonly organizationId: string;
  readonly ventureId: string;
}

export interface CreativeLedgerStore {
  readonly label: string;
  readonly durable: boolean;
  putVariant(input: {
    organizationId: string;
    ventureId: string;
    registrationKey: string;
    registrationBinding: string;
    variant: CreativeVariant;
  }): CreativeStoreWriteOutcome<CreativeVariant>;
  getVariant(scope: CreativeLedgerScope, creativeId: string): CreativeVariant | undefined;
  getVariantRegistrationBinding(scope: CreativeLedgerScope, creativeId: string): string | undefined;
  hasCreative(scope: CreativeLedgerScope, creativeId: string): boolean;
  listVariants(scope: CreativeLedgerScope): readonly CreativeVariant[];
  putDeliveryVariant(
    scope: CreativeLedgerScope,
    registrationBinding: string,
    variant: DeliveryVariant,
  ): CreativeStoreWriteOutcome<DeliveryVariant>;
  getDeliveryVariant(
    scope: CreativeLedgerScope,
    deliveryVariantId: string,
  ): DeliveryVariant | undefined;
  listDeliveryVariants(scope: CreativeLedgerScope, creativeId: string): readonly DeliveryVariant[];
  putProviderObject(
    record: CreativeProviderObject,
  ): CreativeStoreWriteOutcome<CreativeProviderObject>;
  resolveProviderObject(
    scope: CreativeLedgerScope,
    provider: string,
    objectKind: string,
    externalId: string,
  ): CreativeProviderObject | undefined;
  listProviderObjects(
    scope: CreativeLedgerScope,
    creativeId: string,
  ): readonly CreativeProviderObject[];
  getStatus(
    scope: CreativeLedgerScope,
    creativeId: string,
    network: CreativeNetwork,
  ): CreativeStatus | undefined;
  transitionStatus(input: {
    organizationId: string;
    ventureId: string;
    creativeId: string;
    network: CreativeNetwork;
    expected: CreativeStatus;
    next: CreativeStatus;
    recordedAt: string;
  }):
    | { kind: "created" | "replay"; status: CreativeStatus }
    | { kind: "conflict"; current: CreativeStatus | undefined };
  listStatusHistory(
    scope: CreativeLedgerScope,
    creativeId: string,
    network?: CreativeNetwork,
  ): readonly CreativeStatusHistoryEntry[];
  close(): void;
}

function assertScope(scope: CreativeLedgerScope): void {
  assertAddressableTenantScope(scope, "creative ledger");
}

function scopedKey(scope: CreativeLedgerScope, ...parts: readonly string[]): string {
  assertScope(scope);
  return JSON.stringify([scope.organizationId, scope.ventureId, ...parts]);
}

function freezeVariant(variant: CreativeVariant): CreativeVariant {
  return Object.freeze({
    ...variant,
    media: Object.freeze({ ...variant.media }),
  });
}

function freezeDeliveryVariant(variant: DeliveryVariant): DeliveryVariant {
  return Object.freeze({
    ...variant,
    delivery: Object.freeze({
      ...variant.delivery,
      platformSettings: Object.freeze({ ...variant.delivery.platformSettings }),
    }),
  });
}

function freezeProviderObject(record: CreativeProviderObject): CreativeProviderObject {
  return Object.freeze({ ...record });
}

function providerKey(
  scope: CreativeLedgerScope,
  provider: string,
  objectKind: string,
  externalId: string,
): string {
  return scopedKey(scope, provider, objectKind, externalId);
}

function providerBinding(record: CreativeProviderObject): string {
  return JSON.stringify({
    organizationId: record.organizationId,
    ventureId: record.ventureId,
    creativeId: record.creativeId,
    deliveryVariantId: record.deliveryVariantId,
    provider: record.provider,
    objectKind: record.objectKind,
    externalId: record.externalId,
    externalAccountId: record.externalAccountId,
  });
}

export function createMemoryCreativeLedgerStore(): CreativeLedgerStore {
  const variants = new Map<
    string,
    {
      scope: CreativeLedgerScope;
      registrationKey: string;
      binding: string;
      value: CreativeVariant;
    }
  >();
  const variantByRegistration = new Map<string, string>();
  const deliveries = new Map<
    string,
    { scope: CreativeLedgerScope; binding: string; value: DeliveryVariant }
  >();
  const deliveryByRegistration = new Map<string, string>();
  const providerObjects = new Map<string, CreativeProviderObject>();
  const statuses = new Map<string, CreativeStatus>();
  const history: CreativeStatusHistoryEntry[] = [];
  let sequence = 0;
  const variantKey = (scope: CreativeLedgerScope, creativeId: string) =>
    scopedKey(scope, creativeId);
  const registrationKey = (scope: CreativeLedgerScope, key: string) => scopedKey(scope, key);
  const deliveryKey = (scope: CreativeLedgerScope, id: string) => scopedKey(scope, id);
  const deliveryRegistrationKey = (
    scope: CreativeLedgerScope,
    creativeId: string,
    fingerprint: string,
  ) => scopedKey(scope, creativeId, fingerprint);
  const statusKey = (scope: CreativeLedgerScope, creativeId: string, network: CreativeNetwork) =>
    scopedKey(scope, creativeId, network);

  return {
    label: "memory (test only)",
    durable: false,
    putVariant(input) {
      const scope = { organizationId: input.organizationId, ventureId: input.ventureId };
      assertScope(scope);
      const idKey = variantKey(scope, input.variant.creativeId);
      const existingId = variants.get(idKey);
      if (existingId) {
        return existingId.registrationKey === input.registrationKey &&
          existingId.binding === input.registrationBinding
          ? { kind: "replay", value: existingId.value }
          : { kind: "conflict", reason: "creative id is already bound to different material" };
      }
      const replayId = variantByRegistration.get(registrationKey(scope, input.registrationKey));
      if (replayId) {
        const existing = variants.get(variantKey(scope, replayId))!;
        return existing.binding === input.registrationBinding
          ? { kind: "replay", value: existing.value }
          : {
              kind: "conflict",
              reason: "creative registration key is already bound to different material",
            };
      }

      const value = freezeVariant(input.variant);
      variants.set(idKey, {
        scope: Object.freeze({ ...scope }),
        registrationKey: input.registrationKey,
        binding: input.registrationBinding,
        value,
      });
      variantByRegistration.set(registrationKey(scope, input.registrationKey), value.creativeId);
      for (const network of CREATIVE_NETWORKS) {
        statuses.set(statusKey(scope, value.creativeId, network), "DRAFT");
        history.push(
          Object.freeze({
            sequence: ++sequence,
            organizationId: input.organizationId,
            ventureId: input.ventureId,
            creativeId: value.creativeId,
            network,
            fromStatus: null,
            toStatus: "DRAFT" as const,
            recordedAt: value.createdAt,
            reasonCode: null,
            authorityRef: null,
          }),
        );
      }
      return { kind: "created", value };
    },
    getVariant(scope, creativeId) {
      return variants.get(variantKey(scope, creativeId))?.value;
    },
    getVariantRegistrationBinding(scope, creativeId) {
      return variants.get(variantKey(scope, creativeId))?.binding;
    },
    hasCreative(scope, creativeId) {
      return variants.has(variantKey(scope, creativeId));
    },
    listVariants(scope) {
      assertScope(scope);
      return Object.freeze(
        [...variants.values()]
          .filter(
            (entry) =>
              entry.scope.organizationId === scope.organizationId &&
              entry.scope.ventureId === scope.ventureId,
          )
          .map((entry) => entry.value),
      );
    },
    putDeliveryVariant(scope, binding, variant) {
      if (!variants.has(variantKey(scope, variant.creativeId))) {
        return { kind: "conflict", reason: "delivery variant creative does not exist" };
      }
      const idKey = deliveryKey(scope, variant.deliveryVariantId);
      const existingId = deliveries.get(idKey);
      if (existingId) {
        return existingId.binding === binding
          ? { kind: "replay", value: existingId.value }
          : { kind: "conflict", reason: "delivery variant id is already bound" };
      }
      const registration = deliveryRegistrationKey(
        scope,
        variant.creativeId,
        variant.deliveryFingerprint,
      );
      const replayId = deliveryByRegistration.get(registration);
      if (replayId) {
        const existing = deliveries.get(deliveryKey(scope, replayId))!;
        return existing.binding === binding
          ? { kind: "replay", value: existing.value }
          : { kind: "conflict", reason: "delivery fingerprint is already bound" };
      }
      const value = freezeDeliveryVariant(variant);
      deliveries.set(idKey, { scope: Object.freeze({ ...scope }), binding, value });
      deliveryByRegistration.set(registration, value.deliveryVariantId);
      return { kind: "created", value };
    },
    getDeliveryVariant(scope, deliveryVariantId) {
      return deliveries.get(deliveryKey(scope, deliveryVariantId))?.value;
    },
    listDeliveryVariants(scope, creativeId) {
      assertScope(scope);
      return Object.freeze(
        [...deliveries.values()]
          .filter(
            (entry) =>
              entry.scope.organizationId === scope.organizationId &&
              entry.scope.ventureId === scope.ventureId &&
              entry.value.creativeId === creativeId,
          )
          .map((entry) => entry.value),
      );
    },
    putProviderObject(record) {
      const scope = { organizationId: record.organizationId, ventureId: record.ventureId };
      if (!variants.has(variantKey(scope, record.creativeId))) {
        return { kind: "conflict", reason: "provider object creative does not exist" };
      }
      if (record.deliveryVariantId !== null) {
        const delivery = deliveries.get(deliveryKey(scope, record.deliveryVariantId))?.value;
        if (!delivery || delivery.creativeId !== record.creativeId) {
          return {
            kind: "conflict",
            reason: "provider object delivery variant belongs to a different creative",
          };
        }
      }
      const key = providerKey(scope, record.provider, record.objectKind, record.externalId);
      const existing = providerObjects.get(key);
      if (existing) {
        return providerBinding(existing) === providerBinding(record)
          ? { kind: "replay", value: existing }
          : { kind: "conflict", reason: "provider object is already bound" };
      }
      const value = freezeProviderObject(record);
      providerObjects.set(key, value);
      return { kind: "created", value };
    },
    resolveProviderObject: (scope, provider, objectKind, externalId) =>
      providerObjects.get(providerKey(scope, provider, objectKind, externalId)),
    listProviderObjects(scope, creativeId) {
      assertScope(scope);
      return Object.freeze(
        [...providerObjects.values()].filter(
          (entry) =>
            entry.organizationId === scope.organizationId &&
            entry.ventureId === scope.ventureId &&
            entry.creativeId === creativeId,
        ),
      );
    },
    getStatus: (scope, creativeId, network) => statuses.get(statusKey(scope, creativeId, network)),
    transitionStatus(input) {
      const scope = { organizationId: input.organizationId, ventureId: input.ventureId };
      const key = statusKey(scope, input.creativeId, input.network);
      const current = statuses.get(key);
      if (current === input.next) return { kind: "replay", status: current };
      if (current !== input.expected) return { kind: "conflict", current };
      statuses.set(key, input.next);
      history.push(
        Object.freeze({
          sequence: ++sequence,
          organizationId: input.organizationId,
          ventureId: input.ventureId,
          creativeId: input.creativeId,
          network: input.network,
          fromStatus: current,
          toStatus: input.next,
          recordedAt: input.recordedAt,
          reasonCode: null,
          authorityRef: null,
        }),
      );
      return { kind: "created", status: input.next };
    },
    listStatusHistory(scope, creativeId, network) {
      assertScope(scope);
      return Object.freeze(
        history.filter(
          (entry) =>
            entry.organizationId === scope.organizationId &&
            entry.ventureId === scope.ventureId &&
            entry.creativeId === creativeId &&
            (network === undefined || entry.network === network),
        ),
      );
    },
    close() {},
  };
}

interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}
interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): SqliteRunResult;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function loadSqlite(): { DatabaseSync: new (path: string) => SqliteDatabase } {
  try {
    return createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
  } catch (error) {
    throw new Error(`creative ledger SQLite store unavailable: ${(error as Error).message}`);
  }
}

const CREATIVE_STATUSES_SQL = CREATIVE_STATUSES.map((status) => `'${status}'`).join(",");
const LEDGER_SCHEMA = `
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
  status TEXT NOT NULL CHECK (status IN (${CREATIVE_STATUSES_SQL})),
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
  from_status TEXT CHECK (from_status IS NULL OR from_status IN (${CREATIVE_STATUSES_SQL})),
  to_status TEXT NOT NULL CHECK (to_status IN (${CREATIVE_STATUSES_SQL})),
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
  BEFORE UPDATE OF organization_id, venture_id, creative_id, network ON creative_status_current BEGIN
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
`;

function tableHasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[]).some(
    (entry) => entry.name === column,
  );
}

function ensureLedgerHistoryMetadataColumns(db: SqliteDatabase): void {
  if (!tableHasColumn(db, "creative_status_history", "reason_code")) {
    db.exec("ALTER TABLE creative_status_history ADD COLUMN reason_code TEXT");
  }
  if (!tableHasColumn(db, "creative_status_history", "authority_ref")) {
    db.exec("ALTER TABLE creative_status_history ADD COLUMN authority_ref TEXT");
  }
}

const LEDGER_TRIGGERS = [
  "creative_variants_no_replacement",
  "creative_variants_immutable",
  "creative_variants_permanent",
  "creative_delivery_variants_immutable",
  "creative_delivery_variants_no_replacement",
  "creative_delivery_variants_permanent",
  "creative_provider_objects_immutable",
  "creative_provider_objects_no_replacement",
  "creative_provider_objects_permanent",
  "creative_status_history_immutable",
  "creative_status_history_no_replacement",
  "creative_status_history_permanent",
  "creative_status_identity_immutable",
  "creative_status_no_replacement",
  "creative_status_permanent",
] as const;

function dropLedgerGuards(db: SqliteDatabase): void {
  for (const trigger of LEDGER_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
}

interface LedgerRows {
  variants: Record<string, unknown>[];
  deliveries: Record<string, unknown>[];
  providers: Record<string, unknown>[];
  statuses: Record<string, unknown>[];
  history: Record<string, unknown>[];
}

const ORGANIC_EFFECT_AUTHORIZING_STATUSES = new Set<CreativeStatus>([
  "ORGANIC_DRAFT",
  "ORGANIC_PUBLISHED",
  "ORGANIC_SIGNAL",
  "BOOST_CANDIDATE",
  "NEEDS_VARIANTS",
]);

const PAID_EFFECT_AUTHORIZING_STATUSES = new Set<CreativeStatus>([
  "PAID_TEST_APPROVED",
  "PAID_TEST_RUNNING",
  "PAID_PROOF",
  "SCALE_ELIGIBLE",
  "SCALE_RECOMMENDED",
]);

function safeStatusAfterAdoption(row: Record<string, unknown>): CreativeStatus {
  const current = row.status as CreativeStatus;
  if (ORGANIC_EFFECT_AUTHORIZING_STATUSES.has(current)) {
    return "READY_FOR_ORGANIC_REVIEW";
  }
  if (PAID_EFFECT_AUTHORIZING_STATUSES.has(current)) {
    return "PAID_TEST_PROPOSED";
  }
  return current;
}

function readLedgerRows(
  db: SqliteDatabase,
  tableSuffix: string,
  organizationId?: string,
): LedgerRows {
  const read = (table: string) =>
    db
      .prepare(
        `SELECT * FROM ${table}${tableSuffix}${organizationId ? " WHERE organization_id = ?" : ""}`,
      )
      .all(...(organizationId ? [organizationId] : [])) as Record<string, unknown>[];
  return {
    variants: read("creative_variants"),
    deliveries: read("creative_delivery_variants"),
    providers: read("creative_provider_objects"),
    statuses: read("creative_status_current"),
    history: read("creative_status_history"),
  };
}

function ledgerVentureIds(rows: LedgerRows): string[] {
  return [
    ...rows.variants,
    ...rows.deliveries,
    ...rows.providers,
    ...rows.statuses,
    ...rows.history,
  ].map((row) => row.venture_id as string);
}

function adoptedJson(json: unknown, target: LegacyTenantTarget, label: string): string {
  if (typeof json !== "string") throw new Error(`${label} has no JSON identity payload`);
  try {
    return JSON.stringify(adoptLegacyTenantPayload(JSON.parse(json) as unknown, target));
  } catch (error) {
    throw new Error(`${label} has invalid JSON identity payload: ${(error as Error).message}`);
  }
}

function adoptedBinding(binding: unknown, target: LegacyTenantTarget, label: string): string {
  return adoptedJson(binding, target, label);
}

function insertAdoptedLedgerRows(
  db: SqliteDatabase,
  rows: LedgerRows,
  resolution: LegacyTenantAdoptionJournalResolution,
): void {
  const targetFor = (row: Record<string, unknown>) =>
    resolution.targets.get(row.venture_id as string)!;
  const putVariant = db.prepare(
    `INSERT INTO creative_variants (
      organization_id, venture_id, creative_id, registration_key, registration_binding,
      content_fingerprint, content_fingerprint_version, derived_from_creative_id,
      platform_variant_of_creative_id, variant_json, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const row of rows.variants) {
    const target = targetFor(row);
    const binding = adoptedBinding(row.registration_binding, target, "creative registration");
    putVariant.run(
      target.organizationId,
      target.ventureId,
      row.creative_id,
      createHash("sha256").update(binding).digest("hex"),
      binding,
      row.content_fingerprint,
      row.content_fingerprint_version,
      row.derived_from_creative_id,
      row.platform_variant_of_creative_id,
      adoptedJson(row.variant_json, target, "creative variant"),
      row.created_at,
    );
  }
  const putDelivery = db.prepare(
    `INSERT INTO creative_delivery_variants (
      organization_id, venture_id, delivery_variant_id, creative_id, delivery_fingerprint,
      registration_binding, delivery_json, created_at
    ) VALUES (?,?,?,?,?,?,?,?)`,
  );
  for (const row of rows.deliveries) {
    const target = targetFor(row);
    putDelivery.run(
      target.organizationId,
      target.ventureId,
      row.delivery_variant_id,
      row.creative_id,
      row.delivery_fingerprint,
      adoptedBinding(row.registration_binding, target, "creative delivery registration"),
      adoptedJson(row.delivery_json, target, "creative delivery"),
      row.created_at,
    );
  }
  const putProvider = db.prepare(
    `INSERT INTO creative_provider_objects (
      organization_id, venture_id, provider, object_kind, external_id, creative_id,
      delivery_variant_id, external_account_id, record_json, recorded_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const row of rows.providers) {
    const target = targetFor(row);
    putProvider.run(
      target.organizationId,
      target.ventureId,
      row.provider,
      row.object_kind,
      row.external_id,
      row.creative_id,
      row.delivery_variant_id,
      row.external_account_id,
      adoptedJson(row.record_json, target, "creative provider mapping"),
      row.recorded_at,
    );
  }
  const putStatus = db.prepare(
    `INSERT INTO creative_status_current
     (organization_id, venture_id, creative_id, network, status, updated_at)
     VALUES (?,?,?,?,?,?)`,
  );
  for (const row of rows.statuses) {
    const target = targetFor(row);
    const safeStatus = safeStatusAfterAdoption(row);
    putStatus.run(
      target.organizationId,
      target.ventureId,
      row.creative_id,
      row.network,
      safeStatus,
      safeStatus === row.status ? row.updated_at : resolution.approvedAt,
    );
  }
  const putHistory = db.prepare(
    `INSERT INTO creative_status_history (
      sequence, organization_id, venture_id, creative_id, network, from_status, to_status,
      recorded_at, reason_code, authority_ref
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const row of rows.history) {
    const target = targetFor(row);
    putHistory.run(
      row.sequence,
      target.organizationId,
      target.ventureId,
      row.creative_id,
      row.network,
      row.from_status,
      row.to_status,
      row.recorded_at,
      row.reason_code ?? null,
      row.authority_ref ?? null,
    );
  }
  const putInvalidation = db.prepare(
    `INSERT INTO creative_status_history (
      organization_id, venture_id, creative_id, network, from_status, to_status,
      recorded_at, reason_code, authority_ref
    ) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const row of rows.statuses) {
    const safeStatus = safeStatusAfterAdoption(row);
    if (safeStatus === row.status) continue;
    const target = targetFor(row);
    putInvalidation.run(
      target.organizationId,
      target.ventureId,
      row.creative_id,
      row.network,
      row.status,
      safeStatus,
      resolution.approvedAt,
      LEGACY_ADOPTION_INVALIDATION_REASON,
      resolution.authorityRef,
    );
  }
}

function adoptSentinelLedgerRows(
  db: SqliteDatabase,
  rows: LedgerRows,
  resolution: LegacyTenantAdoptionJournalResolution,
): void {
  dropLedgerGuards(db);
  ensureLedgerHistoryMetadataColumns(db);
  for (const row of rows.variants) {
    const target = resolution.targets.get(row.venture_id as string)!;
    const binding = adoptedBinding(row.registration_binding, target, "creative registration");
    db.prepare(
      `UPDATE creative_variants SET organization_id = ?, venture_id = ?, registration_key = ?,
       registration_binding = ?, variant_json = ?
       WHERE organization_id = ? AND venture_id = ? AND creative_id = ?`,
    ).run(
      target.organizationId,
      target.ventureId,
      createHash("sha256").update(binding).digest("hex"),
      binding,
      adoptedJson(row.variant_json, target, "creative variant"),
      LEGACY_UNSCOPED_ORGANIZATION_ID,
      row.venture_id,
      row.creative_id,
    );
  }
  for (const row of rows.deliveries) {
    const target = resolution.targets.get(row.venture_id as string)!;
    db.prepare(
      `UPDATE creative_delivery_variants SET organization_id = ?, venture_id = ?,
       registration_binding = ?, delivery_json = ?
       WHERE organization_id = ? AND venture_id = ? AND delivery_variant_id = ?`,
    ).run(
      target.organizationId,
      target.ventureId,
      adoptedBinding(row.registration_binding, target, "creative delivery registration"),
      adoptedJson(row.delivery_json, target, "creative delivery"),
      LEGACY_UNSCOPED_ORGANIZATION_ID,
      row.venture_id,
      row.delivery_variant_id,
    );
  }
  for (const row of rows.providers) {
    const target = resolution.targets.get(row.venture_id as string)!;
    db.prepare(
      `UPDATE creative_provider_objects SET organization_id = ?, venture_id = ?, record_json = ?
       WHERE organization_id = ? AND venture_id = ? AND provider = ? AND object_kind = ?
         AND external_id = ?`,
    ).run(
      target.organizationId,
      target.ventureId,
      adoptedJson(row.record_json, target, "creative provider mapping"),
      LEGACY_UNSCOPED_ORGANIZATION_ID,
      row.venture_id,
      row.provider,
      row.object_kind,
      row.external_id,
    );
  }
  for (const row of rows.statuses) {
    const target = resolution.targets.get(row.venture_id as string)!;
    const safeStatus = safeStatusAfterAdoption(row);
    db.prepare(
      `UPDATE creative_status_current SET organization_id = ?, venture_id = ?,
       status = ?, updated_at = ?
       WHERE organization_id = ? AND venture_id = ? AND creative_id = ? AND network = ?`,
    ).run(
      target.organizationId,
      target.ventureId,
      safeStatus,
      safeStatus === row.status ? row.updated_at : resolution.approvedAt,
      LEGACY_UNSCOPED_ORGANIZATION_ID,
      row.venture_id,
      row.creative_id,
      row.network,
    );
  }
  for (const row of rows.history) {
    const target = resolution.targets.get(row.venture_id as string)!;
    db.prepare(
      `UPDATE creative_status_history SET organization_id = ?, venture_id = ?
       WHERE sequence = ? AND organization_id = ?`,
    ).run(target.organizationId, target.ventureId, row.sequence, LEGACY_UNSCOPED_ORGANIZATION_ID);
  }
  const putInvalidation = db.prepare(
    `INSERT INTO creative_status_history (
      organization_id, venture_id, creative_id, network, from_status, to_status,
      recorded_at, reason_code, authority_ref
    ) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const row of rows.statuses) {
    const safeStatus = safeStatusAfterAdoption(row);
    if (safeStatus === row.status) continue;
    const target = resolution.targets.get(row.venture_id as string)!;
    putInvalidation.run(
      target.organizationId,
      target.ventureId,
      row.creative_id,
      row.network,
      row.status,
      safeStatus,
      resolution.approvedAt,
      LEGACY_ADOPTION_INVALIDATION_REASON,
      resolution.authorityRef,
    );
  }
  db.exec(LEDGER_SCHEMA);
}

function migrateLegacyLedger(db: SqliteDatabase, options: LegacyAdoptionOptions): void {
  assertLegacyTenantAdoptionJournalCompatibility(
    db,
    options.legacyAdoption,
    "creative ledger store",
  );
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'creative_variants'")
    .get();
  if (!tableExists) return;
  const scoped = tableHasColumn(db, "creative_variants", "organization_id");
  const rows = readLedgerRows(db, "", scoped ? LEGACY_UNSCOPED_ORGANIZATION_ID : undefined);
  if (scoped && ledgerVentureIds(rows).length === 0) return;
  const legacyVentureIds = ledgerVentureIds(rows);

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    const resolution =
      legacyVentureIds.length > 0
        ? recordLegacyTenantAdoptions(
            db,
            legacyVentureIds,
            options.legacyAdoption,
            "creative ledger store",
          )
        : undefined;
    if (scoped) {
      adoptSentinelLedgerRows(db, rows, resolution!);
    } else {
      db.exec(`
        ALTER TABLE creative_variants RENAME TO creative_variants_legacy_unscoped;
        ALTER TABLE creative_delivery_variants RENAME TO creative_delivery_variants_legacy_unscoped;
        ALTER TABLE creative_provider_objects RENAME TO creative_provider_objects_legacy_unscoped;
        ALTER TABLE creative_status_current RENAME TO creative_status_current_legacy_unscoped;
        ALTER TABLE creative_status_history RENAME TO creative_status_history_legacy_unscoped;
        DROP INDEX IF EXISTS creative_variants_lineage;
        DROP INDEX IF EXISTS creative_provider_objects_by_creative;
        DROP INDEX IF EXISTS creative_status_history_ordered;
      `);
      dropLedgerGuards(db);
      db.exec(LEDGER_SCHEMA);
      if (resolution) insertAdoptedLedgerRows(db, rows, resolution);
      db.exec(`
        DROP TABLE creative_status_history_legacy_unscoped;
        DROP TABLE creative_status_current_legacy_unscoped;
        DROP TABLE creative_provider_objects_legacy_unscoped;
        DROP TABLE creative_delivery_variants_legacy_unscoped;
        DROP TABLE creative_variants_legacy_unscoped;
      `);
    }
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length > 0) {
      throw new Error("creative ledger legacy adoption violates tenant-scoped relationships");
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* transaction already closed */
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function parseVariant(row: Record<string, unknown>): CreativeVariant {
  return freezeVariant(JSON.parse(row.variant_json as string) as CreativeVariant);
}

function parseDelivery(row: Record<string, unknown>): DeliveryVariant {
  return freezeDeliveryVariant(JSON.parse(row.delivery_json as string) as DeliveryVariant);
}

function parseProviderObject(row: Record<string, unknown>): CreativeProviderObject {
  return freezeProviderObject({
    ...(JSON.parse(row.record_json as string) as CreativeProviderObject),
    organizationId: row.organization_id as string,
    ventureId: row.venture_id as string,
  });
}

function parseHistory(row: Record<string, unknown>): CreativeStatusHistoryEntry {
  return Object.freeze({
    sequence: Number(row.sequence),
    organizationId: row.organization_id as string,
    ventureId: row.venture_id as string,
    creativeId: row.creative_id as string,
    network: row.network as CreativeNetwork,
    fromStatus: (row.from_status as CreativeStatus | null) ?? null,
    toStatus: row.to_status as CreativeStatus,
    recordedAt: row.recorded_at as string,
    reasonCode: (row.reason_code as string | null) ?? null,
    authorityRef: (row.authority_ref as string | null) ?? null,
  });
}

export function createSqliteCreativeLedgerStore(
  filename: string,
  options: LegacyAdoptionOptions = {},
): CreativeLedgerStore {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(filename);
  try {
    initializeSqliteWal(db, { label: "creative ledger store" });
    migrateLegacyLedger(db, options);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(LEDGER_SCHEMA);
    ensureLedgerHistoryMetadataColumns(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const variantRow = (scope: CreativeLedgerScope, creativeId: string) => {
    assertScope(scope);
    return db
      .prepare(
        `SELECT * FROM creative_variants
         WHERE organization_id = ? AND venture_id = ? AND creative_id = ?`,
      )
      .get(scope.organizationId, scope.ventureId, creativeId) as
      Record<string, unknown> | undefined;
  };

  return {
    label: "sqlite",
    durable: true,
    putVariant(input) {
      const scope = { organizationId: input.organizationId, ventureId: input.ventureId };
      assertScope(scope);
      db.exec("BEGIN IMMEDIATE");
      try {
        const byId = variantRow(scope, input.variant.creativeId);
        if (byId) {
          db.exec("ROLLBACK");
          return byId.registration_key === input.registrationKey &&
            byId.registration_binding === input.registrationBinding
            ? { kind: "replay", value: parseVariant(byId) }
            : { kind: "conflict", reason: "creative id is already bound to different material" };
        }
        const byRegistration = db
          .prepare(
            `SELECT * FROM creative_variants
             WHERE organization_id = ? AND venture_id = ? AND registration_key = ?`,
          )
          .get(input.organizationId, input.ventureId, input.registrationKey) as
          Record<string, unknown> | undefined;
        if (byRegistration) {
          db.exec("ROLLBACK");
          return byRegistration.registration_binding === input.registrationBinding
            ? { kind: "replay", value: parseVariant(byRegistration) }
            : {
                kind: "conflict",
                reason: "creative registration key is already bound to different material",
              };
        }

        db.prepare(
          `INSERT INTO creative_variants
           (organization_id, venture_id, creative_id, registration_key, registration_binding,
            content_fingerprint, content_fingerprint_version,
            derived_from_creative_id, platform_variant_of_creative_id,
            variant_json, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          input.organizationId,
          input.ventureId,
          input.variant.creativeId,
          input.registrationKey,
          input.registrationBinding,
          input.variant.contentFingerprint,
          input.variant.contentFingerprintVersion,
          input.variant.derivedFromCreativeId,
          input.variant.platformVariantOfCreativeId,
          JSON.stringify(input.variant),
          input.variant.createdAt,
        );
        for (const network of CREATIVE_NETWORKS) {
          db.prepare(
            `INSERT INTO creative_status_current
             (organization_id, venture_id, creative_id, network, status, updated_at)
             VALUES (?,?,?,?,'DRAFT',?)`,
          ).run(
            input.organizationId,
            input.ventureId,
            input.variant.creativeId,
            network,
            input.variant.createdAt,
          );
          db.prepare(
            `INSERT INTO creative_status_history
             (organization_id, venture_id, creative_id, network, from_status, to_status, recorded_at)
             VALUES (?,?,?,?,NULL,'DRAFT',?)`,
          ).run(
            input.organizationId,
            input.ventureId,
            input.variant.creativeId,
            network,
            input.variant.createdAt,
          );
        }
        db.exec("COMMIT");
        return { kind: "created", value: freezeVariant(input.variant) };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* transaction already closed */
        }
        throw error;
      }
    },
    getVariant(scope, creativeId) {
      const row = variantRow(scope, creativeId);
      return row ? parseVariant(row) : undefined;
    },
    getVariantRegistrationBinding(scope, creativeId) {
      return variantRow(scope, creativeId)?.registration_binding as string | undefined;
    },
    hasCreative(scope, creativeId) {
      return Boolean(variantRow(scope, creativeId));
    },
    listVariants(scope) {
      assertScope(scope);
      return Object.freeze(
        (
          db
            .prepare(
              `SELECT * FROM creative_variants
               WHERE organization_id = ? AND venture_id = ? ORDER BY created_at, rowid`,
            )
            .all(scope.organizationId, scope.ventureId) as Record<string, unknown>[]
        ).map(parseVariant),
      );
    },
    putDeliveryVariant(scope, binding, variant) {
      assertScope(scope);
      db.exec("BEGIN IMMEDIATE");
      try {
        const byId = db
          .prepare(
            `SELECT * FROM creative_delivery_variants
             WHERE organization_id = ? AND venture_id = ? AND delivery_variant_id = ?`,
          )
          .get(scope.organizationId, scope.ventureId, variant.deliveryVariantId) as
          Record<string, unknown> | undefined;
        if (byId) {
          db.exec("ROLLBACK");
          return byId.registration_binding === binding
            ? { kind: "replay", value: parseDelivery(byId) }
            : { kind: "conflict", reason: "delivery variant id is already bound" };
        }
        const byRegistration = db
          .prepare(
            `SELECT * FROM creative_delivery_variants
             WHERE organization_id = ? AND venture_id = ?
               AND creative_id = ? AND delivery_fingerprint = ?`,
          )
          .get(
            scope.organizationId,
            scope.ventureId,
            variant.creativeId,
            variant.deliveryFingerprint,
          ) as Record<string, unknown> | undefined;
        if (byRegistration) {
          db.exec("ROLLBACK");
          return byRegistration.registration_binding === binding
            ? { kind: "replay", value: parseDelivery(byRegistration) }
            : { kind: "conflict", reason: "delivery fingerprint is already bound" };
        }
        db.prepare(
          `INSERT INTO creative_delivery_variants
           (organization_id, venture_id, delivery_variant_id, creative_id, delivery_fingerprint,
            registration_binding, delivery_json, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        ).run(
          scope.organizationId,
          scope.ventureId,
          variant.deliveryVariantId,
          variant.creativeId,
          variant.deliveryFingerprint,
          binding,
          JSON.stringify(variant),
          variant.createdAt,
        );
        db.exec("COMMIT");
        return { kind: "created", value: freezeDeliveryVariant(variant) };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* transaction already closed */
        }
        throw error;
      }
    },
    getDeliveryVariant(scope, deliveryVariantId) {
      assertScope(scope);
      const row = db
        .prepare(
          `SELECT * FROM creative_delivery_variants
           WHERE organization_id = ? AND venture_id = ? AND delivery_variant_id = ?`,
        )
        .get(scope.organizationId, scope.ventureId, deliveryVariantId) as
        Record<string, unknown> | undefined;
      return row ? parseDelivery(row) : undefined;
    },
    listDeliveryVariants(scope, creativeId) {
      assertScope(scope);
      return Object.freeze(
        (
          db
            .prepare(
              `SELECT * FROM creative_delivery_variants
               WHERE organization_id = ? AND venture_id = ? AND creative_id = ?
               ORDER BY created_at, delivery_variant_id`,
            )
            .all(scope.organizationId, scope.ventureId, creativeId) as Record<string, unknown>[]
        ).map(parseDelivery),
      );
    },
    putProviderObject(record) {
      const scope = { organizationId: record.organizationId, ventureId: record.ventureId };
      assertScope(scope);
      if (!variantRow(scope, record.creativeId)) {
        return { kind: "conflict", reason: "provider object creative does not exist" };
      }
      if (
        record.deliveryVariantId !== null &&
        !db
          .prepare(
            `SELECT 1 FROM creative_delivery_variants
             WHERE organization_id = ? AND venture_id = ? AND creative_id = ?
               AND delivery_variant_id = ?`,
          )
          .get(record.organizationId, record.ventureId, record.creativeId, record.deliveryVariantId)
      ) {
        return {
          kind: "conflict",
          reason: "provider object delivery variant belongs to a different creative",
        };
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(
            `SELECT * FROM creative_provider_objects
             WHERE organization_id = ? AND venture_id = ?
               AND provider = ? AND object_kind = ? AND external_id = ?`,
          )
          .get(
            record.organizationId,
            record.ventureId,
            record.provider,
            record.objectKind,
            record.externalId,
          ) as Record<string, unknown> | undefined;
        if (row) {
          const existing = parseProviderObject(row);
          db.exec("ROLLBACK");
          return providerBinding(existing) === providerBinding(record)
            ? { kind: "replay", value: existing }
            : { kind: "conflict", reason: "provider object is already bound" };
        }
        db.prepare(
          `INSERT INTO creative_provider_objects
           (organization_id, venture_id, provider, object_kind, external_id, creative_id,
            delivery_variant_id, external_account_id, record_json, recorded_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          record.organizationId,
          record.ventureId,
          record.provider,
          record.objectKind,
          record.externalId,
          record.creativeId,
          record.deliveryVariantId,
          record.externalAccountId,
          JSON.stringify(record),
          record.recordedAt,
        );
        db.exec("COMMIT");
        return { kind: "created", value: freezeProviderObject(record) };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* transaction already closed */
        }
        throw error;
      }
    },
    resolveProviderObject(scope, provider, objectKind, externalId) {
      assertScope(scope);
      const row = db
        .prepare(
          `SELECT * FROM creative_provider_objects
           WHERE organization_id = ? AND venture_id = ?
             AND provider = ? AND object_kind = ? AND external_id = ?`,
        )
        .get(scope.organizationId, scope.ventureId, provider, objectKind, externalId) as
        Record<string, unknown> | undefined;
      return row ? parseProviderObject(row) : undefined;
    },
    listProviderObjects(scope, creativeId) {
      assertScope(scope);
      return Object.freeze(
        (
          db
            .prepare(
              `SELECT * FROM creative_provider_objects
               WHERE organization_id = ? AND venture_id = ? AND creative_id = ?
               ORDER BY recorded_at, external_id`,
            )
            .all(scope.organizationId, scope.ventureId, creativeId) as Record<string, unknown>[]
        ).map(parseProviderObject),
      );
    },
    getStatus(scope, creativeId, network) {
      assertScope(scope);
      const row = db
        .prepare(
          `SELECT status FROM creative_status_current
           WHERE organization_id = ? AND venture_id = ? AND creative_id = ? AND network = ?`,
        )
        .get(scope.organizationId, scope.ventureId, creativeId, network) as
        { status: CreativeStatus } | undefined;
      return row?.status;
    },
    transitionStatus(input) {
      const scope = { organizationId: input.organizationId, ventureId: input.ventureId };
      assertScope(scope);
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(
            `SELECT status FROM creative_status_current
             WHERE organization_id = ? AND venture_id = ? AND creative_id = ? AND network = ?`,
          )
          .get(input.organizationId, input.ventureId, input.creativeId, input.network) as
          { status: CreativeStatus } | undefined;
        if (row?.status === input.next) {
          db.exec("ROLLBACK");
          return { kind: "replay", status: row.status };
        }
        if (row?.status !== input.expected) {
          db.exec("ROLLBACK");
          return { kind: "conflict", current: row?.status };
        }
        const result = db
          .prepare(
            `UPDATE creative_status_current SET status = ?, updated_at = ?
             WHERE organization_id = ? AND venture_id = ?
               AND creative_id = ? AND network = ? AND status = ?`,
          )
          .run(
            input.next,
            input.recordedAt,
            input.organizationId,
            input.ventureId,
            input.creativeId,
            input.network,
            input.expected,
          );
        if (result.changes !== 1) {
          db.exec("ROLLBACK");
          const currentRow = db
            .prepare(
              `SELECT status FROM creative_status_current
               WHERE organization_id = ? AND venture_id = ? AND creative_id = ? AND network = ?`,
            )
            .get(input.organizationId, input.ventureId, input.creativeId, input.network) as
            { status: CreativeStatus } | undefined;
          const current = currentRow?.status;
          return { kind: "conflict", current };
        }
        db.prepare(
          `INSERT INTO creative_status_history
           (organization_id, venture_id, creative_id, network, from_status, to_status, recorded_at)
           VALUES (?,?,?,?,?,?,?)`,
        ).run(
          input.organizationId,
          input.ventureId,
          input.creativeId,
          input.network,
          input.expected,
          input.next,
          input.recordedAt,
        );
        db.exec("COMMIT");
        return { kind: "created", status: input.next };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* transaction already closed */
        }
        throw error;
      }
    },
    listStatusHistory(scope, creativeId, network) {
      assertScope(scope);
      const rows = (
        network === undefined
          ? db
              .prepare(
                `SELECT * FROM creative_status_history
                 WHERE organization_id = ? AND venture_id = ? AND creative_id = ?
                 ORDER BY sequence`,
              )
              .all(scope.organizationId, scope.ventureId, creativeId)
          : db
              .prepare(
                `SELECT * FROM creative_status_history
                 WHERE organization_id = ? AND venture_id = ?
                   AND creative_id = ? AND network = ? ORDER BY sequence`,
              )
              .all(scope.organizationId, scope.ventureId, creativeId, network)
      ) as Record<string, unknown>[];
      return Object.freeze(rows.map(parseHistory));
    },
    close() {
      db.close();
    },
  };
}
