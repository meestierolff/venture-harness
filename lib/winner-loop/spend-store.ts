import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  LEGACY_UNSCOPED_ORGANIZATION_ID,
  adoptLegacyTenantPayload,
  assertAddressableTenantScope,
  resolveLegacyTenantAdoptions,
  type LegacyAdoptionOptions,
  type LegacyTenantTarget,
} from "./legacy-adoption";

/** Loaded lazily: node:sqlite needs Node >= 22.5, but the rest of Winner Loop
 * runs on the Node >= 20.9 the package declares. Only callers that ask for the
 * SQLite store pay that requirement. */
function loadSqlite(): { DatabaseSync: new (path: string) => SqliteDatabase } {
  try {
    return createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
  } catch (error) {
    throw new Error(
      `the SQLite spend store requires Node >= 22.5 (node:sqlite unavailable): ${(error as Error).message}`,
    );
  }
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

/**
 * The transactional boundary for spend.
 *
 * Correctness here cannot come from JavaScript being single-threaded. Reservations
 * are taken by multiple workers, queue consumers, reconciliation jobs, and
 * serverless instances that share nothing but the database, so the cap check and
 * the reservation write must commit or fail together inside one serialized
 * transaction. The SQLite store uses BEGIN IMMEDIATE, which takes the write lock
 * up front and forces concurrent writers to serialize instead of both reading
 * stale headroom.
 */

export interface StoredGrant {
  grantId: string;
  organizationId: string;
  ventureId: string;
  customerId: string | null;
  network: "tiktok_paid" | "meta_paid";
  externalAccountId: string;
  currency: string;
  totalMinorUnits: number;
  perCreativeMinorUnits: number;
  perPaidTestMinorUnits: number;
  perCampaignMinorUnits: number;
  dailyAccountMinorUnits: number;
  dailyVentureMinorUnits: number;
  monthlyVentureMinorUnits: number;
  dailyCustomerMinorUnits: number;
  monthlyCustomerMinorUnits: number;
  emergencyPlatformMinorUnits: number;
  allowedCreativeIds: readonly string[];
  approvedBy: string;
  approvalRef: string;
  proposalId: string;
  notBefore: string;
  expiresAt: string;
  grantHash: string;
  issuedAt: string;
}

export interface StoredReservation {
  reservationId: string;
  idempotencyKey: string;
  grantId: string;
  organizationId: string;
  ventureId: string;
  creativeId: string;
  paidTestId: string;
  campaignId: string;
  externalAccountId: string;
  heldMinorUnits: number;
  settledMinorUnits: number | null;
  status: "held" | "pending_reconciliation" | "settled" | "released";
  pendingReason: string | null;
  pendingAt: string | null;
  reconciliationOutcome: "present" | "absent" | null;
  reconciledAt: string | null;
  dayKey: string;
  monthKey: string;
  createdAt: string;
}

export interface StoredIncident {
  incidentId: string;
  grantId: string;
  organizationId: string;
  ventureId: string;
  kind: string;
  detail: string;
  recordedAt: string;
}

export type ProviderPauseObligationState =
  "pending" | "attempting" | "accepted_unverified" | "unknown" | "failed" | "blocked" | "verified";

export type ProviderPauseReadBackState = "matched" | "missing" | "conflict" | "unknown" | "blocked";

/** Durable proof that a local spend halt still requires provider-side pause read-back. */
export interface StoredProviderPauseObligation {
  obligationId: string;
  grantId: string;
  organizationId: string;
  ventureId: string;
  network: string;
  providerAdapterId: "tiktok_spark_ads" | null;
  externalAccountId: string;
  campaignId: string | null;
  operationId: string | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  payloadJson: string | null;
  reasons: readonly string[];
  incidentIds: readonly string[];
  state: ProviderPauseObligationState;
  attemptCount: number;
  providerOperationId: string | null;
  lastDiagnosticCode: string | null;
  lastDiagnosticMessage: string | null;
  evidenceJson: string | null;
  createdAt: string;
  updatedAt: string;
  lastAttemptedAt: string | null;
  lastApplyState: Exclude<
    ProviderPauseObligationState,
    "pending" | "attempting" | "verified"
  > | null;
  lastReadBackState: ProviderPauseReadBackState | null;
  lastReadBackAt: string | null;
  lastReconciledAt: string | null;
  verifiedAt: string | null;
}

export interface ProviderPauseObligationUpdate {
  state: ProviderPauseObligationState;
  providerOperationId: string | null;
  lastDiagnosticCode: string | null;
  lastDiagnosticMessage: string | null;
  evidenceJson: string | null;
  updatedAt: string;
  lastApplyState?: StoredProviderPauseObligation["lastApplyState"];
  lastReadBackState?: ProviderPauseReadBackState;
  lastReadBackAt?: string;
  lastReconciledAt?: string;
  verifiedAt: string | null;
}

export type ProviderPauseAttemptClaim =
  | { kind: "claimed"; obligation: StoredProviderPauseObligation }
  | { kind: "reconcile"; obligation: StoredProviderPauseObligation }
  | { kind: "complete"; obligation: StoredProviderPauseObligation };

export interface CapUsage {
  grantTotal: number;
  perCreative: number;
  perPaidTest: number;
  perCampaign: number;
  dailyAccount: number;
  dailyVenture: number;
  monthlyVenture: number;
  dailyCustomer: number;
  monthlyCustomer: number;
  emergencyPlatform: number;
}

export interface ReservationRequest {
  reservationId: string;
  idempotencyKey: string;
  grantId: string;
  organizationId: string;
  ventureId: string;
  creativeId: string;
  paidTestId: string;
  campaignId: string;
  amountMinorUnits: number;
  dayKey: string;
  monthKey: string;
  createdAt: string;
}

export type ReservationOutcome =
  | { kind: "created"; reservation: StoredReservation }
  | { kind: "idempotent_replay"; reservation: StoredReservation }
  | { kind: "idempotency_conflict" }
  | { kind: "cap_exceeded"; cap: keyof CapUsage; attempted: number; limit: number }
  | { kind: "halted"; reason: string };

export interface SpendScope {
  organizationId: string;
  ventureId: string;
}

function assertSpendScope(scope: SpendScope): void {
  assertAddressableTenantScope(scope, "spend store");
}

export interface SpendStore {
  readonly label: string;
  readonly productionSafe: boolean;
  putGrant(grant: StoredGrant): void;
  getGrant(scope: SpendScope, grantId: string): StoredGrant | undefined;
  /** Atomically evaluates every cap and writes the reservation, or writes nothing. */
  reserveAtomically(request: ReservationRequest): ReservationOutcome;
  /** Atomically settles and, on provider overspend, records the incident and freezes the grant. */
  settleAtomically(
    scope: SpendScope,
    reservationId: string,
    settledMinorUnits: number,
    incident: StoredIncident | null,
    reconciledAt?: string,
    providerPause?: StoredProviderPauseObligation | null,
  ): StoredReservation | undefined;
  markPendingReconciliation(
    scope: SpendScope,
    reservationId: string,
    reason: string,
    markedAt: string,
  ): StoredReservation | undefined;
  reconcileAbsent(
    scope: SpendScope,
    reservationId: string,
    reconciledAt: string,
  ): StoredReservation | undefined;
  release(scope: SpendScope, reservationId: string): StoredReservation | undefined;
  getReservation(scope: SpendScope, reservationId: string): StoredReservation | undefined;
  listReservations(scope: SpendScope, grantId: string): readonly StoredReservation[];
  halt(scope: SpendScope, grantId: string, reason: string): void;
  haltReason(scope: SpendScope, grantId: string): string | undefined;
  recordIncident(incident: StoredIncident): void;
  listIncidents(scope: SpendScope, grantId: string): readonly StoredIncident[];
  /** Atomically preserves the local halt, incident evidence, and pause obligations. */
  haltAndQueueProviderPauses(
    scope: SpendScope,
    grantId: string,
    reason: string,
    obligations: readonly StoredProviderPauseObligation[],
    incidents: readonly StoredIncident[],
  ): readonly StoredProviderPauseObligation[];
  getProviderPauseObligation(
    scope: SpendScope,
    obligationId: string,
  ): StoredProviderPauseObligation | undefined;
  listProviderPauseObligations(
    scope: SpendScope,
    grantId: string,
  ): readonly StoredProviderPauseObligation[];
  claimProviderPauseAttempt(
    scope: SpendScope,
    obligationId: string,
    attemptedAt: string,
  ): ProviderPauseAttemptClaim;
  updateProviderPauseObligation(
    scope: SpendScope,
    obligationId: string,
    update: ProviderPauseObligationUpdate,
  ): StoredProviderPauseObligation | undefined;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spend_grants (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  customer_id TEXT,
  network TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  total_minor INTEGER NOT NULL,
  per_creative_minor INTEGER NOT NULL,
  per_paid_test_minor INTEGER NOT NULL,
  per_campaign_minor INTEGER NOT NULL,
  daily_account_minor INTEGER NOT NULL,
  daily_venture_minor INTEGER NOT NULL,
  monthly_venture_minor INTEGER NOT NULL,
  daily_customer_minor INTEGER NOT NULL,
  monthly_customer_minor INTEGER NOT NULL,
  emergency_platform_minor INTEGER NOT NULL,
  allowed_creative_ids TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approval_ref TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  grant_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  halted_reason TEXT,
  PRIMARY KEY (organization_id, venture_id, grant_id)
);
CREATE TABLE IF NOT EXISTS spend_reservations (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  creative_id TEXT NOT NULL,
  paid_test_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  held_minor INTEGER NOT NULL,
  settled_minor INTEGER,
  status TEXT NOT NULL,
  pending_reason TEXT,
  pending_at TEXT,
  reconciliation_outcome TEXT,
  reconciled_at TEXT,
  conservative_minor INTEGER NOT NULL DEFAULT 0,
  day_key TEXT NOT NULL,
  month_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, reservation_id),
  UNIQUE (organization_id, venture_id, idempotency_key),
  FOREIGN KEY (organization_id, venture_id, grant_id)
    REFERENCES spend_grants(organization_id, venture_id, grant_id)
);
CREATE INDEX IF NOT EXISTS spend_res_grant
  ON spend_reservations(organization_id, venture_id, grant_id, status);
CREATE INDEX IF NOT EXISTS spend_res_day
  ON spend_reservations(organization_id, external_account_id, day_key);
CREATE TABLE IF NOT EXISTS spend_incidents (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, incident_id),
  FOREIGN KEY (organization_id, venture_id, grant_id)
    REFERENCES spend_grants(organization_id, venture_id, grant_id)
);
CREATE TABLE IF NOT EXISTS provider_pause_obligations (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  obligation_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  network TEXT NOT NULL,
  provider_adapter_id TEXT,
  external_account_id TEXT NOT NULL,
  campaign_id TEXT,
  target_key TEXT NOT NULL,
  operation_id TEXT,
  idempotency_key TEXT,
  request_hash TEXT,
  payload_json TEXT,
  reasons_json TEXT NOT NULL,
  incident_ids_json TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  provider_operation_id TEXT,
  last_diagnostic_code TEXT,
  last_diagnostic_message TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_attempted_at TEXT,
  last_apply_state TEXT,
  last_read_back_state TEXT,
  last_read_back_at TEXT,
  last_reconciled_at TEXT,
  verified_at TEXT,
  PRIMARY KEY (organization_id, venture_id, obligation_id),
  UNIQUE(organization_id, venture_id, grant_id, target_key),
  FOREIGN KEY (organization_id, venture_id, grant_id)
    REFERENCES spend_grants(organization_id, venture_id, grant_id)
);
CREATE INDEX IF NOT EXISTS provider_pause_pending
  ON provider_pause_obligations(organization_id, venture_id, grant_id, state, created_at);
`;

function ensureColumn(
  db: SqliteDatabase,
  table: string,
  column: string,
  declaration: string,
): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    return true;
  }
  return false;
}

function hasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    ({ name }) => name === column,
  );
}

function hasTable(db: SqliteDatabase, table: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

interface LegacySpendRows {
  grants: readonly Record<string, unknown>[];
  reservations: readonly Record<string, unknown>[];
  incidents: readonly Record<string, unknown>[];
  providerPauses: readonly Record<string, unknown>[];
}

const LEGACY_ADOPTION_HALT = "legacy_tenant_adoption_requires_reapproval";

function numberOr(value: unknown, fallback: unknown): number {
  return value === null || value === undefined ? Number(fallback) : Number(value);
}

function legacyVentureForChild(
  row: Record<string, unknown>,
  grants: readonly Record<string, unknown>[],
): string {
  const declaredVentureId =
    typeof row.venture_id === "string" && row.venture_id.length > 0 ? row.venture_id : null;
  const owners = grants.filter(
    (grant) =>
      grant.grant_id === row.grant_id &&
      (declaredVentureId === null || grant.venture_id === declaredVentureId),
  );
  if (owners.length !== 1) {
    throw new Error(
      `legacy spend child ${String(row.grant_id)} has missing, cross-venture, or ambiguous grant ownership`,
    );
  }
  const ownerVentureId = owners[0]!.venture_id;
  if (typeof ownerVentureId !== "string" || ownerVentureId.length === 0)
    throw new Error(`legacy spend grant ${String(row.grant_id)} has no venture owner`);
  return ownerVentureId;
}

function assertLegacyProviderPauseIncidentBindings(rows: LegacySpendRows): void {
  for (const pause of rows.providerPauses) {
    const legacyVentureId = legacyVentureForChild(pause, rows.grants);
    let incidentIds: unknown;
    try {
      incidentIds = JSON.parse(pause.incident_ids_json as string) as unknown;
    } catch {
      throw new Error(
        `legacy spend provider pause ${String(pause.obligation_id)} has invalid incident ownership evidence`,
      );
    }
    if (
      !Array.isArray(incidentIds) ||
      incidentIds.length === 0 ||
      incidentIds.some((incidentId) => typeof incidentId !== "string" || incidentId.length === 0)
    ) {
      throw new Error(
        `legacy spend provider pause ${String(pause.obligation_id)} has invalid incident ownership evidence`,
      );
    }
    for (const incidentId of incidentIds) {
      const owners = rows.incidents.filter(
        (incident) =>
          incident.incident_id === incidentId &&
          incident.grant_id === pause.grant_id &&
          legacyVentureForChild(incident, rows.grants) === legacyVentureId,
      );
      if (owners.length !== 1) {
        throw new Error(
          `legacy spend provider pause ${String(pause.obligation_id)} has missing, cross-venture, or ambiguous incident ownership`,
        );
      }
    }
  }
}

function assertSpendForeignKeys(db: SqliteDatabase): void {
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0)
    throw new Error("legacy spend adoption produced an invalid parent-child relationship");
}

function adoptedGrant(row: Record<string, unknown>, target: LegacyTenantTarget): StoredGrant {
  const grant: Omit<StoredGrant, "grantHash"> = {
    grantId: row.grant_id as string,
    organizationId: target.organizationId,
    ventureId: target.ventureId,
    customerId: (row.customer_id as string | null) ?? null,
    network: row.network as StoredGrant["network"],
    externalAccountId: row.external_account_id as string,
    currency: row.currency as string,
    totalMinorUnits: Number(row.total_minor),
    perCreativeMinorUnits: Number(row.per_creative_minor),
    perPaidTestMinorUnits: Number(row.per_paid_test_minor),
    perCampaignMinorUnits: Number(row.per_campaign_minor),
    dailyAccountMinorUnits: Number(row.daily_account_minor),
    dailyVentureMinorUnits: Number(row.daily_venture_minor),
    monthlyVentureMinorUnits: Number(row.monthly_venture_minor),
    dailyCustomerMinorUnits: numberOr(row.daily_customer_minor, row.total_minor),
    monthlyCustomerMinorUnits: numberOr(row.monthly_customer_minor, row.total_minor),
    emergencyPlatformMinorUnits: numberOr(row.emergency_platform_minor, row.total_minor),
    allowedCreativeIds: JSON.parse(row.allowed_creative_ids as string) as string[],
    approvedBy: row.approved_by as string,
    approvalRef: row.approval_ref as string,
    proposalId: row.proposal_id as string,
    notBefore: row.not_before as string,
    expiresAt: row.expires_at as string,
    issuedAt: row.issued_at as string,
  };
  const integrity = {
    organizationId: grant.organizationId,
    ventureId: grant.ventureId,
    customerId: grant.customerId,
    network: grant.network,
    externalAccountId: grant.externalAccountId,
    currency: grant.currency,
    totalMinorUnits: grant.totalMinorUnits,
    perCreativeMinorUnits: grant.perCreativeMinorUnits,
    dailyAccountMinorUnits: grant.dailyAccountMinorUnits,
    perPaidTestMinorUnits: grant.perPaidTestMinorUnits,
    perCampaignMinorUnits: grant.perCampaignMinorUnits,
    dailyVentureMinorUnits: grant.dailyVentureMinorUnits,
    monthlyVentureMinorUnits: grant.monthlyVentureMinorUnits,
    dailyCustomerMinorUnits: grant.dailyCustomerMinorUnits,
    monthlyCustomerMinorUnits: grant.monthlyCustomerMinorUnits,
    emergencyPlatformMinorUnits: grant.emergencyPlatformMinorUnits,
    allowedCreativeIds: [...grant.allowedCreativeIds],
    approvedBy: grant.approvedBy,
    approvalRef: grant.approvalRef,
    proposalId: grant.proposalId,
    notBefore: grant.notBefore,
    expiresAt: grant.expiresAt,
  };
  return {
    ...grant,
    grantHash: createHash("sha256").update(JSON.stringify(integrity)).digest("hex"),
  };
}

function insertAdoptedSpendState(
  db: SqliteDatabase,
  rows: LegacySpendRows,
  adoption: ReadonlyMap<string, LegacyTenantTarget>,
  adoptedAt: string,
): void {
  const adoptedGrants = new Map<string, StoredGrant>();
  const grantInsert = db.prepare(
    `INSERT INTO spend_grants (
      organization_id, venture_id, grant_id, customer_id, network, external_account_id,
      currency, total_minor, per_creative_minor, per_paid_test_minor, per_campaign_minor,
      daily_account_minor, daily_venture_minor, monthly_venture_minor,
      daily_customer_minor, monthly_customer_minor, emergency_platform_minor,
      allowed_creative_ids, approved_by, approval_ref, proposal_id, not_before,
      expires_at, grant_hash, issued_at, halted_reason
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const row of rows.grants) {
    const legacyVentureId = row.venture_id as string;
    const target = adoption.get(legacyVentureId)!;
    const grant = adoptedGrant(row, target);
    adoptedGrants.set(JSON.stringify([legacyVentureId, grant.grantId]), grant);
    const priorHalt = (row.halted_reason as string | null) ?? null;
    grantInsert.run(
      grant.organizationId,
      grant.ventureId,
      grant.grantId,
      grant.customerId,
      grant.network,
      grant.externalAccountId,
      grant.currency,
      grant.totalMinorUnits,
      grant.perCreativeMinorUnits,
      grant.perPaidTestMinorUnits,
      grant.perCampaignMinorUnits,
      grant.dailyAccountMinorUnits,
      grant.dailyVentureMinorUnits,
      grant.monthlyVentureMinorUnits,
      grant.dailyCustomerMinorUnits,
      grant.monthlyCustomerMinorUnits,
      grant.emergencyPlatformMinorUnits,
      JSON.stringify(grant.allowedCreativeIds),
      grant.approvedBy,
      grant.approvalRef,
      grant.proposalId,
      grant.notBefore,
      grant.expiresAt,
      grant.grantHash,
      grant.issuedAt,
      priorHalt ? `${priorHalt}; ${LEGACY_ADOPTION_HALT}` : LEGACY_ADOPTION_HALT,
    );
  }

  const reservationInsert = db.prepare(
    `INSERT INTO spend_reservations (
      organization_id, venture_id, reservation_id, idempotency_key, grant_id,
      creative_id, paid_test_id, campaign_id, external_account_id, held_minor,
      settled_minor, status, pending_reason, pending_at, reconciliation_outcome,
      reconciled_at, conservative_minor, day_key, month_key, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const row of rows.reservations) {
    const legacyVentureId = legacyVentureForChild(row, rows.grants);
    const target = adoption.get(legacyVentureId)!;
    const grant = adoptedGrants.get(JSON.stringify([legacyVentureId, row.grant_id]));
    if (!grant) throw new Error(`legacy reservation ${String(row.reservation_id)} has no grant`);
    const unsettled = row.status === "held" || row.status === "pending_reconciliation";
    reservationInsert.run(
      target.organizationId,
      target.ventureId,
      row.reservation_id,
      scopedIdempotencyKey(grant, unscopedIdempotencyKey(row.idempotency_key as string)),
      row.grant_id,
      row.creative_id,
      row.paid_test_id,
      row.campaign_id,
      row.external_account_id,
      row.held_minor,
      row.settled_minor,
      unsettled ? "released" : row.status,
      unsettled ? LEGACY_ADOPTION_HALT : ((row.pending_reason as string | null) ?? null),
      unsettled ? adoptedAt : ((row.pending_at as string | null) ?? null),
      unsettled ? null : ((row.reconciliation_outcome as string | null) ?? null),
      unsettled ? adoptedAt : ((row.reconciled_at as string | null) ?? null),
      unsettled ? Number(row.held_minor) : numberOr(row.conservative_minor, 0),
      row.day_key,
      row.month_key,
      row.created_at,
    );
  }

  const incidentInsert = db.prepare(
    `INSERT INTO spend_incidents
     (organization_id, venture_id, incident_id, grant_id, kind, detail, recorded_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  for (const row of rows.incidents) {
    const target = adoption.get(legacyVentureForChild(row, rows.grants))!;
    incidentInsert.run(
      target.organizationId,
      target.ventureId,
      row.incident_id,
      row.grant_id,
      row.kind,
      row.detail,
      row.recorded_at,
    );
  }

  const pauseInsert = db.prepare(
    `INSERT INTO provider_pause_obligations (
      organization_id, venture_id, obligation_id, grant_id, network, provider_adapter_id,
      external_account_id, campaign_id, target_key, operation_id, idempotency_key,
      request_hash, payload_json, reasons_json, incident_ids_json, state, attempt_count,
      provider_operation_id, last_diagnostic_code, last_diagnostic_message, evidence_json,
      created_at, updated_at, last_attempted_at, last_apply_state, last_read_back_state,
      last_read_back_at, last_reconciled_at, verified_at
    ) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,?,'blocked',0,NULL,?,?,?, ?,?,NULL,NULL,NULL,NULL,NULL,NULL)`,
  );
  for (const row of rows.providerPauses) {
    const legacyVentureId = legacyVentureForChild(row, rows.grants);
    const target = adoption.get(legacyVentureId)!;
    const targetKey =
      (row.target_key as string | null) ??
      (row.campaign_id as string | null) ??
      "__missing_campaign__";
    const binding = createHash("sha256")
      .update(
        JSON.stringify([
          target.organizationId,
          target.ventureId,
          row.grant_id,
          row.external_account_id,
          targetKey,
        ]),
      )
      .digest("hex");
    const evidence = row.evidence_json
      ? JSON.stringify(
          adoptLegacyTenantPayload(JSON.parse(row.evidence_json as string) as unknown, target),
        )
      : null;
    pauseInsert.run(
      target.organizationId,
      target.ventureId,
      `ppo_${binding.slice(0, 26)}`,
      row.grant_id,
      row.network,
      row.provider_adapter_id,
      row.external_account_id,
      row.campaign_id,
      targetKey,
      row.reasons_json,
      row.incident_ids_json,
      LEGACY_ADOPTION_HALT,
      "legacy tenant adoption cleared provider-pause authority; a new approved operation is required",
      evidence,
      row.created_at,
      adoptedAt,
    );
  }
}

function scopedLegacySpendRows(db: SqliteDatabase): LegacySpendRows {
  const where = ` WHERE organization_id = '${LEGACY_UNSCOPED_ORGANIZATION_ID}'`;
  return {
    grants: db.prepare(`SELECT * FROM spend_grants${where}`).all() as Record<string, unknown>[],
    reservations: hasTable(db, "spend_reservations")
      ? (db.prepare(`SELECT * FROM spend_reservations${where}`).all() as Record<string, unknown>[])
      : [],
    incidents: hasTable(db, "spend_incidents")
      ? (db.prepare(`SELECT * FROM spend_incidents${where}`).all() as Record<string, unknown>[])
      : [],
    providerPauses: hasTable(db, "provider_pause_obligations")
      ? (db.prepare(`SELECT * FROM provider_pause_obligations${where}`).all() as Record<
          string,
          unknown
        >[])
      : [],
  };
}

function requiredLegacyVentures(rows: LegacySpendRows): readonly string[] {
  assertLegacyProviderPauseIncidentBindings(rows);
  return [
    ...rows.grants.map((row) => row.venture_id as string),
    ...rows.reservations.map((row) => legacyVentureForChild(row, rows.grants)),
    ...rows.incidents.map((row) => legacyVentureForChild(row, rows.grants)),
    ...rows.providerPauses.map((row) => legacyVentureForChild(row, rows.grants)),
  ];
}

function migrateSpendOrganizationScope(db: SqliteDatabase, options: LegacyAdoptionOptions): void {
  if (!hasTable(db, "spend_grants")) {
    db.exec(SCHEMA);
    return;
  }

  if (hasColumn(db, "spend_grants", "organization_id")) {
    const rows = scopedLegacySpendRows(db);
    const requiredVentures = requiredLegacyVentures(rows);
    const adoption = resolveLegacyTenantAdoptions(
      requiredVentures,
      options.legacyAdoption,
      "spend store",
    );
    const empty =
      rows.grants.length === 0 &&
      rows.reservations.length === 0 &&
      rows.incidents.length === 0 &&
      rows.providerPauses.length === 0;
    if (empty) {
      db.exec(SCHEMA);
      return;
    }
    // A pre-existing non-sentinel orphan must not become valid merely because
    // adoption happens to materialize its missing parent at the target scope.
    // Checking before the inserts prevents that unrelated row from inheriting
    // adopted ownership or retaining historical execution authority.
    assertSpendForeignKeys(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(SCHEMA);
      ensureColumn(
        db,
        "spend_grants",
        "daily_customer_minor",
        "INTEGER NOT NULL DEFAULT 9007199254740991",
      );
      ensureColumn(
        db,
        "spend_grants",
        "monthly_customer_minor",
        "INTEGER NOT NULL DEFAULT 9007199254740991",
      );
      ensureColumn(
        db,
        "spend_grants",
        "emergency_platform_minor",
        "INTEGER NOT NULL DEFAULT 9007199254740991",
      );
      ensureColumn(db, "spend_reservations", "pending_reason", "TEXT");
      ensureColumn(db, "spend_reservations", "pending_at", "TEXT");
      ensureColumn(db, "spend_reservations", "reconciliation_outcome", "TEXT");
      ensureColumn(db, "spend_reservations", "reconciled_at", "TEXT");
      ensureColumn(db, "spend_reservations", "conservative_minor", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "provider_pause_obligations", "last_apply_state", "TEXT");
      ensureColumn(db, "provider_pause_obligations", "last_read_back_state", "TEXT");
      ensureColumn(db, "provider_pause_obligations", "last_read_back_at", "TEXT");
      ensureColumn(db, "provider_pause_obligations", "last_reconciled_at", "TEXT");
      insertAdoptedSpendState(db, rows, adoption, options.legacyAdoption!.approvedAt);
      db.prepare("DELETE FROM provider_pause_obligations WHERE organization_id = ?").run(
        LEGACY_UNSCOPED_ORGANIZATION_ID,
      );
      db.prepare("DELETE FROM spend_incidents WHERE organization_id = ?").run(
        LEGACY_UNSCOPED_ORGANIZATION_ID,
      );
      db.prepare("DELETE FROM spend_reservations WHERE organization_id = ?").run(
        LEGACY_UNSCOPED_ORGANIZATION_ID,
      );
      db.prepare("DELETE FROM spend_grants WHERE organization_id = ?").run(
        LEGACY_UNSCOPED_ORGANIZATION_ID,
      );
      assertSpendForeignKeys(db);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* transaction already closed */
      }
      throw error;
    }
    return;
  }

  const hasLegacyProviderPauses = hasTable(db, "provider_pause_obligations");
  const rows: LegacySpendRows = {
    grants: db.prepare("SELECT * FROM spend_grants").all() as Record<string, unknown>[],
    reservations: db.prepare("SELECT * FROM spend_reservations").all() as Record<string, unknown>[],
    incidents: db.prepare("SELECT * FROM spend_incidents").all() as Record<string, unknown>[],
    providerPauses: hasLegacyProviderPauses
      ? (db.prepare("SELECT * FROM provider_pause_obligations").all() as Record<string, unknown>[])
      : [],
  };
  const requiredVentures = requiredLegacyVentures(rows);
  const adoption = resolveLegacyTenantAdoptions(
    requiredVentures.length > 0
      ? requiredVentures
      : (options.legacyAdoption?.mappings.map((entry) => entry.legacyVentureId) ?? [
          "empty-legacy-spend-schema",
        ]),
    options.legacyAdoption,
    "spend store",
  );
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DROP INDEX IF EXISTS spend_res_grant");
    db.exec("DROP INDEX IF EXISTS spend_res_day");
    db.exec("DROP INDEX IF EXISTS provider_pause_pending");
    db.exec("ALTER TABLE spend_grants RENAME TO spend_grants_legacy_unscoped");
    db.exec("ALTER TABLE spend_reservations RENAME TO spend_reservations_legacy_unscoped");
    db.exec("ALTER TABLE spend_incidents RENAME TO spend_incidents_legacy_unscoped");
    if (hasLegacyProviderPauses) {
      db.exec(
        "ALTER TABLE provider_pause_obligations RENAME TO provider_pause_obligations_legacy_unscoped",
      );
    }
    db.exec(SCHEMA);
    insertAdoptedSpendState(db, rows, adoption, options.legacyAdoption!.approvedAt);
    if (hasLegacyProviderPauses) db.exec("DROP TABLE provider_pause_obligations_legacy_unscoped");
    db.exec("DROP TABLE spend_incidents_legacy_unscoped");
    db.exec("DROP TABLE spend_reservations_legacy_unscoped");
    db.exec("DROP TABLE spend_grants_legacy_unscoped");
    assertSpendForeignKeys(db);
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

function rowToGrant(row: Record<string, unknown>): StoredGrant {
  const network = row.network;
  if (network !== "tiktok_paid" && network !== "meta_paid") {
    throw new Error("stored Spend Grant has an unsupported paid network");
  }
  return {
    grantId: row.grant_id as string,
    organizationId: row.organization_id as string,
    ventureId: row.venture_id as string,
    customerId: (row.customer_id as string | null) ?? null,
    network,
    externalAccountId: row.external_account_id as string,
    currency: row.currency as string,
    totalMinorUnits: Number(row.total_minor),
    perCreativeMinorUnits: Number(row.per_creative_minor),
    perPaidTestMinorUnits: Number(row.per_paid_test_minor),
    perCampaignMinorUnits: Number(row.per_campaign_minor),
    dailyAccountMinorUnits: Number(row.daily_account_minor),
    dailyVentureMinorUnits: Number(row.daily_venture_minor),
    monthlyVentureMinorUnits: Number(row.monthly_venture_minor),
    dailyCustomerMinorUnits: Number(row.daily_customer_minor),
    monthlyCustomerMinorUnits: Number(row.monthly_customer_minor),
    emergencyPlatformMinorUnits: Number(row.emergency_platform_minor),
    allowedCreativeIds: JSON.parse(row.allowed_creative_ids as string) as string[],
    approvedBy: row.approved_by as string,
    approvalRef: row.approval_ref as string,
    proposalId: row.proposal_id as string,
    notBefore: row.not_before as string,
    expiresAt: row.expires_at as string,
    grantHash: row.grant_hash as string,
    issuedAt: row.issued_at as string,
  };
}

function rowToReservation(row: Record<string, unknown>): StoredReservation {
  const storedIdempotencyKey = row.idempotency_key as string;
  return {
    reservationId: row.reservation_id as string,
    idempotencyKey: unscopedIdempotencyKey(storedIdempotencyKey),
    grantId: row.grant_id as string,
    organizationId: row.organization_id as string,
    ventureId: row.venture_id as string,
    creativeId: row.creative_id as string,
    paidTestId: row.paid_test_id as string,
    campaignId: row.campaign_id as string,
    externalAccountId: row.external_account_id as string,
    heldMinorUnits: Number(row.held_minor),
    settledMinorUnits: row.settled_minor === null ? null : Number(row.settled_minor),
    status: row.status as StoredReservation["status"],
    pendingReason: (row.pending_reason as string | null) ?? null,
    pendingAt: (row.pending_at as string | null) ?? null,
    reconciliationOutcome:
      (row.reconciliation_outcome as StoredReservation["reconciliationOutcome"]) ?? null,
    reconciledAt: (row.reconciled_at as string | null) ?? null,
    dayKey: row.day_key as string,
    monthKey: row.month_key as string,
    createdAt: row.created_at as string,
  };
}

function rowToProviderPauseObligation(row: Record<string, unknown>): StoredProviderPauseObligation {
  return {
    obligationId: row.obligation_id as string,
    grantId: row.grant_id as string,
    organizationId: row.organization_id as string,
    ventureId: row.venture_id as string,
    network: row.network as string,
    providerAdapterId:
      (row.provider_adapter_id as StoredProviderPauseObligation["providerAdapterId"]) ?? null,
    externalAccountId: row.external_account_id as string,
    campaignId: (row.campaign_id as string | null) ?? null,
    operationId: (row.operation_id as string | null) ?? null,
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    requestHash: (row.request_hash as string | null) ?? null,
    payloadJson: (row.payload_json as string | null) ?? null,
    reasons: JSON.parse(row.reasons_json as string) as string[],
    incidentIds: JSON.parse(row.incident_ids_json as string) as string[],
    state: row.state as ProviderPauseObligationState,
    attemptCount: Number(row.attempt_count),
    providerOperationId: (row.provider_operation_id as string | null) ?? null,
    lastDiagnosticCode: (row.last_diagnostic_code as string | null) ?? null,
    lastDiagnosticMessage: (row.last_diagnostic_message as string | null) ?? null,
    evidenceJson: (row.evidence_json as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastAttemptedAt: (row.last_attempted_at as string | null) ?? null,
    lastApplyState:
      (row.last_apply_state as StoredProviderPauseObligation["lastApplyState"]) ?? null,
    lastReadBackState: (row.last_read_back_state as ProviderPauseReadBackState | null) ?? null,
    lastReadBackAt: (row.last_read_back_at as string | null) ?? null,
    lastReconciledAt: (row.last_reconciled_at as string | null) ?? null,
    verifiedAt: (row.verified_at as string | null) ?? null,
  };
}

function providerPauseTargetKey(obligation: StoredProviderPauseObligation): string {
  return obligation.campaignId ?? "__missing_campaign__";
}

function uniqueStrings(...groups: readonly (readonly string[])[]): readonly string[] {
  return [...new Set(groups.flat())];
}

/**
 * Idempotency belongs to one venture/customer boundary. A caller in another
 * tenant may legitimately choose the same opaque retry key and must never get
 * the first tenant's reservation back. The digest keeps tenant identifiers out
 * of the unique-key column while preserving the caller key after the dot for
 * diagnostics and read-back.
 */
function scopedIdempotencyKey(grant: StoredGrant, key: string): string {
  const scope = createHash("sha256")
    .update(JSON.stringify([grant.organizationId, grant.ventureId, grant.customerId]))
    .digest("hex");
  return `${scope}.${key}`;
}

function unscopedIdempotencyKey(stored: string): string {
  return /^[a-f0-9]{64}\./u.test(stored) ? stored.slice(65) : stored;
}

function reservationMatchesRequest(
  reservation: StoredReservation,
  request: ReservationRequest,
  grant: StoredGrant,
): boolean {
  return (
    reservation.grantId === request.grantId &&
    reservation.organizationId === request.organizationId &&
    reservation.ventureId === request.ventureId &&
    grant.organizationId === request.organizationId &&
    reservation.ventureId === grant.ventureId &&
    reservation.creativeId === request.creativeId &&
    reservation.paidTestId === request.paidTestId &&
    reservation.campaignId === request.campaignId &&
    reservation.externalAccountId === grant.externalAccountId &&
    reservation.heldMinorUnits === request.amountMinorUnits
  );
}

/**
 * Production-capable local store. Multiple processes may open the same file;
 * BEGIN IMMEDIATE plus busy_timeout serializes their writes.
 */
export function createSqliteSpendStore(
  filename: string,
  options: LegacyAdoptionOptions = {},
): SpendStore {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA busy_timeout = 5000");
  const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  if (journal.journal_mode.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode = WAL");
  try {
    migrateSpendOrganizationScope(db, options);
  } catch (error) {
    db.close();
    throw error;
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    // Existing local ledgers remain readable. Newly introduced caps fail closed
    // at each old grant's approved total until a replacement grant is approved.
    const addedDailyCustomer = ensureColumn(
      db,
      "spend_grants",
      "daily_customer_minor",
      "INTEGER NOT NULL DEFAULT 9007199254740991",
    );
    const addedMonthlyCustomer = ensureColumn(
      db,
      "spend_grants",
      "monthly_customer_minor",
      "INTEGER NOT NULL DEFAULT 9007199254740991",
    );
    const addedEmergencyPlatform = ensureColumn(
      db,
      "spend_grants",
      "emergency_platform_minor",
      "INTEGER NOT NULL DEFAULT 9007199254740991",
    );
    ensureColumn(db, "spend_reservations", "pending_reason", "TEXT");
    ensureColumn(db, "spend_reservations", "pending_at", "TEXT");
    ensureColumn(db, "spend_reservations", "reconciliation_outcome", "TEXT");
    ensureColumn(db, "spend_reservations", "reconciled_at", "TEXT");
    ensureColumn(db, "spend_reservations", "conservative_minor", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "provider_pause_obligations", "last_apply_state", "TEXT");
    ensureColumn(db, "provider_pause_obligations", "last_read_back_state", "TEXT");
    ensureColumn(db, "provider_pause_obligations", "last_read_back_at", "TEXT");
    ensureColumn(db, "provider_pause_obligations", "last_reconciled_at", "TEXT");
    if (addedDailyCustomer) {
      db.exec("UPDATE spend_grants SET daily_customer_minor = total_minor");
    }
    if (addedMonthlyCustomer) {
      db.exec("UPDATE spend_grants SET monthly_customer_minor = total_minor");
    }
    if (addedEmergencyPlatform) {
      db.exec("UPDATE spend_grants SET emergency_platform_minor = total_minor");
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

  function grantRow(scope: SpendScope, grantId: string): Record<string, unknown> | undefined {
    assertSpendScope(scope);
    return db
      .prepare(
        `SELECT * FROM spend_grants
         WHERE organization_id = ? AND venture_id = ? AND grant_id = ?`,
      )
      .get(scope.organizationId, scope.ventureId, grantId) as Record<string, unknown> | undefined;
  }

  /** Committed plus held: promised money constrains a cap exactly as hard as spent money. */
  function consumed(where: string, params: unknown[]): number {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(
           CASE
             WHEN status = 'settled' THEN settled_minor
             WHEN status = 'released' THEN conservative_minor
             ELSE held_minor
           END
         ), 0) AS total
         FROM spend_reservations
         WHERE (status != 'released' OR conservative_minor > 0) AND ${where}`,
      )
      .get(...(params as never[])) as { total: number };
    return Number(row.total);
  }

  function minimumLimit(
    column: string,
    where: string,
    params: unknown[],
    fallback: number,
  ): number {
    const row = db
      .prepare(`SELECT MIN(${column}) AS limit_value FROM spend_grants WHERE ${where}`)
      .get(...(params as never[])) as { limit_value: number | null };
    return row.limit_value === null ? fallback : Number(row.limit_value);
  }

  function providerPauseRow(
    scope: SpendScope,
    obligationId: string,
  ): Record<string, unknown> | undefined {
    assertSpendScope(scope);
    return db
      .prepare(
        `SELECT * FROM provider_pause_obligations
         WHERE organization_id = ? AND venture_id = ? AND obligation_id = ?`,
      )
      .get(scope.organizationId, scope.ventureId, obligationId) as
      Record<string, unknown> | undefined;
  }

  /** Called only while the caller owns the surrounding write transaction. */
  function upsertProviderPause(
    obligation: StoredProviderPauseObligation,
  ): StoredProviderPauseObligation {
    const scope = {
      organizationId: obligation.organizationId,
      ventureId: obligation.ventureId,
    };
    assertSpendScope(scope);
    const targetKey = providerPauseTargetKey(obligation);
    const existingRow = db
      .prepare(
        `SELECT * FROM provider_pause_obligations
         WHERE organization_id = ? AND venture_id = ?
           AND (obligation_id = ? OR (grant_id = ? AND target_key = ?))
         LIMIT 1`,
      )
      .get(
        obligation.organizationId,
        obligation.ventureId,
        obligation.obligationId,
        obligation.grantId,
        targetKey,
      ) as Record<string, unknown> | undefined;
    if (existingRow) {
      const existing = rowToProviderPauseObligation(existingRow);
      if (
        existing.grantId !== obligation.grantId ||
        existing.organizationId !== obligation.organizationId ||
        existing.ventureId !== obligation.ventureId ||
        providerPauseTargetKey(existing) !== targetKey
      ) {
        throw new Error("provider pause obligation id is already bound to another target");
      }
      const incidentIds = uniqueStrings(existing.incidentIds, obligation.incidentIds);
      const hasNewIncident = incidentIds.length !== existing.incidentIds.length;
      const state =
        existing.state === "verified" && hasNewIncident ? "accepted_unverified" : existing.state;
      db.prepare(
        `UPDATE provider_pause_obligations
         SET reasons_json = ?, incident_ids_json = ?, state = ?, updated_at = ?,
             verified_at = CASE WHEN ? = 'verified' THEN verified_at ELSE NULL END
         WHERE organization_id = ? AND venture_id = ? AND obligation_id = ?`,
      ).run(
        JSON.stringify(uniqueStrings(existing.reasons, obligation.reasons)),
        JSON.stringify(incidentIds),
        state,
        obligation.updatedAt,
        state,
        obligation.organizationId,
        obligation.ventureId,
        existing.obligationId,
      );
      return rowToProviderPauseObligation(providerPauseRow(scope, existing.obligationId)!);
    }

    db.prepare(
      `INSERT INTO provider_pause_obligations (
        organization_id, venture_id, obligation_id, grant_id, network, provider_adapter_id,
        external_account_id, campaign_id, target_key, operation_id, idempotency_key,
        request_hash, payload_json, reasons_json, incident_ids_json, state,
        attempt_count, provider_operation_id, last_diagnostic_code,
        last_diagnostic_message, evidence_json, created_at, updated_at,
        last_attempted_at, last_apply_state, last_read_back_state,
        last_read_back_at, last_reconciled_at, verified_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      obligation.organizationId,
      obligation.ventureId,
      obligation.obligationId,
      obligation.grantId,
      obligation.network,
      obligation.providerAdapterId,
      obligation.externalAccountId,
      obligation.campaignId,
      targetKey,
      obligation.operationId,
      obligation.idempotencyKey,
      obligation.requestHash,
      obligation.payloadJson,
      JSON.stringify(obligation.reasons),
      JSON.stringify(obligation.incidentIds),
      obligation.state,
      obligation.attemptCount,
      obligation.providerOperationId,
      obligation.lastDiagnosticCode,
      obligation.lastDiagnosticMessage,
      obligation.evidenceJson,
      obligation.createdAt,
      obligation.updatedAt,
      obligation.lastAttemptedAt,
      obligation.lastApplyState,
      obligation.lastReadBackState,
      obligation.lastReadBackAt,
      obligation.lastReconciledAt,
      obligation.verifiedAt,
    );
    return obligation;
  }

  function writeIncident(incident: StoredIncident): void {
    assertSpendScope(incident);
    db.prepare(
      `INSERT INTO spend_incidents
       (organization_id, venture_id, incident_id, grant_id, kind, detail, recorded_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(organization_id, venture_id, incident_id) DO UPDATE SET
         grant_id = excluded.grant_id,
         kind = excluded.kind,
         detail = excluded.detail,
         recorded_at = excluded.recorded_at`,
    ).run(
      incident.organizationId,
      incident.ventureId,
      incident.incidentId,
      incident.grantId,
      incident.kind,
      incident.detail,
      incident.recordedAt,
    );
  }

  return {
    label: "sqlite",
    productionSafe: true,

    putGrant(grant) {
      assertSpendScope(grant);
      db.prepare(
        `INSERT INTO spend_grants (
          organization_id, venture_id, grant_id, customer_id, network, external_account_id, currency,
          total_minor, per_creative_minor, per_paid_test_minor, per_campaign_minor,
          daily_account_minor, daily_venture_minor, monthly_venture_minor,
          daily_customer_minor, monthly_customer_minor, emergency_platform_minor,
          allowed_creative_ids, approved_by, approval_ref, proposal_id,
          not_before, expires_at, grant_hash, issued_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        grant.organizationId,
        grant.ventureId,
        grant.grantId,
        grant.customerId,
        grant.network,
        grant.externalAccountId,
        grant.currency,
        grant.totalMinorUnits,
        grant.perCreativeMinorUnits,
        grant.perPaidTestMinorUnits,
        grant.perCampaignMinorUnits,
        grant.dailyAccountMinorUnits,
        grant.dailyVentureMinorUnits,
        grant.monthlyVentureMinorUnits,
        grant.dailyCustomerMinorUnits,
        grant.monthlyCustomerMinorUnits,
        grant.emergencyPlatformMinorUnits,
        JSON.stringify(grant.allowedCreativeIds),
        grant.approvedBy,
        grant.approvalRef,
        grant.proposalId,
        grant.notBefore,
        grant.expiresAt,
        grant.grantHash,
        grant.issuedAt,
      );
    },

    getGrant(scope, grantId) {
      const row = grantRow(scope, grantId);
      return row ? rowToGrant(row) : undefined;
    },

    reserveAtomically(request) {
      assertSpendScope(request);
      db.exec("BEGIN IMMEDIATE");
      try {
        const scope = {
          organizationId: request.organizationId,
          ventureId: request.ventureId,
        };
        const row = grantRow(scope, request.grantId);
        if (!row) throw new Error(`unknown grant ${request.grantId}`);
        const grant = rowToGrant(row);
        const scopedKey = scopedIdempotencyKey(grant, request.idempotencyKey);
        const replay = db
          .prepare(
            `SELECT reservation.* FROM spend_reservations AS reservation
             JOIN spend_grants AS owner
               ON owner.organization_id = reservation.organization_id
              AND owner.venture_id = reservation.venture_id
              AND owner.grant_id = reservation.grant_id
             WHERE reservation.organization_id = ? AND reservation.venture_id = ?
               AND (reservation.idempotency_key = ?
                OR (reservation.idempotency_key = ?
                    AND owner.organization_id = ? AND owner.venture_id = ?
                    AND owner.customer_id IS ?))
             LIMIT 1`,
          )
          // The raw-key lookup is a fail-safe migration path for pre-fix local
          // ledgers. It may replay only after the complete binding matches.
          .get(
            grant.organizationId,
            grant.ventureId,
            scopedKey,
            request.idempotencyKey,
            grant.organizationId,
            grant.ventureId,
            grant.customerId,
          ) as Record<string, unknown> | undefined;
        if (replay) {
          const reservation = rowToReservation(replay);
          db.exec("ROLLBACK");
          return reservationMatchesRequest(reservation, request, grant)
            ? { kind: "idempotent_replay", reservation }
            : { kind: "idempotency_conflict" };
        }

        const halted = row.halted_reason as string | null;
        if (halted) {
          db.exec("ROLLBACK");
          return { kind: "halted", reason: halted };
        }

        const amount = request.amountMinorUnits;
        const checks: Array<{ cap: keyof CapUsage; used: number; limit: number }> = [
          {
            cap: "grantTotal",
            used: consumed("organization_id = ? AND venture_id = ? AND grant_id = ?", [
              grant.organizationId,
              grant.ventureId,
              request.grantId,
            ]),
            limit: grant.totalMinorUnits,
          },
          {
            cap: "monthlyVenture",
            used: consumed("organization_id = ? AND venture_id = ? AND month_key = ?", [
              grant.organizationId,
              grant.ventureId,
              request.monthKey,
            ]),
            limit: minimumLimit(
              "monthly_venture_minor",
              "organization_id = ? AND venture_id = ?",
              [grant.organizationId, grant.ventureId],
              grant.monthlyVentureMinorUnits,
            ),
          },
          {
            cap: "dailyVenture",
            used: consumed("organization_id = ? AND venture_id = ? AND day_key = ?", [
              grant.organizationId,
              grant.ventureId,
              request.dayKey,
            ]),
            limit: minimumLimit(
              "daily_venture_minor",
              "organization_id = ? AND venture_id = ?",
              [grant.organizationId, grant.ventureId],
              grant.dailyVentureMinorUnits,
            ),
          },
          ...(grant.customerId === null
            ? []
            : [
                {
                  cap: "monthlyCustomer" as const,
                  used: consumed(
                    `organization_id = ? AND grant_id IN (
                       SELECT grant_id FROM spend_grants
                       WHERE organization_id = ? AND customer_id = ?
                     ) AND month_key = ?`,
                    [
                      grant.organizationId,
                      grant.organizationId,
                      grant.customerId,
                      request.monthKey,
                    ],
                  ),
                  limit: minimumLimit(
                    "monthly_customer_minor",
                    "organization_id = ? AND customer_id = ?",
                    [grant.organizationId, grant.customerId],
                    grant.monthlyCustomerMinorUnits,
                  ),
                },
                {
                  cap: "dailyCustomer" as const,
                  used: consumed(
                    `organization_id = ? AND grant_id IN (
                       SELECT grant_id FROM spend_grants
                       WHERE organization_id = ? AND customer_id = ?
                     ) AND day_key = ?`,
                    [grant.organizationId, grant.organizationId, grant.customerId, request.dayKey],
                  ),
                  limit: minimumLimit(
                    "daily_customer_minor",
                    "organization_id = ? AND customer_id = ?",
                    [grant.organizationId, grant.customerId],
                    grant.dailyCustomerMinorUnits,
                  ),
                },
              ]),
          {
            cap: "emergencyPlatform",
            used: consumed(
              `organization_id = ? AND grant_id IN (
                 SELECT grant_id FROM spend_grants
                 WHERE organization_id = ? AND network = ?
               )`,
              [grant.organizationId, grant.organizationId, grant.network],
            ),
            // A later grant may lower this emergency ceiling but can never
            // silently raise a ceiling already present for the platform.
            limit: minimumLimit(
              "emergency_platform_minor",
              "organization_id = ? AND network = ?",
              [grant.organizationId, grant.network],
              grant.emergencyPlatformMinorUnits,
            ),
          },
          {
            cap: "dailyAccount",
            used: consumed("organization_id = ? AND external_account_id = ? AND day_key = ?", [
              grant.organizationId,
              grant.externalAccountId,
              request.dayKey,
            ]),
            limit: minimumLimit(
              "daily_account_minor",
              "organization_id = ? AND external_account_id = ?",
              [grant.organizationId, grant.externalAccountId],
              grant.dailyAccountMinorUnits,
            ),
          },
          {
            cap: "perCampaign",
            used: consumed(
              "organization_id = ? AND venture_id = ? AND grant_id = ? AND campaign_id = ?",
              [grant.organizationId, grant.ventureId, request.grantId, request.campaignId],
            ),
            limit: grant.perCampaignMinorUnits,
          },
          {
            cap: "perPaidTest",
            used: consumed(
              "organization_id = ? AND venture_id = ? AND grant_id = ? AND paid_test_id = ?",
              [grant.organizationId, grant.ventureId, request.grantId, request.paidTestId],
            ),
            limit: grant.perPaidTestMinorUnits,
          },
          {
            cap: "perCreative",
            used: consumed(
              "organization_id = ? AND venture_id = ? AND grant_id = ? AND creative_id = ?",
              [grant.organizationId, grant.ventureId, request.grantId, request.creativeId],
            ),
            limit: grant.perCreativeMinorUnits,
          },
        ];

        for (const check of checks) {
          if (check.used + amount > check.limit) {
            db.exec("ROLLBACK");
            return {
              kind: "cap_exceeded",
              cap: check.cap,
              attempted: check.used + amount,
              limit: check.limit,
            };
          }
        }

        db.prepare(
          `INSERT INTO spend_reservations (
            organization_id, venture_id, reservation_id, idempotency_key, grant_id, creative_id,
            paid_test_id, campaign_id, external_account_id, held_minor, settled_minor,
            status, day_key, month_key, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'held',?,?,?)`,
        ).run(
          grant.organizationId,
          grant.ventureId,
          request.reservationId,
          scopedKey,
          request.grantId,
          request.creativeId,
          request.paidTestId,
          request.campaignId,
          grant.externalAccountId,
          amount,
          request.dayKey,
          request.monthKey,
          request.createdAt,
        );
        db.exec("COMMIT");

        return {
          kind: "created",
          reservation: rowToReservation(
            db
              .prepare(
                `SELECT * FROM spend_reservations
                 WHERE organization_id = ? AND venture_id = ? AND reservation_id = ?`,
              )
              .get(grant.organizationId, grant.ventureId, request.reservationId) as Record<
              string,
              unknown
            >,
          ),
        };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* transaction already closed */
        }
        throw error;
      }
    },

    settleAtomically(
      scope,
      reservationId,
      settledMinorUnits,
      incident,
      reconciledAt,
      providerPause,
    ) {
      assertSpendScope(scope);
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(
            `SELECT * FROM spend_reservations
             WHERE organization_id = ? AND venture_id = ? AND reservation_id = ?`,
          )
          .get(scope.organizationId, scope.ventureId, reservationId) as
          Record<string, unknown> | undefined;
        if (!row) {
          db.exec("ROLLBACK");
          return undefined;
        }
        const current = rowToReservation(row);
        if (current.status !== "held" && current.status !== "pending_reconciliation") {
          db.exec("ROLLBACK");
          return current;
        }
        db.prepare(
          `UPDATE spend_reservations
           SET status = 'settled', settled_minor = ?,
               reconciliation_outcome = CASE WHEN status = 'pending_reconciliation' THEN 'present' ELSE reconciliation_outcome END,
               reconciled_at = CASE WHEN status = 'pending_reconciliation' THEN ? ELSE reconciled_at END
           WHERE organization_id = ? AND venture_id = ? AND reservation_id = ?
             AND status IN ('held', 'pending_reconciliation')`,
        ).run(
          settledMinorUnits,
          reconciledAt ?? null,
          scope.organizationId,
          scope.ventureId,
          reservationId,
        );
        if (incident) {
          if (
            incident.organizationId !== scope.organizationId ||
            incident.ventureId !== scope.ventureId
          ) {
            throw new Error("spend incident scope does not match reservation scope");
          }
          writeIncident(incident);
          db.prepare(
            `UPDATE spend_grants SET halted_reason = ?
             WHERE organization_id = ? AND venture_id = ? AND grant_id = ?`,
          ).run(incident.detail, incident.organizationId, incident.ventureId, incident.grantId);
          if (providerPause) upsertProviderPause(providerPause);
        }
        db.exec("COMMIT");
        const settled = db
          .prepare(
            `SELECT * FROM spend_reservations
             WHERE organization_id = ? AND venture_id = ? AND reservation_id = ?`,
          )
          .get(scope.organizationId, scope.ventureId, reservationId) as Record<string, unknown>;
        return rowToReservation(settled);
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* transaction already closed */
        }
        throw error;
      }
    },

    markPendingReconciliation(scope, reservationId, reason, markedAt) {
      assertSpendScope(scope);
      db.prepare(
        `UPDATE spend_reservations
         SET status = 'pending_reconciliation', pending_reason = ?, pending_at = ?
         WHERE organization_id = ? AND venture_id = ? AND reservation_id = ?
           AND status = 'held'`,
      ).run(reason, markedAt, scope.organizationId, scope.ventureId, reservationId);
      return this.getReservation(scope, reservationId);
    },

    reconcileAbsent(scope, reservationId, reconciledAt) {
      assertSpendScope(scope);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `UPDATE spend_reservations
           SET status = 'released', reconciliation_outcome = 'absent', reconciled_at = ?
           WHERE organization_id = ? AND venture_id = ? AND reservation_id = ?
             AND status = 'pending_reconciliation'`,
        ).run(reconciledAt, scope.organizationId, scope.ventureId, reservationId);
        db.exec("COMMIT");
        return this.getReservation(scope, reservationId);
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* transaction already closed */
        }
        throw error;
      }
    },

    release(scope, reservationId) {
      assertSpendScope(scope);
      db.prepare(
        `UPDATE spend_reservations SET status = 'released'
         WHERE organization_id = ? AND venture_id = ? AND reservation_id = ? AND status = 'held'`,
      ).run(scope.organizationId, scope.ventureId, reservationId);
      return this.getReservation(scope, reservationId);
    },

    getReservation(scope, reservationId) {
      assertSpendScope(scope);
      const row = db
        .prepare(
          `SELECT * FROM spend_reservations
           WHERE organization_id = ? AND venture_id = ? AND reservation_id = ?`,
        )
        .get(scope.organizationId, scope.ventureId, reservationId) as
        Record<string, unknown> | undefined;
      return row ? rowToReservation(row) : undefined;
    },

    listReservations(scope, grantId) {
      assertSpendScope(scope);
      return (
        db
          .prepare(
            `SELECT * FROM spend_reservations
             WHERE organization_id = ? AND venture_id = ? AND grant_id = ? ORDER BY created_at`,
          )
          .all(scope.organizationId, scope.ventureId, grantId) as Record<string, unknown>[]
      ).map(rowToReservation);
    },

    halt(scope, grantId, reason) {
      assertSpendScope(scope);
      db.prepare(
        `UPDATE spend_grants SET halted_reason = ?
         WHERE organization_id = ? AND venture_id = ? AND grant_id = ?`,
      ).run(reason, scope.organizationId, scope.ventureId, grantId);
    },

    haltReason(scope, grantId) {
      return (grantRow(scope, grantId)?.halted_reason as string | null) ?? undefined;
    },

    recordIncident(incident) {
      writeIncident(incident);
    },

    listIncidents(scope, grantId) {
      assertSpendScope(scope);
      return (
        db
          .prepare(
            `SELECT * FROM spend_incidents
             WHERE organization_id = ? AND venture_id = ? AND grant_id = ? ORDER BY recorded_at`,
          )
          .all(scope.organizationId, scope.ventureId, grantId) as Record<string, unknown>[]
      ).map((row) => ({
        incidentId: row.incident_id as string,
        grantId: row.grant_id as string,
        organizationId: row.organization_id as string,
        ventureId: row.venture_id as string,
        kind: row.kind as string,
        detail: row.detail as string,
        recordedAt: row.recorded_at as string,
      }));
    },

    haltAndQueueProviderPauses(scope, grantId, reason, obligations, incidentEntries) {
      assertSpendScope(scope);
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!grantRow(scope, grantId)) throw new Error(`unknown grant ${grantId}`);
        db.prepare(
          `UPDATE spend_grants SET halted_reason = ?
           WHERE organization_id = ? AND venture_id = ? AND grant_id = ?`,
        ).run(reason, scope.organizationId, scope.ventureId, grantId);
        for (const incident of incidentEntries) writeIncident(incident);
        const stored = obligations.map(upsertProviderPause);
        db.exec("COMMIT");
        return stored;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* transaction already closed */
        }
        throw error;
      }
    },

    getProviderPauseObligation(scope, obligationId) {
      const row = providerPauseRow(scope, obligationId);
      return row ? rowToProviderPauseObligation(row) : undefined;
    },

    listProviderPauseObligations(scope, grantId) {
      assertSpendScope(scope);
      return (
        db
          .prepare(
            `SELECT * FROM provider_pause_obligations
             WHERE organization_id = ? AND venture_id = ? AND grant_id = ?
             ORDER BY created_at, obligation_id`,
          )
          .all(scope.organizationId, scope.ventureId, grantId) as Record<string, unknown>[]
      ).map(rowToProviderPauseObligation);
    },

    claimProviderPauseAttempt(scope, obligationId, attemptedAt) {
      assertSpendScope(scope);
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = providerPauseRow(scope, obligationId);
        if (!row) throw new Error(`unknown provider pause obligation ${obligationId}`);
        const current = rowToProviderPauseObligation(row);
        if (current.state === "verified") {
          db.exec("ROLLBACK");
          return { kind: "complete", obligation: current };
        }
        if (current.attemptCount > 0 || current.state === "blocked") {
          db.exec("ROLLBACK");
          return { kind: "reconcile", obligation: current };
        }
        db.prepare(
          `UPDATE provider_pause_obligations
           SET state = 'attempting', attempt_count = attempt_count + 1,
               last_attempted_at = ?, updated_at = ?
           WHERE organization_id = ? AND venture_id = ? AND obligation_id = ?
             AND attempt_count = 0`,
        ).run(attemptedAt, attemptedAt, scope.organizationId, scope.ventureId, obligationId);
        const claimed = rowToProviderPauseObligation(providerPauseRow(scope, obligationId)!);
        db.exec("COMMIT");
        return { kind: "claimed", obligation: claimed };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* transaction already closed */
        }
        throw error;
      }
    },

    updateProviderPauseObligation(scope, obligationId, update) {
      assertSpendScope(scope);
      db.prepare(
        `UPDATE provider_pause_obligations
         SET state = ?, provider_operation_id = ?, last_diagnostic_code = ?,
             last_diagnostic_message = ?, evidence_json = ?, updated_at = ?,
             last_apply_state = COALESCE(?, last_apply_state),
             last_read_back_state = COALESCE(?, last_read_back_state),
             last_read_back_at = COALESCE(?, last_read_back_at),
             last_reconciled_at = COALESCE(?, last_reconciled_at), verified_at = ?
         WHERE organization_id = ? AND venture_id = ? AND obligation_id = ?
           AND (state != 'verified' OR ? = 'verified')`,
      ).run(
        update.state,
        update.providerOperationId,
        update.lastDiagnosticCode,
        update.lastDiagnosticMessage,
        update.evidenceJson,
        update.updatedAt,
        update.lastApplyState ?? null,
        update.lastReadBackState ?? null,
        update.lastReadBackAt ?? null,
        update.lastReconciledAt ?? null,
        update.verifiedAt,
        scope.organizationId,
        scope.ventureId,
        obligationId,
        update.state,
      );
      const row = providerPauseRow(scope, obligationId);
      return row ? rowToProviderPauseObligation(row) : undefined;
    },

    close() {
      db.close();
    },
  };
}

/**
 * Single-process store for unit tests and local fixtures. NOT production safe:
 * it cannot serialize writers in another process, which is exactly the hazard
 * the SQLite store exists to close.
 */
export function createMemorySpendStore(): SpendStore {
  const grants = new Map<string, StoredGrant>();
  const halted = new Map<string, string>();
  const reservations = new Map<string, StoredReservation>();
  const byIdempotency = new Map<string, string>();
  const incidents = new Map<string, StoredIncident>();
  const providerPauses = new Map<string, StoredProviderPauseObligation>();
  const providerPauseByTarget = new Map<string, string>();
  const entityKey = (scope: SpendScope, id: string) => {
    assertSpendScope(scope);
    return JSON.stringify([scope.organizationId, scope.ventureId, id]);
  };
  const grantKey = (grant: StoredGrant) => entityKey(grant, grant.grantId);
  const reservationKey = (reservation: StoredReservation) =>
    entityKey(reservation, reservation.reservationId);
  const incidentKey = (incident: StoredIncident) => entityKey(incident, incident.incidentId);
  const pauseKey = (obligation: StoredProviderPauseObligation) =>
    entityKey(obligation, obligation.obligationId);

  const consumed = (predicate: (entry: StoredReservation) => boolean): number =>
    [...reservations.values()]
      .filter((entry) => entry.status !== "released" && predicate(entry))
      .reduce(
        (sum, entry) =>
          sum +
          (entry.status === "settled" ? (entry.settledMinorUnits ?? 0) : entry.heldMinorUnits),
        0,
      );
  const minimumLimit = (
    predicate: (grant: StoredGrant) => boolean,
    select: (grant: StoredGrant) => number,
    fallback: number,
  ): number => {
    const values = [...grants.values()].filter(predicate).map(select);
    return values.length === 0 ? fallback : Math.min(...values);
  };
  const upsertProviderPause = (
    obligation: StoredProviderPauseObligation,
  ): StoredProviderPauseObligation => {
    const targetKey = JSON.stringify([
      obligation.organizationId,
      obligation.ventureId,
      obligation.grantId,
      providerPauseTargetKey(obligation),
    ]);
    const key = pauseKey(obligation);
    const existingId = providerPauses.has(key) ? key : providerPauseByTarget.get(targetKey);
    if (existingId) {
      const existing = providerPauses.get(existingId)!;
      if (
        existing.grantId !== obligation.grantId ||
        existing.organizationId !== obligation.organizationId ||
        existing.ventureId !== obligation.ventureId ||
        providerPauseTargetKey(existing) !== providerPauseTargetKey(obligation)
      ) {
        throw new Error("provider pause obligation id is already bound to another target");
      }
      const incidentIds = uniqueStrings(existing.incidentIds, obligation.incidentIds);
      const next = {
        ...existing,
        reasons: uniqueStrings(existing.reasons, obligation.reasons),
        incidentIds,
        state:
          existing.state === "verified" && incidentIds.length !== existing.incidentIds.length
            ? ("accepted_unverified" as const)
            : existing.state,
        updatedAt: obligation.updatedAt,
        verifiedAt:
          existing.state === "verified" && incidentIds.length === existing.incidentIds.length
            ? existing.verifiedAt
            : null,
      };
      providerPauses.set(existingId, next);
      return next;
    }
    providerPauses.set(key, obligation);
    providerPauseByTarget.set(targetKey, key);
    return obligation;
  };

  return {
    label: "memory (test only)",
    productionSafe: false,
    putGrant: (grant) => void grants.set(grantKey(grant), grant),
    getGrant: (scope, grantId) => grants.get(entityKey(scope, grantId)),

    reserveAtomically(request) {
      const scope = { organizationId: request.organizationId, ventureId: request.ventureId };
      const grant = grants.get(entityKey(scope, request.grantId));
      if (!grant) throw new Error(`unknown grant ${request.grantId}`);
      const scopedKey = scopedIdempotencyKey(grant, request.idempotencyKey);
      const replayId = byIdempotency.get(scopedKey);
      if (replayId) {
        const reservation = reservations.get(replayId)!;
        return reservationMatchesRequest(reservation, request, grant)
          ? { kind: "idempotent_replay", reservation }
          : { kind: "idempotency_conflict" };
      }

      const haltedReason = halted.get(entityKey(scope, request.grantId));
      if (haltedReason) return { kind: "halted", reason: haltedReason };

      const amount = request.amountMinorUnits;
      const checks: Array<{ cap: keyof CapUsage; used: number; limit: number }> = [
        {
          cap: "grantTotal",
          used: consumed(
            (e) =>
              e.organizationId === grant.organizationId &&
              e.ventureId === grant.ventureId &&
              e.grantId === request.grantId,
          ),
          limit: grant.totalMinorUnits,
        },
        {
          cap: "monthlyVenture",
          used: consumed(
            (e) =>
              e.organizationId === grant.organizationId &&
              e.ventureId === grant.ventureId &&
              e.monthKey === request.monthKey,
          ),
          limit: minimumLimit(
            (candidate) =>
              candidate.organizationId === grant.organizationId &&
              candidate.ventureId === grant.ventureId,
            (candidate) => candidate.monthlyVentureMinorUnits,
            grant.monthlyVentureMinorUnits,
          ),
        },
        {
          cap: "dailyVenture",
          used: consumed(
            (e) =>
              e.organizationId === grant.organizationId &&
              e.ventureId === grant.ventureId &&
              e.dayKey === request.dayKey,
          ),
          limit: minimumLimit(
            (candidate) =>
              candidate.organizationId === grant.organizationId &&
              candidate.ventureId === grant.ventureId,
            (candidate) => candidate.dailyVentureMinorUnits,
            grant.dailyVentureMinorUnits,
          ),
        },
        ...(grant.customerId === null
          ? []
          : [
              {
                cap: "monthlyCustomer" as const,
                used: consumed((e) => {
                  const owner = grants.get(entityKey(e, e.grantId));
                  return (
                    owner?.organizationId === grant.organizationId &&
                    owner.customerId === grant.customerId &&
                    e.monthKey === request.monthKey
                  );
                }),
                limit: minimumLimit(
                  (candidate) =>
                    candidate.organizationId === grant.organizationId &&
                    candidate.customerId === grant.customerId,
                  (candidate) => candidate.monthlyCustomerMinorUnits,
                  grant.monthlyCustomerMinorUnits,
                ),
              },
              {
                cap: "dailyCustomer" as const,
                used: consumed((e) => {
                  const owner = grants.get(entityKey(e, e.grantId));
                  return (
                    owner?.organizationId === grant.organizationId &&
                    owner.customerId === grant.customerId &&
                    e.dayKey === request.dayKey
                  );
                }),
                limit: minimumLimit(
                  (candidate) =>
                    candidate.organizationId === grant.organizationId &&
                    candidate.customerId === grant.customerId,
                  (candidate) => candidate.dailyCustomerMinorUnits,
                  grant.dailyCustomerMinorUnits,
                ),
              },
            ]),
        {
          cap: "emergencyPlatform",
          used: consumed((e) => {
            const owner = grants.get(entityKey(e, e.grantId));
            return (
              owner?.organizationId === grant.organizationId && owner.network === grant.network
            );
          }),
          limit: minimumLimit(
            (candidate) =>
              candidate.organizationId === grant.organizationId &&
              candidate.network === grant.network,
            (candidate) => candidate.emergencyPlatformMinorUnits,
            grant.emergencyPlatformMinorUnits,
          ),
        },
        {
          cap: "dailyAccount",
          used: consumed(
            (e) =>
              e.organizationId === grant.organizationId &&
              e.externalAccountId === grant.externalAccountId &&
              e.dayKey === request.dayKey,
          ),
          limit: minimumLimit(
            (candidate) =>
              candidate.organizationId === grant.organizationId &&
              candidate.externalAccountId === grant.externalAccountId,
            (candidate) => candidate.dailyAccountMinorUnits,
            grant.dailyAccountMinorUnits,
          ),
        },
        {
          cap: "perCampaign",
          used: consumed(
            (e) =>
              e.organizationId === grant.organizationId &&
              e.ventureId === grant.ventureId &&
              e.grantId === request.grantId &&
              e.campaignId === request.campaignId,
          ),
          limit: grant.perCampaignMinorUnits,
        },
        {
          cap: "perPaidTest",
          used: consumed(
            (e) =>
              e.organizationId === grant.organizationId &&
              e.ventureId === grant.ventureId &&
              e.grantId === request.grantId &&
              e.paidTestId === request.paidTestId,
          ),
          limit: grant.perPaidTestMinorUnits,
        },
        {
          cap: "perCreative",
          used: consumed(
            (e) =>
              e.organizationId === grant.organizationId &&
              e.ventureId === grant.ventureId &&
              e.grantId === request.grantId &&
              e.creativeId === request.creativeId,
          ),
          limit: grant.perCreativeMinorUnits,
        },
      ];

      for (const check of checks) {
        if (check.used + amount > check.limit) {
          return {
            kind: "cap_exceeded",
            cap: check.cap,
            attempted: check.used + amount,
            limit: check.limit,
          };
        }
      }

      const reservation: StoredReservation = {
        reservationId: request.reservationId,
        idempotencyKey: request.idempotencyKey,
        grantId: request.grantId,
        organizationId: grant.organizationId,
        ventureId: grant.ventureId,
        creativeId: request.creativeId,
        paidTestId: request.paidTestId,
        campaignId: request.campaignId,
        externalAccountId: grant.externalAccountId,
        heldMinorUnits: amount,
        settledMinorUnits: null,
        status: "held",
        pendingReason: null,
        pendingAt: null,
        reconciliationOutcome: null,
        reconciledAt: null,
        dayKey: request.dayKey,
        monthKey: request.monthKey,
        createdAt: request.createdAt,
      };
      const key = reservationKey(reservation);
      reservations.set(key, reservation);
      byIdempotency.set(scopedKey, key);
      return { kind: "created", reservation };
    },

    settleAtomically(
      scope,
      reservationId,
      settledMinorUnits,
      incident,
      reconciledAt,
      providerPause,
    ) {
      const key = entityKey(scope, reservationId);
      const entry = reservations.get(key);
      if (!entry || (entry.status !== "held" && entry.status !== "pending_reconciliation")) {
        return entry;
      }
      const wasPending = entry.status === "pending_reconciliation";
      const next = {
        ...entry,
        status: "settled" as const,
        settledMinorUnits,
        reconciliationOutcome: wasPending ? ("present" as const) : entry.reconciliationOutcome,
        reconciledAt: wasPending ? (reconciledAt ?? null) : entry.reconciledAt,
      };
      reservations.set(key, next);
      if (incident) {
        incidents.set(incidentKey(incident), incident);
        halted.set(entityKey(incident, incident.grantId), incident.detail);
        if (providerPause) upsertProviderPause(providerPause);
      }
      return next;
    },

    markPendingReconciliation(scope, reservationId, reason, markedAt) {
      const key = entityKey(scope, reservationId);
      const entry = reservations.get(key);
      if (!entry || entry.status !== "held") return entry;
      const next = {
        ...entry,
        status: "pending_reconciliation" as const,
        pendingReason: reason,
        pendingAt: markedAt,
      };
      reservations.set(key, next);
      return next;
    },

    reconcileAbsent(scope, reservationId, reconciledAt) {
      const key = entityKey(scope, reservationId);
      const entry = reservations.get(key);
      if (!entry || entry.status !== "pending_reconciliation") return entry;
      const next = {
        ...entry,
        status: "released" as const,
        reconciliationOutcome: "absent" as const,
        reconciledAt,
      };
      reservations.set(key, next);
      return next;
    },

    release(scope, reservationId) {
      const key = entityKey(scope, reservationId);
      const entry = reservations.get(key);
      if (!entry || entry.status !== "held") return entry;
      const next = { ...entry, status: "released" as const };
      reservations.set(key, next);
      return next;
    },

    getReservation: (scope, reservationId) => reservations.get(entityKey(scope, reservationId)),
    listReservations: (scope, grantId) => (
      assertSpendScope(scope),
      [...reservations.values()].filter(
        (entry) =>
          entry.organizationId === scope.organizationId &&
          entry.ventureId === scope.ventureId &&
          entry.grantId === grantId,
      )
    ),
    halt: (scope, grantId, reason) => void halted.set(entityKey(scope, grantId), reason),
    haltReason: (scope, grantId) => halted.get(entityKey(scope, grantId)),
    recordIncident: (incident) => void incidents.set(incidentKey(incident), incident),
    listIncidents: (scope, grantId) => (
      assertSpendScope(scope),
      [...incidents.values()].filter(
        (entry) =>
          entry.organizationId === scope.organizationId &&
          entry.ventureId === scope.ventureId &&
          entry.grantId === grantId,
      )
    ),
    haltAndQueueProviderPauses(scope, grantId, reason, obligations, incidentEntries) {
      if (!grants.has(entityKey(scope, grantId))) throw new Error(`unknown grant ${grantId}`);
      halted.set(entityKey(scope, grantId), reason);
      for (const incident of incidentEntries) incidents.set(incidentKey(incident), incident);
      return obligations.map(upsertProviderPause);
    },
    getProviderPauseObligation: (scope, obligationId) =>
      providerPauses.get(entityKey(scope, obligationId)),
    listProviderPauseObligations: (scope, grantId) => (
      assertSpendScope(scope),
      [...providerPauses.values()].filter(
        (entry) =>
          entry.organizationId === scope.organizationId &&
          entry.ventureId === scope.ventureId &&
          entry.grantId === grantId,
      )
    ),
    claimProviderPauseAttempt(scope, obligationId, attemptedAt) {
      const key = entityKey(scope, obligationId);
      const current = providerPauses.get(key);
      if (!current) throw new Error(`unknown provider pause obligation ${obligationId}`);
      if (current.state === "verified") return { kind: "complete", obligation: current };
      if (current.attemptCount > 0 || current.state === "blocked") {
        return { kind: "reconcile", obligation: current };
      }
      const claimed = {
        ...current,
        state: "attempting" as const,
        attemptCount: current.attemptCount + 1,
        lastAttemptedAt: attemptedAt,
        updatedAt: attemptedAt,
      };
      providerPauses.set(key, claimed);
      return { kind: "claimed", obligation: claimed };
    },
    updateProviderPauseObligation(scope, obligationId, update) {
      const key = entityKey(scope, obligationId);
      const current = providerPauses.get(key);
      if (!current) return undefined;
      if (current.state === "verified" && update.state !== "verified") return current;
      const next = {
        ...current,
        ...update,
        lastApplyState: update.lastApplyState ?? current.lastApplyState,
        lastReadBackState: update.lastReadBackState ?? current.lastReadBackState,
        lastReadBackAt: update.lastReadBackAt ?? current.lastReadBackAt,
        lastReconciledAt: update.lastReconciledAt ?? current.lastReconciledAt,
      };
      providerPauses.set(key, next);
      return next;
    },
    close: () => {},
  };
}
