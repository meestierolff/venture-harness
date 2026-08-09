import { createHash } from "node:crypto";
import { findCredentialMaterial, tenantKey } from "@venture-harness/core";

export const LEGACY_UNSCOPED_ORGANIZATION_ID = "__legacy_unscoped__";

export interface LegacyTenantTarget {
  readonly organizationId: string;
  readonly ventureId: string;
}

export interface LegacyTenantAdoptionEntry extends LegacyTenantTarget {
  readonly legacyVentureId: string;
}

export interface TrustedLegacyTenantAdoptionMapping {
  readonly contractVersion: 1;
  readonly ownershipVerification: "verified_out_of_band";
  readonly authorizationDisposition: "invalidate_and_require_reapproval";
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly mappings: readonly LegacyTenantAdoptionEntry[];
}

export interface LegacyAdoptionOptions {
  readonly legacyAdoption?: TrustedLegacyTenantAdoptionMapping;
}

export interface LegacyTenantAdoptionJournalResolution {
  readonly targets: ReadonlyMap<string, LegacyTenantTarget>;
  readonly approvalHash: string;
  readonly mappingHash: string;
  readonly authorityRef: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

interface LegacyAdoptionSqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

/** Minimal structural contract shared by every SQLite-backed adoption store. */
export interface LegacyAdoptionSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): LegacyAdoptionSqliteStatement;
}

export class LegacyTenantAdoptionError extends Error {
  constructor(
    readonly code:
      | "legacy_tenant_mapping_required"
      | "legacy_tenant_mapping_incomplete"
      | "invalid_legacy_tenant_mapping"
      | "legacy_sentinel_scope_forbidden"
      | "legacy_tenant_mapping_conflict"
      | "legacy_tenant_adoption_journal_invalid",
    message: string,
  ) {
    super(message);
    this.name = "LegacyTenantAdoptionError";
  }
}

export const LEGACY_ADOPTION_INVALIDATION_REASON = "legacy_tenant_adoption_invalidation" as const;

const LEGACY_ADOPTION_JOURNAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS legacy_tenant_adoptions (
  legacy_organization_id TEXT NOT NULL,
  legacy_venture_id TEXT NOT NULL,
  target_organization_id TEXT NOT NULL,
  target_venture_id TEXT NOT NULL,
  approval_json TEXT NOT NULL,
  approval_hash TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  mapping_hash TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  CHECK (legacy_organization_id = '${LEGACY_UNSCOPED_ORGANIZATION_ID}'),
  PRIMARY KEY (legacy_organization_id, legacy_venture_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS legacy_tenant_adoptions_target
  ON legacy_tenant_adoptions(target_organization_id, target_venture_id);
CREATE TRIGGER IF NOT EXISTS legacy_tenant_adoptions_immutable
  BEFORE UPDATE ON legacy_tenant_adoptions BEGIN
    SELECT RAISE(ABORT, 'legacy tenant adoptions are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS legacy_tenant_adoptions_permanent
  BEFORE DELETE ON legacy_tenant_adoptions BEGIN
    SELECT RAISE(ABORT, 'legacy tenant adoptions are permanent');
  END;
`;

const JOURNAL_COLUMNS = [
  "legacy_organization_id",
  "legacy_venture_id",
  "target_organization_id",
  "target_venture_id",
  "approval_json",
  "approval_hash",
  "mapping_json",
  "mapping_hash",
  "approved_at",
  "recorded_at",
] as const;

function assertCanonical(value: string, field: string): void {
  try {
    tenantKey({ organizationId: value, ventureId: "legacy-adoption-validation" });
  } catch {
    throw new LegacyTenantAdoptionError(
      "invalid_legacy_tenant_mapping",
      `${field} must be a canonical tenant identifier`,
    );
  }
}

function assertCredentialSafeIdentifier(value: unknown, field: string): asserts value is string {
  if (findCredentialMaterial(value)) {
    throw new LegacyTenantAdoptionError(
      "invalid_legacy_tenant_mapping",
      `${field} contains forbidden credential-like material`,
    );
  }
}

function assertJournalCredentialSafeIdentifiers(
  row: Record<string, unknown>,
  storeLabel: string,
): void {
  try {
    const approval = JSON.parse(row.approval_json as string) as Record<string, unknown>;
    const mapping = JSON.parse(row.mapping_json as string) as Record<string, unknown>;
    const mappings = Array.isArray(mapping.mappings) ? mapping.mappings : [];
    const identities = {
      legacyOrganizationId: row.legacy_organization_id,
      legacyVentureId: row.legacy_venture_id,
      targetOrganizationId: row.target_organization_id,
      targetVentureId: row.target_venture_id,
      approvedBy: approval.approvedBy,
      mappings: mappings.map((entry) => {
        const candidate = entry as Record<string, unknown>;
        return {
          legacyOrganizationId: candidate.legacyOrganizationId,
          legacyVentureId: candidate.legacyVentureId,
          targetOrganizationId: candidate.targetOrganizationId,
          targetVentureId: candidate.targetVentureId,
        };
      }),
    };
    if (findCredentialMaterial(identities)) throw new Error("credential-like identity");
  } catch {
    throw new LegacyTenantAdoptionError(
      "legacy_tenant_adoption_journal_invalid",
      `${storeLabel} legacy adoption journal contains invalid or credential-like identity material; stop and repair the journal before adoption`,
    );
  }
}

export function assertAddressableTenantScope(scope: LegacyTenantTarget, label: string): void {
  assertCredentialSafeIdentifier(scope.organizationId, `${label} organizationId`);
  assertCredentialSafeIdentifier(scope.ventureId, `${label} ventureId`);
  assertCanonical(scope.organizationId, `${label} organizationId`);
  assertCanonical(scope.ventureId, `${label} ventureId`);
  if (scope.organizationId === LEGACY_UNSCOPED_ORGANIZATION_ID) {
    throw new LegacyTenantAdoptionError(
      "legacy_sentinel_scope_forbidden",
      `${label} may not address the legacy unscoped sentinel`,
    );
  }
}

/**
 * Builds the only accepted legacy adoption authority. Creating this value is an
 * explicit assertion that ownership was verified outside the database and that
 * any authorization material crossing the identity boundary will be invalidated.
 */
export function createTrustedLegacyTenantAdoptionMapping(
  input: Omit<TrustedLegacyTenantAdoptionMapping, "contractVersion">,
): TrustedLegacyTenantAdoptionMapping {
  const approvedAt = new Date(input.approvedAt);
  if (
    input.ownershipVerification !== "verified_out_of_band" ||
    input.authorizationDisposition !== "invalidate_and_require_reapproval" ||
    !Number.isFinite(approvedAt.getTime()) ||
    approvedAt.toISOString() !== input.approvedAt ||
    input.mappings.length === 0
  ) {
    throw new LegacyTenantAdoptionError(
      "invalid_legacy_tenant_mapping",
      "legacy adoption requires verified ownership, an approver, a timestamp, and fail-closed reapproval",
    );
  }
  assertCredentialSafeIdentifier(input.approvedBy, "approvedBy");
  assertCanonical(input.approvedBy, "approvedBy");
  const seen = new Set<string>();
  const targets = new Set<string>();
  const mappings = input.mappings.map((entry) => {
    assertCredentialSafeIdentifier(entry.legacyVentureId, "legacyVentureId");
    assertCredentialSafeIdentifier(entry.organizationId, "legacy adoption target organizationId");
    assertCredentialSafeIdentifier(entry.ventureId, "legacy adoption target ventureId");
    assertCanonical(entry.legacyVentureId, "legacyVentureId");
    assertAddressableTenantScope(entry, "legacy adoption target");
    if (seen.has(entry.legacyVentureId)) {
      throw new LegacyTenantAdoptionError(
        "invalid_legacy_tenant_mapping",
        `legacy venture ${entry.legacyVentureId} is mapped more than once`,
      );
    }
    seen.add(entry.legacyVentureId);
    const targetKey = tenantKey(entry);
    if (targets.has(targetKey)) {
      throw new LegacyTenantAdoptionError(
        "invalid_legacy_tenant_mapping",
        `multiple legacy ventures may not merge into adoption target ${targetKey}`,
      );
    }
    targets.add(targetKey);
    return Object.freeze({ ...entry });
  });
  return Object.freeze({
    contractVersion: 1,
    ownershipVerification: input.ownershipVerification,
    authorizationDisposition: input.authorizationDisposition,
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
    mappings: Object.freeze(mappings),
  });
}

function validateLegacyTenantAdoptionMapping(
  mapping: TrustedLegacyTenantAdoptionMapping,
): TrustedLegacyTenantAdoptionMapping {
  if (mapping.contractVersion !== 1) {
    throw new LegacyTenantAdoptionError(
      "invalid_legacy_tenant_mapping",
      "legacy adoption received an unsupported contract version",
    );
  }
  return createTrustedLegacyTenantAdoptionMapping({
    ownershipVerification: mapping.ownershipVerification,
    authorizationDisposition: mapping.authorizationDisposition,
    approvedBy: mapping.approvedBy,
    approvedAt: mapping.approvedAt,
    mappings: mapping.mappings,
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function journalBindings(mapping: TrustedLegacyTenantAdoptionMapping): {
  approvalJson: string;
  approvalHash: string;
  mappingJson: string;
  mappingHash: string;
  authorityRef: string;
} {
  const approvalJson = JSON.stringify({
    contractVersion: mapping.contractVersion,
    ownershipVerification: mapping.ownershipVerification,
    authorizationDisposition: mapping.authorizationDisposition,
    approvedBy: mapping.approvedBy,
    approvedAt: mapping.approvedAt,
  });
  const approvalHash = hash(approvalJson);
  const mappingJson = JSON.stringify({
    approvalHash,
    mappings: [...mapping.mappings]
      .sort((left, right) => left.legacyVentureId.localeCompare(right.legacyVentureId))
      .map((entry) => ({
        legacyOrganizationId: LEGACY_UNSCOPED_ORGANIZATION_ID,
        legacyVentureId: entry.legacyVentureId,
        targetOrganizationId: entry.organizationId,
        targetVentureId: entry.ventureId,
      })),
  });
  const mappingHash = hash(mappingJson);
  return {
    approvalJson,
    approvalHash,
    mappingJson,
    mappingHash,
    authorityRef: `audit://legacy-tenant-adoption/${mappingHash}`,
  };
}

function journalTableExists(db: LegacyAdoptionSqliteDatabase): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'legacy_tenant_adoptions'",
      )
      .get(),
  );
}

function assertJournalSchema(db: LegacyAdoptionSqliteDatabase, storeLabel: string): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(legacy_tenant_adoptions)").all() as Record<string, unknown>[]
    ).map((entry) => entry.name),
  );
  const missing = JOURNAL_COLUMNS.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new LegacyTenantAdoptionError(
      "legacy_tenant_adoption_journal_invalid",
      `${storeLabel} legacy adoption journal is missing ${missing.join(", ")}; stop and repair the journal schema before adoption`,
    );
  }
  const targetIndex = (
    db.prepare("PRAGMA index_list(legacy_tenant_adoptions)").all() as Record<string, unknown>[]
  ).find((entry) => entry.name === "legacy_tenant_adoptions_target" && Number(entry.unique) === 1);
  const targetColumns = targetIndex
    ? (
        db.prepare("PRAGMA index_info(legacy_tenant_adoptions_target)").all() as Record<
          string,
          unknown
        >[]
      ).map((entry) => entry.name)
    : [];
  if (
    targetColumns.length !== 2 ||
    targetColumns[0] !== "target_organization_id" ||
    targetColumns[1] !== "target_venture_id"
  ) {
    throw new LegacyTenantAdoptionError(
      "legacy_tenant_adoption_journal_invalid",
      `${storeLabel} legacy adoption journal lacks its unique target binding; stop and repair the journal index before adoption`,
    );
  }
  const rows = db.prepare("SELECT * FROM legacy_tenant_adoptions").all() as Record<
    string,
    unknown
  >[];
  for (const row of rows) assertJournalCredentialSafeIdentifiers(row, storeLabel);
}

interface JournalExpectation {
  readonly legacyVentureId: string;
  readonly target: LegacyTenantTarget;
  readonly approvalJson: string;
  readonly approvalHash: string;
  readonly mappingJson: string;
  readonly mappingHash: string;
  readonly approvedAt: string;
}

function assertJournalRow(
  row: Record<string, unknown>,
  expected: JournalExpectation,
  storeLabel: string,
): void {
  const exact =
    row.legacy_organization_id === LEGACY_UNSCOPED_ORGANIZATION_ID &&
    row.legacy_venture_id === expected.legacyVentureId &&
    row.target_organization_id === expected.target.organizationId &&
    row.target_venture_id === expected.target.ventureId &&
    row.approval_json === expected.approvalJson &&
    row.approval_hash === expected.approvalHash &&
    row.mapping_json === expected.mappingJson &&
    row.mapping_hash === expected.mappingHash &&
    row.approved_at === expected.approvedAt &&
    row.recorded_at === expected.approvedAt;
  if (!exact) {
    throw new LegacyTenantAdoptionError(
      "legacy_tenant_mapping_conflict",
      `${storeLabel} legacy venture ${expected.legacyVentureId} is already bound to a different target or approval; reuse the exact recorded adoption authority or investigate the database before continuing`,
    );
  }
}

function expectationFor(
  entry: LegacyTenantAdoptionEntry,
  mapping: TrustedLegacyTenantAdoptionMapping,
): JournalExpectation {
  const bindings = journalBindings(mapping);
  return {
    legacyVentureId: entry.legacyVentureId,
    target: { organizationId: entry.organizationId, ventureId: entry.ventureId },
    approvalJson: bindings.approvalJson,
    approvalHash: bindings.approvalHash,
    mappingJson: bindings.mappingJson,
    mappingHash: bindings.mappingHash,
    approvedAt: mapping.approvedAt,
  };
}

/**
 * Checks a supplied authority against an existing shared journal even when the
 * calling store has no rows left to migrate. This makes conflicting restarts
 * fail closed instead of treating an already migrated table as unconstrained.
 */
export function assertLegacyTenantAdoptionJournalCompatibility(
  db: LegacyAdoptionSqliteDatabase,
  mapping: TrustedLegacyTenantAdoptionMapping | undefined,
  storeLabel: string,
): void {
  if (!mapping) return;
  const validated = validateLegacyTenantAdoptionMapping(mapping);
  if (!journalTableExists(db)) return;
  assertJournalSchema(db, storeLabel);
  for (const entry of validated.mappings) {
    const targetRow = db
      .prepare(
        `SELECT legacy_venture_id FROM legacy_tenant_adoptions
         WHERE target_organization_id = ? AND target_venture_id = ?`,
      )
      .get(entry.organizationId, entry.ventureId) as { legacy_venture_id: string } | undefined;
    if (targetRow && targetRow.legacy_venture_id !== entry.legacyVentureId) {
      throw new LegacyTenantAdoptionError(
        "legacy_tenant_mapping_conflict",
        `${storeLabel} adoption target ${tenantKey(entry)} is already bound to legacy venture ${targetRow.legacy_venture_id}; choose the recorded source mapping instead of merging legacy identities`,
      );
    }
    const row = db
      .prepare(
        `SELECT * FROM legacy_tenant_adoptions
         WHERE legacy_organization_id = ? AND legacy_venture_id = ?`,
      )
      .get(LEGACY_UNSCOPED_ORGANIZATION_ID, entry.legacyVentureId) as
      Record<string, unknown> | undefined;
    if (row) assertJournalRow(row, expectationFor(entry, validated), storeLabel);
  }
}

/**
 * Records the identity binding inside the caller's active BEGIN IMMEDIATE
 * transaction. The same transaction must also rewrite or remove the legacy
 * rows, so neither the journal nor the migrated data can commit alone.
 */
export function recordLegacyTenantAdoptions(
  db: LegacyAdoptionSqliteDatabase,
  requiredLegacyVentureIds: readonly string[],
  mapping: TrustedLegacyTenantAdoptionMapping | undefined,
  storeLabel: string,
): LegacyTenantAdoptionJournalResolution {
  const targets = resolveLegacyTenantAdoptions(requiredLegacyVentureIds, mapping, storeLabel);
  if (!mapping) {
    // resolveLegacyTenantAdoptions already rejects this when required ids exist.
    throw new LegacyTenantAdoptionError(
      "legacy_tenant_mapping_required",
      `${storeLabel} requires an explicit trusted adoption mapping`,
    );
  }
  const validated = validateLegacyTenantAdoptionMapping(mapping);
  const bindings = journalBindings(validated);
  db.exec(LEGACY_ADOPTION_JOURNAL_SCHEMA);
  assertJournalSchema(db, storeLabel);

  const required = new Set(requiredLegacyVentureIds);
  for (const entry of validated.mappings) {
    if (!required.has(entry.legacyVentureId)) continue;
    const expected = expectationFor(entry, validated);
    const targetRow = db
      .prepare(
        `SELECT legacy_venture_id FROM legacy_tenant_adoptions
         WHERE target_organization_id = ? AND target_venture_id = ?`,
      )
      .get(entry.organizationId, entry.ventureId) as { legacy_venture_id: string } | undefined;
    if (targetRow && targetRow.legacy_venture_id !== entry.legacyVentureId) {
      throw new LegacyTenantAdoptionError(
        "legacy_tenant_mapping_conflict",
        `${storeLabel} adoption target ${tenantKey(entry)} is already bound to legacy venture ${targetRow.legacy_venture_id}; choose the recorded source mapping instead of merging legacy identities`,
      );
    }
    db.prepare(
      `INSERT OR IGNORE INTO legacy_tenant_adoptions (
        legacy_organization_id, legacy_venture_id, target_organization_id, target_venture_id,
        approval_json, approval_hash, mapping_json, mapping_hash, approved_at, recorded_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      LEGACY_UNSCOPED_ORGANIZATION_ID,
      entry.legacyVentureId,
      entry.organizationId,
      entry.ventureId,
      expected.approvalJson,
      expected.approvalHash,
      expected.mappingJson,
      expected.mappingHash,
      expected.approvedAt,
      expected.approvedAt,
    );
    const row = db
      .prepare(
        `SELECT * FROM legacy_tenant_adoptions
         WHERE legacy_organization_id = ? AND legacy_venture_id = ?`,
      )
      .get(LEGACY_UNSCOPED_ORGANIZATION_ID, entry.legacyVentureId) as Record<string, unknown>;
    if (!row) {
      throw new LegacyTenantAdoptionError(
        "legacy_tenant_mapping_conflict",
        `${storeLabel} could not bind legacy venture ${entry.legacyVentureId} without merging an existing adoption target`,
      );
    }
    assertJournalRow(row, expected, storeLabel);
  }

  return Object.freeze({
    targets,
    approvalHash: bindings.approvalHash,
    mappingHash: bindings.mappingHash,
    authorityRef: bindings.authorityRef,
    approvedBy: validated.approvedBy,
    approvedAt: validated.approvedAt,
  });
}

export function resolveLegacyTenantAdoptions(
  requiredLegacyVentureIds: readonly string[],
  mapping: TrustedLegacyTenantAdoptionMapping | undefined,
  storeLabel: string,
): ReadonlyMap<string, LegacyTenantTarget> {
  for (const legacyVentureId of requiredLegacyVentureIds) {
    assertCredentialSafeIdentifier(legacyVentureId, "legacyVentureId");
    assertCanonical(legacyVentureId, "legacyVentureId");
  }
  const required = [...new Set(requiredLegacyVentureIds)].sort();
  if (required.length === 0) return new Map();
  if (!mapping) {
    throw new LegacyTenantAdoptionError(
      "legacy_tenant_mapping_required",
      `${storeLabel} contains legacy tenant rows; an explicit trusted adoption mapping is required`,
    );
  }
  // Re-run validation even when a structurally typed value did not come through
  // the factory. This keeps the runtime boundary fail closed.
  const validated = validateLegacyTenantAdoptionMapping(mapping);
  const byLegacy = new Map(
    validated.mappings.map((entry) => [
      entry.legacyVentureId,
      Object.freeze({ organizationId: entry.organizationId, ventureId: entry.ventureId }),
    ]),
  );
  const missing = required.filter((ventureId) => !byLegacy.has(ventureId));
  if (missing.length > 0) {
    throw new LegacyTenantAdoptionError(
      "legacy_tenant_mapping_incomplete",
      `${storeLabel} legacy tenant mapping is incomplete for: ${missing.join(", ")}`,
    );
  }
  return byLegacy;
}

function rewriteNestedScope(value: unknown, target: LegacyTenantTarget): unknown {
  if (Array.isArray(value)) return value.map((entry) => rewriteNestedScope(entry, target));
  if (value === null || typeof value !== "object") return value;
  const rewritten: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "organizationId" || key === "organization_id") {
      rewritten[key] = target.organizationId;
    } else if (key === "ventureId" || key === "venture_id") {
      rewritten[key] = target.ventureId;
    } else {
      rewritten[key] = rewriteNestedScope(entry, target);
    }
  }
  return rewritten;
}

/** Rewrites embedded scope and ensures an object payload carries the adopted scope. */
export function adoptLegacyTenantPayload<T>(payload: T, target: LegacyTenantTarget): T {
  assertAddressableTenantScope(target, "legacy adoption target");
  const rewritten = rewriteNestedScope(payload, target);
  if (rewritten !== null && typeof rewritten === "object" && !Array.isArray(rewritten)) {
    return {
      ...(rewritten as Record<string, unknown>),
      organizationId: target.organizationId,
      ventureId: target.ventureId,
    } as T;
  }
  return rewritten as T;
}
