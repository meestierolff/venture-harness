import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initializeSqliteWal } from "@venture-harness/core";

export type OrganicReviewMode =
  "AUTOMATIC_WITHIN_POLICY" | "REVIEW_BEFORE_PUBLISH" | "PLATFORM_DRAFT";

export type OrganicDuplicatePolicy = "forbid" | "allow_across_accounts" | "allow_with_variation";

export type OrganicPublicationFeature =
  "distribution.content.draft" | "distribution.content.publish";

export interface OrganicPolicyTerms {
  readonly contractVersion: 2;
  readonly ventureId: string;
  readonly allowedProviders: readonly string[];
  readonly allowedAccounts: readonly string[];
  readonly maxAccounts: number;
  readonly maxPostsPerAccountPerDay: number;
  readonly duplicateContentPolicy: OrganicDuplicatePolicy;
  readonly defaultReviewMode: OrganicReviewMode;
  readonly disclosureRequired: boolean;
  readonly allowedRegions: readonly string[];
  readonly prohibitedClaims: readonly string[];
  readonly providerPolicyState: "unknown" | "clear" | "warned" | "restricted";
}

export interface OrganicPolicySnapshotInput {
  readonly organizationId: string;
  readonly snapshotId: string;
  readonly terms: OrganicPolicyTerms;
  readonly capturedAt: string;
  readonly expiresAt: string;
}

export interface StoredOrganicPolicySnapshot extends OrganicPolicySnapshotInput {
  readonly policyHash: string;
  readonly integrityProof: string;
}

export interface OrganicProviderSnapshotInput {
  readonly organizationId: string;
  readonly snapshotId: string;
  readonly ventureId: string;
  readonly providerId: string;
  readonly providerAccountId: string;
  readonly health: "healthy" | "degraded" | "blocked" | "revoked";
  readonly providerPolicyState: "unknown" | "clear" | "warned" | "restricted";
  readonly availableFeatures: readonly OrganicPublicationFeature[];
  readonly canPost: boolean;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly evidenceRef: string;
}

export interface StoredOrganicProviderSnapshot extends OrganicProviderSnapshotInput {
  readonly accountStateHash: string;
  readonly integrityProof: string;
}

export interface OrganicReviewApprovalInput {
  readonly organizationId: string;
  readonly approvalId: string;
  readonly ventureId: string;
  readonly operationId: string;
  readonly requestHash: string;
  readonly intentHash: string;
  readonly policySnapshotId: string;
  readonly providerSnapshotId: string;
  readonly providerAccountId: string;
  readonly creativeId: string;
  readonly approvedBy: string;
  readonly approvalRef: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
}

export interface StoredOrganicReviewApproval extends OrganicReviewApprovalInput {
  readonly integrityProof: string;
}

export type OrganicReservationState =
  | "reserved"
  | "accepted_unverified"
  | "pending_reconciliation"
  | "verified_draft"
  | "published"
  | "confirmed_absent"
  | "failed_no_effect"
  | "conflict";

export interface OrganicReservationRequest {
  readonly organizationId: string;
  readonly reservationId: string;
  readonly ventureId: string;
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly requestHash: string;
  readonly intentHash: string;
  readonly bindingHash: string;
  readonly policySnapshotId: string;
  readonly providerSnapshotId: string;
  readonly providerId: string;
  readonly providerAccountId: string;
  readonly feature: OrganicPublicationFeature;
  readonly reviewMode: OrganicReviewMode;
  readonly creativeId: string;
  readonly deliveryVariantId: string | null;
  readonly contentFingerprint: string;
  readonly variationFingerprint: string | null;
  readonly region: string;
  readonly dayKey: string;
  readonly createdAt: string;
}

export interface StoredOrganicReservation extends OrganicReservationRequest {
  readonly state: OrganicReservationState;
  readonly providerOperationId: string | null;
  readonly evidenceHash: string | null;
  readonly updatedAt: string;
  readonly integrityProof: string;
}

export interface OrganicReservationLimits {
  readonly maxAccounts: number;
  readonly maxPostsPerAccountPerDay: number;
  readonly duplicateContentPolicy: OrganicDuplicatePolicy;
}

export interface OrganicPolicyScope {
  readonly organizationId: string;
  readonly ventureId: string;
}

export type OrganicReservationOutcome =
  | { readonly kind: "created"; readonly reservation: StoredOrganicReservation }
  | { readonly kind: "idempotent_replay"; readonly reservation: StoredOrganicReservation }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "account_limit"; readonly attempted: number; readonly limit: number }
  | { readonly kind: "daily_limit"; readonly attempted: number; readonly limit: number }
  | { readonly kind: "duplicate"; readonly existingReservationId: string };

export class OrganicPolicyStoreError extends Error {
  constructor(
    readonly code: "integrity_invalid" | "scope_mismatch" | "state_conflict" | "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "OrganicPolicyStoreError";
  }
}

export interface OrganicPolicyStore {
  readonly label: string;
  readonly durability: "durable";
  readonly transactionalReservations: true;
  putPolicySnapshot(input: OrganicPolicySnapshotInput): StoredOrganicPolicySnapshot;
  getPolicySnapshot(
    scope: OrganicPolicyScope,
    snapshotId: string,
  ): StoredOrganicPolicySnapshot | undefined;
  getLatestPolicySnapshot(scope: OrganicPolicyScope): StoredOrganicPolicySnapshot | undefined;
  putProviderSnapshot(input: OrganicProviderSnapshotInput): StoredOrganicProviderSnapshot;
  getProviderSnapshot(
    scope: OrganicPolicyScope,
    snapshotId: string,
  ): StoredOrganicProviderSnapshot | undefined;
  getLatestProviderSnapshot(
    scope: OrganicPolicyScope,
    providerId: string,
    providerAccountId: string,
  ): StoredOrganicProviderSnapshot | undefined;
  putReviewApproval(input: OrganicReviewApprovalInput): StoredOrganicReviewApproval;
  getReviewApproval(
    scope: OrganicPolicyScope,
    approvalId: string,
  ): StoredOrganicReviewApproval | undefined;
  reserveAtomically(
    request: OrganicReservationRequest,
    limits: OrganicReservationLimits,
  ): OrganicReservationOutcome;
  getReservation(
    scope: OrganicPolicyScope,
    reservationId: string,
  ): StoredOrganicReservation | undefined;
  getReservationByIdempotencyKey(
    scope: OrganicPolicyScope,
    idempotencyKey: string,
  ): StoredOrganicReservation | undefined;
  transitionReservation(input: {
    organizationId: string;
    ventureId: string;
    reservationId: string;
    requestHash: string;
    intentHash: string;
    state: OrganicReservationState;
    providerOperationId?: string | null;
    evidenceHash?: string | null;
    updatedAt: string;
  }): StoredOrganicReservation;
  listReservations(scope: OrganicPolicyScope): readonly StoredOrganicReservation[];
  close(): void;
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
    throw new Error(
      `the organic policy store requires Node >= 22.5 (node:sqlite unavailable): ${(error as Error).message}`,
    );
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function hashOrganicPolicyValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function loadOrCreateIntegrityKey(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, randomBytes(32).toString("hex"), { encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new OrganicPolicyStoreError(
      "invalid_input",
      "organic policy integrity key must be a regular file",
    );
  }
  chmodSync(path, 0o600);
  const encoded = readFileSync(path, "utf8").trim();
  if (!/^[a-f0-9]{64}$/u.test(encoded)) {
    throw new OrganicPolicyStoreError(
      "integrity_invalid",
      "organic policy integrity key is malformed",
    );
  }
  return Buffer.from(encoded, "hex");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS organic_policy_snapshots (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  integrity_proof TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, snapshot_id)
);
CREATE INDEX IF NOT EXISTS organic_policy_current
  ON organic_policy_snapshots(
    organization_id, venture_id, captured_at DESC, snapshot_id DESC
  );

CREATE TABLE IF NOT EXISTS organic_provider_snapshots (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  account_state_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  integrity_proof TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, snapshot_id)
);
CREATE INDEX IF NOT EXISTS organic_provider_current
  ON organic_provider_snapshots(
    organization_id, venture_id, provider_id, provider_account_id,
    observed_at DESC, snapshot_id DESC
  );

CREATE TABLE IF NOT EXISTS organic_review_approvals (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  integrity_proof TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, approval_id)
);

CREATE TABLE IF NOT EXISTS organic_publication_reservations (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  creative_id TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  variation_fingerprint TEXT,
  day_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'reserved', 'accepted_unverified', 'pending_reconciliation', 'verified_draft',
    'published', 'confirmed_absent', 'failed_no_effect', 'conflict'
  )),
  provider_operation_id TEXT,
  evidence_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  integrity_proof TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, reservation_id),
  UNIQUE (organization_id, venture_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS organic_publication_daily
  ON organic_publication_reservations(
    organization_id, venture_id, provider_account_id, day_key, state
  );
CREATE INDEX IF NOT EXISTS organic_publication_duplicate
  ON organic_publication_reservations(
    organization_id, venture_id, content_fingerprint, variation_fingerprint,
    provider_account_id, state
  );
`;

const CONSUMING_STATES: readonly OrganicReservationState[] = [
  "reserved",
  "accepted_unverified",
  "pending_reconciliation",
  "verified_draft",
  "published",
  "conflict",
];

const ALLOWED_TRANSITIONS: Readonly<
  Record<OrganicReservationState, readonly OrganicReservationState[]>
> = Object.freeze({
  reserved: [
    "reserved",
    "accepted_unverified",
    "pending_reconciliation",
    "verified_draft",
    "published",
    "confirmed_absent",
    "failed_no_effect",
    "conflict",
  ],
  accepted_unverified: [
    "accepted_unverified",
    "pending_reconciliation",
    "verified_draft",
    "published",
    "confirmed_absent",
    "failed_no_effect",
    "conflict",
  ],
  pending_reconciliation: [
    "pending_reconciliation",
    "verified_draft",
    "published",
    "confirmed_absent",
    "conflict",
  ],
  verified_draft: ["verified_draft"],
  published: ["published"],
  confirmed_absent: ["confirmed_absent"],
  failed_no_effect: ["failed_no_effect"],
  conflict: ["conflict"],
});

function freezePolicyTerms(terms: OrganicPolicyTerms): OrganicPolicyTerms {
  return Object.freeze({
    ...terms,
    allowedProviders: Object.freeze([...terms.allowedProviders]),
    allowedAccounts: Object.freeze([...terms.allowedAccounts]),
    allowedRegions: Object.freeze([...terms.allowedRegions]),
    prohibitedClaims: Object.freeze([...terms.prohibitedClaims]),
  });
}

function freezePolicySnapshot(snapshot: StoredOrganicPolicySnapshot): StoredOrganicPolicySnapshot {
  return Object.freeze({ ...snapshot, terms: freezePolicyTerms(snapshot.terms) });
}

function freezeProviderSnapshot(
  snapshot: StoredOrganicProviderSnapshot,
): StoredOrganicProviderSnapshot {
  return Object.freeze({
    ...snapshot,
    availableFeatures: Object.freeze([...snapshot.availableFeatures]),
  });
}

function freezeReview(review: StoredOrganicReviewApproval): StoredOrganicReviewApproval {
  return Object.freeze({ ...review });
}

function freezeReservation(reservation: StoredOrganicReservation): StoredOrganicReservation {
  return Object.freeze({ ...reservation });
}

function parseSigned<T extends object>(row: Record<string, unknown>, kind: string, key: Buffer): T {
  const parsed = JSON.parse(String(row.record_json)) as T;
  const actual = String(row.integrity_proof);
  const expected = createHmac("sha256", key)
    .update(`${kind}\0${stableJson(parsed)}`)
    .digest("hex");
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    !/^[a-f0-9]{64}$/u.test(actual) ||
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new OrganicPolicyStoreError(
      "integrity_invalid",
      `stored ${kind} failed integrity verification`,
    );
  }
  return parsed;
}

function assertLookupMatches(
  row: Record<string, unknown>,
  expected: Readonly<Record<string, unknown>>,
): void {
  for (const [column, value] of Object.entries(expected)) {
    if (row[column] !== value) {
      throw new OrganicPolicyStoreError(
        "integrity_invalid",
        `stored organic policy lookup column ${column} is inconsistent`,
      );
    }
  }
}

function rollback(db: SqliteDatabase): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // The transaction may already be closed by SQLite after a failed statement.
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!value.trim() || value.length > 500 || value.includes("\0")) {
    throw new OrganicPolicyStoreError("invalid_input", `${label} is invalid`);
  }
}

function hasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.length === 0 || columns.some((entry) => entry.name === column);
}

function assertOrganizationScopedSchema(db: SqliteDatabase): void {
  for (const table of [
    "organic_policy_snapshots",
    "organic_provider_snapshots",
    "organic_review_approvals",
    "organic_publication_reservations",
  ]) {
    if (!hasColumn(db, table, "organization_id")) {
      throw new OrganicPolicyStoreError(
        "scope_mismatch",
        `legacy ${table} is missing organization scope; migrate it with an explicit tenant mapping before organic execution`,
      );
    }
  }
}

export function createSqliteOrganicPolicyStore(
  filename: string,
  options: { readonly integrityKeyPath?: string } = {},
): OrganicPolicyStore {
  const key = loadOrCreateIntegrityKey(options.integrityKeyPath ?? `${filename}.organic-key`);
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(filename);
  initializeSqliteWal(db, { label: "organic policy store" });
  db.exec("PRAGMA foreign_keys = ON");
  try {
    assertOrganizationScopedSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }
  db.exec(SCHEMA);

  const proofFor = (kind: string, record: object): string =>
    createHmac("sha256", key)
      .update(`${kind}\0${stableJson(record)}`)
      .digest("hex");

  const policyFromRow = (row: Record<string, unknown>): StoredOrganicPolicySnapshot => {
    const unsigned = parseSigned<Omit<StoredOrganicPolicySnapshot, "integrityProof">>(
      row,
      "policy_snapshot",
      key,
    );
    assertLookupMatches(row, {
      organization_id: unsigned.organizationId,
      venture_id: unsigned.terms.ventureId,
      snapshot_id: unsigned.snapshotId,
      policy_hash: unsigned.policyHash,
      captured_at: unsigned.capturedAt,
      expires_at: unsigned.expiresAt,
    });
    return freezePolicySnapshot({ ...unsigned, integrityProof: String(row.integrity_proof) });
  };

  const providerFromRow = (row: Record<string, unknown>): StoredOrganicProviderSnapshot => {
    const unsigned = parseSigned<Omit<StoredOrganicProviderSnapshot, "integrityProof">>(
      row,
      "provider_snapshot",
      key,
    );
    assertLookupMatches(row, {
      organization_id: unsigned.organizationId,
      venture_id: unsigned.ventureId,
      snapshot_id: unsigned.snapshotId,
      provider_id: unsigned.providerId,
      provider_account_id: unsigned.providerAccountId,
      account_state_hash: unsigned.accountStateHash,
      observed_at: unsigned.observedAt,
      expires_at: unsigned.expiresAt,
    });
    return freezeProviderSnapshot({ ...unsigned, integrityProof: String(row.integrity_proof) });
  };

  const reviewFromRow = (row: Record<string, unknown>): StoredOrganicReviewApproval => {
    const unsigned = parseSigned<Omit<StoredOrganicReviewApproval, "integrityProof">>(
      row,
      "review_approval",
      key,
    );
    assertLookupMatches(row, {
      organization_id: unsigned.organizationId,
      venture_id: unsigned.ventureId,
      approval_id: unsigned.approvalId,
      operation_id: unsigned.operationId,
      request_hash: unsigned.requestHash,
      intent_hash: unsigned.intentHash,
      approved_at: unsigned.approvedAt,
      expires_at: unsigned.expiresAt,
    });
    return freezeReview({ ...unsigned, integrityProof: String(row.integrity_proof) });
  };

  const reservationFromRow = (row: Record<string, unknown>): StoredOrganicReservation => {
    const unsigned = parseSigned<Omit<StoredOrganicReservation, "integrityProof">>(
      row,
      "reservation",
      key,
    );
    assertLookupMatches(row, {
      organization_id: unsigned.organizationId,
      venture_id: unsigned.ventureId,
      reservation_id: unsigned.reservationId,
      idempotency_key: unsigned.idempotencyKey,
      operation_id: unsigned.operationId,
      request_hash: unsigned.requestHash,
      intent_hash: unsigned.intentHash,
      binding_hash: unsigned.bindingHash,
      provider_id: unsigned.providerId,
      provider_account_id: unsigned.providerAccountId,
      feature: unsigned.feature,
      creative_id: unsigned.creativeId,
      content_fingerprint: unsigned.contentFingerprint,
      variation_fingerprint: unsigned.variationFingerprint,
      day_key: unsigned.dayKey,
      state: unsigned.state,
      provider_operation_id: unsigned.providerOperationId,
      evidence_hash: unsigned.evidenceHash,
      created_at: unsigned.createdAt,
      updated_at: unsigned.updatedAt,
    });
    return freezeReservation({ ...unsigned, integrityProof: String(row.integrity_proof) });
  };

  const store: OrganicPolicyStore = {
    label: "sqlite",
    durability: "durable",
    transactionalReservations: true,

    putPolicySnapshot(input) {
      assertIdentifier(input.organizationId, "organization id");
      assertIdentifier(input.snapshotId, "policy snapshot id");
      assertIdentifier(input.terms.ventureId, "venture id");
      const unsigned = {
        ...input,
        terms: freezePolicyTerms(input.terms),
        policyHash: hashOrganicPolicyValue(input.terms),
      };
      const proof = proofFor("policy_snapshot", unsigned);
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db
          .prepare(
            `SELECT * FROM organic_policy_snapshots
             WHERE organization_id = ? AND venture_id = ? AND snapshot_id = ?`,
          )
          .get(input.organizationId, input.terms.ventureId, input.snapshotId) as
          Record<string, unknown> | undefined;
        if (existing) {
          const current = policyFromRow(existing);
          rollback(db);
          if (current.integrityProof !== proof) {
            throw new OrganicPolicyStoreError(
              "state_conflict",
              "policy snapshot id is already bound to different terms",
            );
          }
          return current;
        }
        db.prepare(
          `INSERT INTO organic_policy_snapshots
           (organization_id, venture_id, snapshot_id, policy_hash, captured_at, expires_at,
            record_json, integrity_proof)
           VALUES (?,?,?,?,?,?,?,?)`,
        ).run(
          input.organizationId,
          input.terms.ventureId,
          input.snapshotId,
          unsigned.policyHash,
          input.capturedAt,
          input.expiresAt,
          stableJson(unsigned),
          proof,
        );
        db.exec("COMMIT");
        return freezePolicySnapshot({ ...unsigned, integrityProof: proof });
      } catch (error) {
        rollback(db);
        throw error;
      }
    },

    getPolicySnapshot(scope, snapshotId) {
      const row = db
        .prepare(
          `SELECT * FROM organic_policy_snapshots
           WHERE organization_id = ? AND venture_id = ? AND snapshot_id = ?`,
        )
        .get(scope.organizationId, scope.ventureId, snapshotId) as
        Record<string, unknown> | undefined;
      return row ? policyFromRow(row) : undefined;
    },

    getLatestPolicySnapshot(scope) {
      const row = db
        .prepare(
          `SELECT * FROM organic_policy_snapshots
           WHERE organization_id = ? AND venture_id = ?
           ORDER BY captured_at DESC, snapshot_id DESC LIMIT 1`,
        )
        .get(scope.organizationId, scope.ventureId) as Record<string, unknown> | undefined;
      return row ? policyFromRow(row) : undefined;
    },

    putProviderSnapshot(input) {
      assertIdentifier(input.organizationId, "organization id");
      assertIdentifier(input.snapshotId, "provider snapshot id");
      assertIdentifier(input.ventureId, "venture id");
      assertIdentifier(input.providerId, "provider id");
      assertIdentifier(input.providerAccountId, "provider account id");
      const core = {
        ...input,
        availableFeatures: Object.freeze([...input.availableFeatures]),
      };
      const unsigned = { ...core, accountStateHash: hashOrganicPolicyValue(core) };
      const proof = proofFor("provider_snapshot", unsigned);
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db
          .prepare(
            `SELECT * FROM organic_provider_snapshots
             WHERE organization_id = ? AND venture_id = ? AND snapshot_id = ?`,
          )
          .get(input.organizationId, input.ventureId, input.snapshotId) as
          Record<string, unknown> | undefined;
        if (existing) {
          const current = providerFromRow(existing);
          rollback(db);
          if (current.integrityProof !== proof) {
            throw new OrganicPolicyStoreError(
              "state_conflict",
              "provider snapshot id is already bound to different state",
            );
          }
          return current;
        }
        db.prepare(
          `INSERT INTO organic_provider_snapshots
           (organization_id, venture_id, snapshot_id, provider_id, provider_account_id,
            account_state_hash, observed_at, expires_at, record_json, integrity_proof)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          input.organizationId,
          input.ventureId,
          input.snapshotId,
          input.providerId,
          input.providerAccountId,
          unsigned.accountStateHash,
          input.observedAt,
          input.expiresAt,
          stableJson(unsigned),
          proof,
        );
        db.exec("COMMIT");
        return freezeProviderSnapshot({ ...unsigned, integrityProof: proof });
      } catch (error) {
        rollback(db);
        throw error;
      }
    },

    getProviderSnapshot(scope, snapshotId) {
      const row = db
        .prepare(
          `SELECT * FROM organic_provider_snapshots
           WHERE organization_id = ? AND venture_id = ? AND snapshot_id = ?`,
        )
        .get(scope.organizationId, scope.ventureId, snapshotId) as
        Record<string, unknown> | undefined;
      return row ? providerFromRow(row) : undefined;
    },

    getLatestProviderSnapshot(scope, providerId, providerAccountId) {
      const row = db
        .prepare(
          `SELECT * FROM organic_provider_snapshots
           WHERE organization_id = ? AND venture_id = ?
             AND provider_id = ? AND provider_account_id = ?
           ORDER BY observed_at DESC, snapshot_id DESC LIMIT 1`,
        )
        .get(scope.organizationId, scope.ventureId, providerId, providerAccountId) as
        Record<string, unknown> | undefined;
      return row ? providerFromRow(row) : undefined;
    },

    putReviewApproval(input) {
      assertIdentifier(input.organizationId, "organization id");
      assertIdentifier(input.approvalId, "review approval id");
      assertIdentifier(input.ventureId, "venture id");
      const unsigned = { ...input };
      const proof = proofFor("review_approval", unsigned);
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db
          .prepare(
            `SELECT * FROM organic_review_approvals
             WHERE organization_id = ? AND venture_id = ? AND approval_id = ?`,
          )
          .get(input.organizationId, input.ventureId, input.approvalId) as
          Record<string, unknown> | undefined;
        if (existing) {
          const current = reviewFromRow(existing);
          rollback(db);
          if (current.integrityProof !== proof) {
            throw new OrganicPolicyStoreError(
              "state_conflict",
              "review approval id is already bound to a different intent",
            );
          }
          return current;
        }
        db.prepare(
          `INSERT INTO organic_review_approvals
           (organization_id, venture_id, approval_id, operation_id, request_hash, intent_hash,
            approved_at, expires_at, record_json, integrity_proof)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          input.organizationId,
          input.ventureId,
          input.approvalId,
          input.operationId,
          input.requestHash,
          input.intentHash,
          input.approvedAt,
          input.expiresAt,
          stableJson(unsigned),
          proof,
        );
        db.exec("COMMIT");
        return freezeReview({ ...unsigned, integrityProof: proof });
      } catch (error) {
        rollback(db);
        throw error;
      }
    },

    getReviewApproval(scope, approvalId) {
      const row = db
        .prepare(
          `SELECT * FROM organic_review_approvals
           WHERE organization_id = ? AND venture_id = ? AND approval_id = ?`,
        )
        .get(scope.organizationId, scope.ventureId, approvalId) as
        Record<string, unknown> | undefined;
      return row ? reviewFromRow(row) : undefined;
    },

    reserveAtomically(request, limits) {
      assertIdentifier(request.organizationId, "organization id");
      assertIdentifier(request.reservationId, "reservation id");
      assertIdentifier(request.ventureId, "venture id");
      assertIdentifier(request.idempotencyKey, "idempotency key");
      db.exec("BEGIN IMMEDIATE");
      try {
        const existingRow = db
          .prepare(
            `SELECT * FROM organic_publication_reservations
             WHERE organization_id = ? AND venture_id = ? AND idempotency_key = ?`,
          )
          .get(request.organizationId, request.ventureId, request.idempotencyKey) as
          Record<string, unknown> | undefined;
        if (existingRow) {
          const existing = reservationFromRow(existingRow);
          rollback(db);
          return existing.reservationId === request.reservationId &&
            existing.requestHash === request.requestHash &&
            existing.intentHash === request.intentHash &&
            existing.bindingHash === request.bindingHash
            ? { kind: "idempotent_replay", reservation: existing }
            : { kind: "idempotency_conflict" };
        }

        // Cap and duplicate queries below use indexed columns. Verify every
        // tenant row against its HMAC-bound record first so direct database
        // tampering cannot move a reservation out of a counted scope.
        (
          db
            .prepare(
              `SELECT * FROM organic_publication_reservations
               WHERE organization_id = ? AND venture_id = ?`,
            )
            .all(request.organizationId, request.ventureId) as Record<string, unknown>[]
        ).forEach(reservationFromRow);

        const placeholders = CONSUMING_STATES.map(() => "?").join(",");
        const accountRow = db
          .prepare(
            `SELECT COUNT(DISTINCT provider_account_id) AS count
             FROM organic_publication_reservations
             WHERE organization_id = ? AND venture_id = ? AND state IN (${placeholders})`,
          )
          .get(request.organizationId, request.ventureId, ...CONSUMING_STATES) as {
          count: number;
        };
        const accountAlreadyUsed = db
          .prepare(
            `SELECT 1 AS present FROM organic_publication_reservations
             WHERE organization_id = ? AND venture_id = ? AND provider_account_id = ?
               AND state IN (${placeholders})
             LIMIT 1`,
          )
          .get(
            request.organizationId,
            request.ventureId,
            request.providerAccountId,
            ...CONSUMING_STATES,
          ) as { present: number } | undefined;
        const accountCount = Number(accountRow.count) + (accountAlreadyUsed ? 0 : 1);
        if (accountCount > limits.maxAccounts) {
          rollback(db);
          return { kind: "account_limit", attempted: accountCount, limit: limits.maxAccounts };
        }

        const dailyRow = db
          .prepare(
            `SELECT COUNT(*) AS count FROM organic_publication_reservations
             WHERE organization_id = ? AND venture_id = ?
               AND provider_account_id = ? AND day_key = ?
               AND state IN (${placeholders})`,
          )
          .get(
            request.organizationId,
            request.ventureId,
            request.providerAccountId,
            request.dayKey,
            ...CONSUMING_STATES,
          ) as { count: number };
        const attempted = Number(dailyRow.count) + 1;
        if (attempted > limits.maxPostsPerAccountPerDay) {
          rollback(db);
          return {
            kind: "daily_limit",
            attempted,
            limit: limits.maxPostsPerAccountPerDay,
          };
        }

        let duplicateSql = "content_fingerprint = ?";
        const duplicateParams: unknown[] = [request.contentFingerprint];
        if (limits.duplicateContentPolicy === "allow_across_accounts") {
          duplicateSql += " AND provider_account_id = ?";
          duplicateParams.push(request.providerAccountId);
        } else if (limits.duplicateContentPolicy === "allow_with_variation") {
          duplicateSql += " AND variation_fingerprint = ?";
          duplicateParams.push(request.variationFingerprint);
        }
        const duplicate = db
          .prepare(
            `SELECT reservation_id FROM organic_publication_reservations
             WHERE organization_id = ? AND venture_id = ?
               AND ${duplicateSql} AND state IN (${placeholders})
             LIMIT 1`,
          )
          .get(
            request.organizationId,
            request.ventureId,
            ...duplicateParams,
            ...CONSUMING_STATES,
          ) as { reservation_id: string } | undefined;
        if (duplicate) {
          rollback(db);
          return { kind: "duplicate", existingReservationId: duplicate.reservation_id };
        }

        const unsigned: Omit<StoredOrganicReservation, "integrityProof"> = {
          ...request,
          state: "reserved",
          providerOperationId: null,
          evidenceHash: null,
          updatedAt: request.createdAt,
        };
        const proof = proofFor("reservation", unsigned);
        db.prepare(
          `INSERT INTO organic_publication_reservations (
             organization_id, venture_id, reservation_id, idempotency_key, operation_id,
             request_hash,
             intent_hash, binding_hash, provider_id, provider_account_id, feature,
             creative_id, content_fingerprint, variation_fingerprint, day_key, state,
             provider_operation_id, evidence_hash, created_at, updated_at, record_json,
             integrity_proof
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?)`,
        ).run(
          request.organizationId,
          request.ventureId,
          request.reservationId,
          request.idempotencyKey,
          request.operationId,
          request.requestHash,
          request.intentHash,
          request.bindingHash,
          request.providerId,
          request.providerAccountId,
          request.feature,
          request.creativeId,
          request.contentFingerprint,
          request.variationFingerprint,
          request.dayKey,
          unsigned.state,
          request.createdAt,
          unsigned.updatedAt,
          stableJson(unsigned),
          proof,
        );
        db.exec("COMMIT");
        return {
          kind: "created",
          reservation: freezeReservation({ ...unsigned, integrityProof: proof }),
        };
      } catch (error) {
        rollback(db);
        throw error;
      }
    },

    getReservation(scope, reservationId) {
      const row = db
        .prepare(
          `SELECT * FROM organic_publication_reservations
           WHERE organization_id = ? AND venture_id = ? AND reservation_id = ?`,
        )
        .get(scope.organizationId, scope.ventureId, reservationId) as
        Record<string, unknown> | undefined;
      return row ? reservationFromRow(row) : undefined;
    },

    getReservationByIdempotencyKey(scope, idempotencyKey) {
      const row = db
        .prepare(
          `SELECT * FROM organic_publication_reservations
           WHERE organization_id = ? AND venture_id = ? AND idempotency_key = ?`,
        )
        .get(scope.organizationId, scope.ventureId, idempotencyKey) as
        Record<string, unknown> | undefined;
      return row ? reservationFromRow(row) : undefined;
    },

    transitionReservation(input) {
      assertIdentifier(input.organizationId, "organization id");
      assertIdentifier(input.ventureId, "venture id");
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(
            `SELECT * FROM organic_publication_reservations
             WHERE organization_id = ? AND venture_id = ? AND reservation_id = ?`,
          )
          .get(input.organizationId, input.ventureId, input.reservationId) as
          Record<string, unknown> | undefined;
        if (!row) {
          throw new OrganicPolicyStoreError(
            "scope_mismatch",
            "organic reservation does not exist in this tenant",
          );
        }
        const current = reservationFromRow(row);
        if (current.requestHash !== input.requestHash || current.intentHash !== input.intentHash) {
          throw new OrganicPolicyStoreError(
            "scope_mismatch",
            "organic reservation transition is not bound to this request",
          );
        }
        if (!ALLOWED_TRANSITIONS[current.state].includes(input.state)) {
          throw new OrganicPolicyStoreError(
            "state_conflict",
            `organic reservation cannot transition from ${current.state} to ${input.state}`,
          );
        }
        if (
          current.providerOperationId &&
          input.providerOperationId &&
          current.providerOperationId !== input.providerOperationId
        ) {
          throw new OrganicPolicyStoreError(
            "state_conflict",
            "organic reservation is already bound to another provider operation",
          );
        }
        const unsigned: Omit<StoredOrganicReservation, "integrityProof"> = {
          ...current,
          state: input.state,
          providerOperationId:
            input.providerOperationId === undefined
              ? current.providerOperationId
              : input.providerOperationId,
          evidenceHash:
            input.evidenceHash === undefined ? current.evidenceHash : input.evidenceHash,
          updatedAt: input.updatedAt,
        };
        const proof = proofFor("reservation", unsigned);
        db.prepare(
          `UPDATE organic_publication_reservations
           SET state = ?, provider_operation_id = ?, evidence_hash = ?, updated_at = ?,
               record_json = ?, integrity_proof = ?
           WHERE organization_id = ? AND venture_id = ? AND reservation_id = ?`,
        ).run(
          unsigned.state,
          unsigned.providerOperationId,
          unsigned.evidenceHash,
          unsigned.updatedAt,
          stableJson(unsigned),
          proof,
          input.organizationId,
          input.ventureId,
          input.reservationId,
        );
        db.exec("COMMIT");
        return freezeReservation({ ...unsigned, integrityProof: proof });
      } catch (error) {
        rollback(db);
        throw error;
      }
    },

    listReservations(scope) {
      return Object.freeze(
        (
          db
            .prepare(
              `SELECT * FROM organic_publication_reservations
               WHERE organization_id = ? AND venture_id = ?
               ORDER BY created_at, reservation_id`,
            )
            .all(scope.organizationId, scope.ventureId) as Record<string, unknown>[]
        ).map(reservationFromRow),
      );
    },

    close() {
      db.close();
    },
  };

  return Object.freeze(store);
}
