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

export type CreativeUseMode = "organic" | "paid";
export type CreativeManifestChannel =
  "tiktok_organic" | "instagram_organic" | "youtube_organic" | "tiktok_paid" | "meta_paid";

export interface RightsEvidence {
  subjectId: string;
  evidenceRef: string;
  permitsOrganic: boolean;
  permitsPaid: boolean;
  permittedRegions: readonly string[];
  permittedChannels: readonly CreativeManifestChannel[];
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface MediaLicense extends RightsEvidence {
  assetId: string;
  licenseType: string;
}

export interface CreativeDisclosure {
  required: boolean;
  present: boolean;
  text: string | null;
  evidenceRef: string | null;
}

export interface CreativeManifestInput {
  organizationId: string;
  ventureId: string;
  creativeId: string;
  creativeFamilyId: string;
  hypothesis: string;
  scriptVersion: string;
  promptVersion: string;
  storyboardRef: string;
  sourceAssetIds: readonly string[];
  recordingRefs: readonly string[];
  avatarSource: string | null;
  voiceSource: string | null;
  mediaLicenses: readonly MediaLicense[];
  testimonialSubjectIds: readonly string[];
  testimonialConsents: readonly RightsEvidence[];
  creatorIds: readonly string[];
  creatorAuthorizations: readonly RightsEvidence[];
  aiGenerated: boolean;
  disclosure: CreativeDisclosure;
  permittedRegions: readonly string[];
  permittedChannels: readonly CreativeManifestChannel[];
  organicApproved: boolean;
  paidApproved: boolean;
  expiresAt: string;
  claims: readonly string[];
  prohibitedClaims: readonly string[];
  truthReferences: readonly string[];
  reviewedBy: string;
  reviewEventId: string;
  reviewedAt: string;
}

export interface CreativeManifest extends Readonly<CreativeManifestInput> {
  readonly manifestVersion: number;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly authorizationInvalidatedAt?: string | null;
  readonly authorizationInvalidationReason?: string | null;
  readonly authorizationAuthorityRef?: string | null;
}

export interface CreativeComplianceRequest {
  mode: CreativeUseMode;
  channel: CreativeManifestChannel;
  region: string;
  at: Date;
}

export interface CreativeCompliancePolicy {
  disclosureRequired: boolean;
  allowedRegions: readonly string[];
  allowedChannels: readonly CreativeManifestChannel[];
  prohibitedClaims: readonly string[];
}

export interface CreativeComplianceAssessment {
  readonly allowed: boolean;
  readonly blockers: readonly string[];
  readonly manifestVersion: number;
  readonly reviewEventId: string;
}

export interface CreativeManifestScope {
  readonly organizationId: string;
  readonly ventureId: string;
}

export interface CreativeManifestStore {
  readonly label: string;
  readonly durable: boolean;
  put(input: CreativeManifestInput): CreativeManifest;
  getCurrent(scope: CreativeManifestScope, creativeId: string): CreativeManifest | undefined;
  listHistory(scope: CreativeManifestScope, creativeId: string): readonly CreativeManifest[];
  revoke(input: {
    organizationId: string;
    ventureId: string;
    creativeId: string;
    reason: string;
    reviewedBy: string;
    reviewEventId: string;
    revokedAt: string;
  }): CreativeManifest;
  close(): void;
}

function freezeEvidence<T extends RightsEvidence>(entry: T): T {
  return Object.freeze({
    ...entry,
    permittedRegions: Object.freeze([...entry.permittedRegions]),
    permittedChannels: Object.freeze([...entry.permittedChannels]),
  }) as T;
}

function freezeManifest(manifest: CreativeManifest): CreativeManifest {
  return Object.freeze({
    ...manifest,
    authorizationInvalidatedAt: manifest.authorizationInvalidatedAt ?? null,
    authorizationInvalidationReason: manifest.authorizationInvalidationReason ?? null,
    authorizationAuthorityRef: manifest.authorizationAuthorityRef ?? null,
    sourceAssetIds: Object.freeze([...manifest.sourceAssetIds]),
    recordingRefs: Object.freeze([...manifest.recordingRefs]),
    mediaLicenses: Object.freeze(manifest.mediaLicenses.map(freezeEvidence)),
    testimonialSubjectIds: Object.freeze([...manifest.testimonialSubjectIds]),
    testimonialConsents: Object.freeze(manifest.testimonialConsents.map(freezeEvidence)),
    creatorIds: Object.freeze([...manifest.creatorIds]),
    creatorAuthorizations: Object.freeze(manifest.creatorAuthorizations.map(freezeEvidence)),
    disclosure: Object.freeze({ ...manifest.disclosure }),
    permittedRegions: Object.freeze([...manifest.permittedRegions]),
    permittedChannels: Object.freeze([...manifest.permittedChannels]),
    claims: Object.freeze([...manifest.claims]),
    prohibitedClaims: Object.freeze([...manifest.prohibitedClaims]),
    truthReferences: Object.freeze([...manifest.truthReferences]),
  });
}

function isEvidenceValid(evidence: RightsEvidence, request: CreativeComplianceRequest): boolean {
  if (evidence.revokedAt !== null) return false;
  if (!evidence.subjectId.trim() || !evidence.evidenceRef.trim()) return false;
  if (
    evidence.expiresAt !== null &&
    (!Number.isFinite(Date.parse(evidence.expiresAt)) || request.at >= new Date(evidence.expiresAt))
  ) {
    return false;
  }
  if (request.mode === "paid" ? !evidence.permitsPaid : !evidence.permitsOrganic) return false;
  return (
    evidence.permittedRegions.includes(request.region) &&
    evidence.permittedChannels.includes(request.channel)
  );
}

function assertManifestInput(input: CreativeManifestInput): void {
  // Incomplete reviews are still useful durable evidence. Only the storage key
  // is mandatory here; the compliance assessment below blocks every incomplete
  // or malformed rights dimension before an organic or paid effect.
  assertAddressableTenantScope(input, "creative manifest");
  if (!input.creativeId.trim()) {
    throw new Error("creative manifest organization, venture, and creative identity are required");
  }
}

function assertManifestScope(scope: CreativeManifestScope): void {
  assertAddressableTenantScope(scope, "creative manifest");
}

export function assessCreativeCompliance(
  manifest: CreativeManifest,
  request: CreativeComplianceRequest,
  policy?: CreativeCompliancePolicy,
): CreativeComplianceAssessment {
  const blockers: string[] = [];
  if (!manifest.reviewedBy.trim()) blockers.push("reviewer_missing");
  if (!manifest.reviewEventId.trim()) blockers.push("review_event_missing");
  if (!manifest.creativeFamilyId?.trim()) blockers.push("creative_family_missing");
  if (!manifest.hypothesis.trim()) blockers.push("hypothesis_missing");
  if (!manifest.scriptVersion.trim()) blockers.push("script_version_missing");
  if (!manifest.promptVersion.trim()) blockers.push("prompt_version_missing");
  if (!manifest.storyboardRef.trim()) blockers.push("storyboard_missing");
  if (
    manifest.truthReferences.length === 0 ||
    manifest.truthReferences.some((ref) => !ref.trim())
  ) {
    blockers.push("truth_reference_missing");
  }
  if (manifest.revokedAt !== null) blockers.push("manifest_revoked");
  if (manifest.authorizationInvalidatedAt != null) {
    blockers.push("manifest_authorization_invalidated");
  }
  const reviewedAt = Date.parse(manifest.reviewedAt);
  const expiresAt = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(reviewedAt)) blockers.push("review_timestamp_invalid");
  if (!Number.isFinite(expiresAt)) blockers.push("manifest_expiry_invalid");
  else if (request.at.getTime() >= expiresAt) blockers.push("manifest_expired");
  if (!manifest.permittedRegions.includes(request.region)) blockers.push("region_not_permitted");
  if (!manifest.permittedChannels.includes(request.channel)) blockers.push("channel_not_permitted");
  if (policy && !policy.allowedRegions.includes(request.region)) {
    blockers.push("policy_region_not_permitted");
  }
  if (policy && !policy.allowedChannels.includes(request.channel)) {
    blockers.push("policy_channel_not_permitted");
  }
  if (request.mode === "paid" ? !manifest.paidApproved : !manifest.organicApproved) {
    blockers.push(`${request.mode}_approval_missing`);
  }

  for (const assetId of manifest.sourceAssetIds) {
    const license = manifest.mediaLicenses.find((entry) => entry.assetId === assetId);
    if (!license) blockers.push(`license_missing:${assetId}`);
    else if (!license.licenseType.trim() || !isEvidenceValid(license, request)) {
      blockers.push(`license_invalid:${assetId}`);
    }
  }
  for (const subjectId of manifest.testimonialSubjectIds) {
    const consent = manifest.testimonialConsents.find((entry) => entry.subjectId === subjectId);
    if (!consent) blockers.push(`testimonial_consent_missing:${subjectId}`);
    else if (!isEvidenceValid(consent, request)) {
      blockers.push(`testimonial_consent_invalid:${subjectId}`);
    }
  }
  for (const creatorId of manifest.creatorIds) {
    const authorization = manifest.creatorAuthorizations.find(
      (entry) => entry.subjectId === creatorId,
    );
    if (!authorization) blockers.push(`creator_authorization_missing:${creatorId}`);
    else if (!isEvidenceValid(authorization, request)) {
      blockers.push(`creator_authorization_invalid:${creatorId}`);
    }
  }
  if (
    (manifest.aiGenerated || manifest.disclosure.required || policy?.disclosureRequired === true) &&
    (!manifest.disclosure.present ||
      !manifest.disclosure.text?.trim() ||
      !manifest.disclosure.evidenceRef?.trim())
  ) {
    blockers.push("disclosure_missing");
  }
  const prohibited = new Set(
    [...manifest.prohibitedClaims, ...(policy?.prohibitedClaims ?? [])].map((claim) =>
      claim.trim().toLowerCase(),
    ),
  );
  if (manifest.claims.some((claim) => prohibited.has(claim.trim().toLowerCase()))) {
    blockers.push("prohibited_claim_present");
  }

  return Object.freeze({
    allowed: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    manifestVersion: manifest.manifestVersion,
    reviewEventId: manifest.reviewEventId,
  });
}

export function createMemoryCreativeManifestStore(): CreativeManifestStore {
  const histories = new Map<string, CreativeManifest[]>();
  const reviewEvents = new Set<string>();
  const keyFor = (scope: CreativeManifestScope, creativeId: string) => {
    assertManifestScope(scope);
    return JSON.stringify([scope.organizationId, scope.ventureId, creativeId]);
  };

  const store: CreativeManifestStore = {
    label: "memory (test only)",
    durable: false,
    put(input) {
      assertManifestInput(input);
      const scope = { organizationId: input.organizationId, ventureId: input.ventureId };
      const key = keyFor(scope, input.creativeId);
      const reviewEventKey = JSON.stringify([
        scope.organizationId,
        scope.ventureId,
        input.reviewEventId,
      ]);
      const history = histories.get(key) ?? [];
      if (history.length > 0 && history.at(-1)!.revokedAt !== null) {
        throw new Error("a revoked creative manifest cannot be silently reactivated");
      }
      if (reviewEvents.has(reviewEventKey)) {
        throw new Error(`creative review event already recorded: ${input.reviewEventId}`);
      }
      const manifest = freezeManifest({
        ...input,
        manifestVersion: history.length + 1,
        revokedAt: null,
        revocationReason: null,
        authorizationInvalidatedAt: null,
        authorizationInvalidationReason: null,
        authorizationAuthorityRef: null,
      });
      histories.set(key, [...history, manifest]);
      reviewEvents.add(reviewEventKey);
      return manifest;
    },
    getCurrent(scope, creativeId) {
      return histories.get(keyFor(scope, creativeId))?.at(-1);
    },
    listHistory(scope, creativeId) {
      return Object.freeze([...(histories.get(keyFor(scope, creativeId)) ?? [])]);
    },
    revoke(input) {
      if (
        !input.reason.trim() ||
        !input.reviewedBy.trim() ||
        !input.reviewEventId.trim() ||
        !Number.isFinite(Date.parse(input.revokedAt))
      ) {
        throw new Error("creative manifest revocation evidence is incomplete");
      }
      const scope = { organizationId: input.organizationId, ventureId: input.ventureId };
      const current = store.getCurrent(scope, input.creativeId);
      if (!current) throw new Error(`unknown creative manifest ${input.creativeId}`);
      if (current.revokedAt !== null) return current;
      const key = keyFor(scope, input.creativeId);
      const reviewEventKey = JSON.stringify([
        scope.organizationId,
        scope.ventureId,
        input.reviewEventId,
      ]);
      if (reviewEvents.has(reviewEventKey)) {
        throw new Error(`creative review event already recorded: ${input.reviewEventId}`);
      }
      const next = freezeManifest({
        ...current,
        reviewedBy: input.reviewedBy,
        reviewEventId: input.reviewEventId,
        reviewedAt: input.revokedAt,
        manifestVersion: current.manifestVersion + 1,
        revokedAt: input.revokedAt,
        revocationReason: input.reason,
      });
      histories.set(key, [...(histories.get(key) ?? []), next]);
      reviewEvents.add(reviewEventKey);
      return next;
    },
    close() {},
  };
  return store;
}

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
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
    throw new Error(`creative manifest SQLite store unavailable: ${(error as Error).message}`);
  }
}

const MANIFEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS creative_manifests (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  creative_id TEXT NOT NULL,
  manifest_version INTEGER NOT NULL,
  review_event_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, creative_id, manifest_version),
  UNIQUE (organization_id, venture_id, review_event_id)
);
CREATE INDEX IF NOT EXISTS creative_manifest_current
  ON creative_manifests(organization_id, venture_id, creative_id, manifest_version DESC);
`;

function manifestTableHasOrganization(db: SqliteDatabase): boolean {
  return (
    db.prepare("PRAGMA table_info(creative_manifests)").all() as Record<string, unknown>[]
  ).some((entry) => entry.name === "organization_id");
}

function adoptedManifest(
  row: Record<string, unknown>,
  target: LegacyTenantTarget,
): CreativeManifest {
  const adopted = adoptLegacyTenantPayload(
    JSON.parse(row.manifest_json as string) as CreativeManifest,
    target,
  );
  return {
    ...adopted,
    authorizationInvalidatedAt: adopted.authorizationInvalidatedAt ?? null,
    authorizationInvalidationReason: adopted.authorizationInvalidationReason ?? null,
    authorizationAuthorityRef: adopted.authorizationAuthorityRef ?? null,
  };
}

function invalidatedEvidence<T extends RightsEvidence>(entry: T, approvedAt: string): T {
  return {
    ...entry,
    permitsOrganic: false,
    permitsPaid: false,
    permittedRegions: [],
    permittedChannels: [],
    revokedAt: entry.revokedAt ?? approvedAt,
  };
}

function adoptionInvalidationReviewEvent(
  resolution: LegacyTenantAdoptionJournalResolution,
  manifest: CreativeManifest,
): string {
  const subject = JSON.stringify([
    resolution.mappingHash,
    manifest.organizationId,
    manifest.ventureId,
    manifest.creativeId,
    manifest.manifestVersion + 1,
  ]);
  return `legacy-adoption-invalidation:${createHash("sha256").update(subject).digest("hex")}`;
}

function invalidateAdoptedManifest(
  manifest: CreativeManifest,
  resolution: LegacyTenantAdoptionJournalResolution,
): CreativeManifest {
  return {
    ...manifest,
    manifestVersion: manifest.manifestVersion + 1,
    mediaLicenses: manifest.mediaLicenses.map((entry) =>
      invalidatedEvidence(entry, resolution.approvedAt),
    ),
    testimonialConsents: manifest.testimonialConsents.map((entry) =>
      invalidatedEvidence(entry, resolution.approvedAt),
    ),
    creatorAuthorizations: manifest.creatorAuthorizations.map((entry) =>
      invalidatedEvidence(entry, resolution.approvedAt),
    ),
    permittedRegions: [],
    permittedChannels: [],
    organicApproved: false,
    paidApproved: false,
    reviewedBy: resolution.approvedBy,
    reviewEventId: adoptionInvalidationReviewEvent(resolution, manifest),
    reviewedAt: resolution.approvedAt,
    revokedAt: null,
    revocationReason: null,
    authorizationInvalidatedAt: resolution.approvedAt,
    authorizationInvalidationReason: LEGACY_ADOPTION_INVALIDATION_REASON,
    authorizationAuthorityRef: resolution.authorityRef,
  };
}

function currentLegacyManifests(
  rows: readonly Record<string, unknown>[],
  targets: ReadonlyMap<string, LegacyTenantTarget>,
): CreativeManifest[] {
  const current = new Map<string, CreativeManifest>();
  for (const row of rows) {
    const target = targets.get(row.venture_id as string)!;
    const manifest = adoptedManifest(row, target);
    const key = JSON.stringify([row.venture_id, row.creative_id]);
    const existing = current.get(key);
    if (!existing || manifest.manifestVersion > existing.manifestVersion) {
      current.set(key, manifest);
    }
  }
  return [...current.values()];
}

function migrateLegacyManifests(db: SqliteDatabase, options: LegacyAdoptionOptions): void {
  assertLegacyTenantAdoptionJournalCompatibility(
    db,
    options.legacyAdoption,
    "creative manifest store",
  );
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'creative_manifests'")
    .get();
  if (!exists) return;
  const scoped = manifestTableHasOrganization(db);
  const rows = db
    .prepare(`SELECT * FROM creative_manifests${scoped ? " WHERE organization_id = ?" : ""}`)
    .all(...(scoped ? [LEGACY_UNSCOPED_ORGANIZATION_ID] : [])) as Record<string, unknown>[];
  if (scoped && rows.length === 0) return;
  const legacyVentureIds = rows.map((row) => row.venture_id as string);
  try {
    db.exec("BEGIN IMMEDIATE");
    const resolution =
      legacyVentureIds.length > 0
        ? recordLegacyTenantAdoptions(
            db,
            legacyVentureIds,
            options.legacyAdoption,
            "creative manifest store",
          )
        : undefined;
    if (!scoped) {
      db.exec(`
        ALTER TABLE creative_manifests RENAME TO creative_manifests_legacy_unscoped;
        DROP INDEX IF EXISTS creative_manifest_current;
        ${MANIFEST_SCHEMA}
      `);
    }
    const insert = db.prepare(
      `INSERT INTO creative_manifests (
        organization_id, venture_id, creative_id, manifest_version, review_event_id,
        manifest_json, recorded_at
      ) VALUES (?,?,?,?,?,?,?)`,
    );
    for (const row of rows) {
      const target = resolution!.targets.get(row.venture_id as string)!;
      insert.run(
        target.organizationId,
        target.ventureId,
        row.creative_id,
        row.manifest_version,
        row.review_event_id,
        JSON.stringify(adoptedManifest(row, target)),
        row.recorded_at,
      );
    }
    if (resolution) {
      for (const manifest of currentLegacyManifests(rows, resolution.targets)) {
        const invalidated = invalidateAdoptedManifest(manifest, resolution);
        insert.run(
          invalidated.organizationId,
          invalidated.ventureId,
          invalidated.creativeId,
          invalidated.manifestVersion,
          invalidated.reviewEventId,
          JSON.stringify(invalidated),
          invalidated.reviewedAt,
        );
      }
    }
    if (scoped) {
      db.prepare("DELETE FROM creative_manifests WHERE organization_id = ?").run(
        LEGACY_UNSCOPED_ORGANIZATION_ID,
      );
    } else {
      db.exec("DROP TABLE creative_manifests_legacy_unscoped");
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* transaction already closed */
    }
    throw error;
  }
}

export function createSqliteCreativeManifestStore(
  filename: string,
  options: LegacyAdoptionOptions = {},
): CreativeManifestStore {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(filename);
  try {
    initializeSqliteWal(db, { label: "creative manifest store" });
    migrateLegacyManifests(db, options);
    db.exec(MANIFEST_SCHEMA);
  } catch (error) {
    db.close();
    throw error;
  }

  const parse = (row: Record<string, unknown>): CreativeManifest =>
    freezeManifest({
      ...(JSON.parse(row.manifest_json as string) as CreativeManifest),
      organizationId: row.organization_id as string,
      ventureId: row.venture_id as string,
    });
  const current = (
    scope: CreativeManifestScope,
    creativeId: string,
  ): CreativeManifest | undefined => {
    assertManifestScope(scope);
    const row = db
      .prepare(
        `SELECT organization_id, venture_id, manifest_json FROM creative_manifests
         WHERE organization_id = ? AND venture_id = ? AND creative_id = ?
         ORDER BY manifest_version DESC LIMIT 1`,
      )
      .get(scope.organizationId, scope.ventureId, creativeId) as
      Record<string, unknown> | undefined;
    return row ? parse(row) : undefined;
  };
  const append = (manifest: CreativeManifest): CreativeManifest => {
    db.prepare(
      `INSERT INTO creative_manifests
       (organization_id, venture_id, creative_id, manifest_version, review_event_id,
        manifest_json, recorded_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      manifest.organizationId,
      manifest.ventureId,
      manifest.creativeId,
      manifest.manifestVersion,
      manifest.reviewEventId,
      JSON.stringify(manifest),
      manifest.reviewedAt,
    );
    return manifest;
  };

  const store: CreativeManifestStore = {
    label: "sqlite",
    durable: true,
    put(input) {
      assertManifestInput(input);
      db.exec("BEGIN IMMEDIATE");
      try {
        const previous = current(
          { organizationId: input.organizationId, ventureId: input.ventureId },
          input.creativeId,
        );
        if (previous !== undefined && previous.revokedAt !== null) {
          throw new Error("a revoked creative manifest cannot be silently reactivated");
        }
        const manifest = freezeManifest({
          ...input,
          manifestVersion: (previous?.manifestVersion ?? 0) + 1,
          revokedAt: null,
          revocationReason: null,
          authorizationInvalidatedAt: null,
          authorizationInvalidationReason: null,
          authorizationAuthorityRef: null,
        });
        append(manifest);
        db.exec("COMMIT");
        return manifest;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* transaction already closed */
        }
        throw error;
      }
    },
    getCurrent: current,
    listHistory(scope, creativeId) {
      assertManifestScope(scope);
      return Object.freeze(
        (
          db
            .prepare(
              `SELECT organization_id, venture_id, manifest_json FROM creative_manifests
               WHERE organization_id = ? AND venture_id = ? AND creative_id = ?
               ORDER BY manifest_version`,
            )
            .all(scope.organizationId, scope.ventureId, creativeId) as Record<string, unknown>[]
        ).map(parse),
      );
    },
    revoke(input) {
      if (
        !input.reason.trim() ||
        !input.reviewedBy.trim() ||
        !input.reviewEventId.trim() ||
        !Number.isFinite(Date.parse(input.revokedAt))
      ) {
        throw new Error("creative manifest revocation evidence is incomplete");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const previous = current(
          { organizationId: input.organizationId, ventureId: input.ventureId },
          input.creativeId,
        );
        if (!previous) throw new Error(`unknown creative manifest ${input.creativeId}`);
        if (previous.revokedAt !== null) {
          db.exec("ROLLBACK");
          return previous;
        }
        const manifest = freezeManifest({
          ...previous,
          reviewedBy: input.reviewedBy,
          reviewEventId: input.reviewEventId,
          reviewedAt: input.revokedAt,
          manifestVersion: previous.manifestVersion + 1,
          revokedAt: input.revokedAt,
          revocationReason: input.reason,
        });
        append(manifest);
        db.exec("COMMIT");
        return manifest;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* transaction already closed */
        }
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
  return store;
}
