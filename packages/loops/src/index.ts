import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  assertCredentialFree,
  initializeSqliteWal,
  stableJson,
  tenantKey,
  type JsonObject,
  type JsonValue,
  type TenantRef,
} from "@venture-harness/core";

export interface BoundedLoopResult<State extends JsonValue> {
  state: State;
  iterations: number;
  stopReason: "condition" | "maximum_iterations";
}

export async function runBoundedLoop<State extends JsonValue>(options: {
  initial: State;
  maximumIterations: number;
  step(state: State, iteration: number): Promise<State> | State;
  stop(state: State, iteration: number): boolean;
}): Promise<BoundedLoopResult<State>> {
  if (!Number.isInteger(options.maximumIterations) || options.maximumIterations < 1)
    throw new Error("maximumIterations must be positive");
  let state = structuredClone(options.initial);
  for (let iteration = 0; iteration < options.maximumIterations; iteration += 1) {
    if (options.stop(state, iteration))
      return { state, iterations: iteration, stopReason: "condition" };
    state = await options.step(state, iteration + 1);
  }
  return { state, iterations: options.maximumIterations, stopReason: "maximum_iterations" };
}

export const VENTURE_LOOP_IDS = [
  "inner_build",
  "provider_verification",
  "launch",
  "daily_early_signal",
  "weekly_growth",
  "biweekly_product",
  "monthly_strategy",
  "winner_metric_snapshots",
  "creative_fatigue",
  "fleet_upgrade",
] as const;

export type VentureLoopId = (typeof VENTURE_LOOP_IDS)[number];
export type LoopAutonomy =
  "observe" | "report" | "propose" | "open_pr" | "apply_low_risk" | "apply_within_policy";
export type LoopTriggerKind = "manual" | "schedule" | "event";
export type LoopRisk = "low" | "moderate" | "high" | "critical";
export type LoopMetricDirection = "increase" | "decrease" | "maintain" | "observe";
export type LoopMetricOperator = "lt" | "lte" | "eq" | "gte" | "gt";

export interface LoopTrigger {
  readonly kind: LoopTriggerKind;
  /** A cron expression, event name, or stable manual trigger name. */
  readonly expression: string;
}

export interface LoopInputSource {
  readonly id: string;
  readonly required: boolean;
  readonly freshnessSeconds: number;
}

export interface LoopMetricReference {
  readonly sourceId: string;
  readonly metricId: string;
  readonly direction: LoopMetricDirection;
}

export interface LoopMetricPredicate {
  readonly sourceId: string;
  readonly metricId: string;
  readonly operator: LoopMetricOperator;
  readonly threshold: number;
}

export interface LoopGuardrail extends LoopMetricPredicate {
  readonly id: string;
  readonly onBreach: "stop";
}

export interface LoopDecisionAction {
  readonly kind: "observation" | "proposal" | "verified_fix" | "pull_request" | "policy_action";
  readonly title: string;
  readonly decisionSurface: string;
  readonly effect: string;
  readonly risk: LoopRisk;
  readonly policyApproved: boolean;
}

export interface LoopDecisionRule {
  readonly id: string;
  readonly when: readonly LoopMetricPredicate[];
  readonly action: LoopDecisionAction;
}

export interface LoopCompletionRule {
  readonly mode: "all" | "any";
  readonly when: readonly LoopMetricPredicate[];
  readonly description: string;
}

export type LoopStopKind =
  | "insufficient_evidence"
  | "guardrail_breach"
  | "authorization_unavailable"
  | "completion_unsatisfied"
  | "maximum_actions"
  | "maximum_iterations"
  | "unknown_effect"
  | "completed";

export interface LoopStopCondition {
  readonly kind: LoopStopKind;
  readonly description: string;
}

export interface VentureLoopDefinition {
  readonly schemaVersion: 1;
  readonly id: VentureLoopId;
  readonly title: string;
  readonly trigger: LoopTrigger;
  readonly inputSources: readonly LoopInputSource[];
  readonly primaryMetrics: readonly LoopMetricReference[];
  readonly guardrails: readonly LoopGuardrail[];
  readonly decisionRules: readonly LoopDecisionRule[];
  readonly completion: LoopCompletionRule;
  readonly maximumActions: number;
  readonly maximumIterations: number;
  readonly autonomy: LoopAutonomy;
  readonly allowedEffects: readonly string[];
  readonly output: {
    readonly kind: "report" | "proposal" | "pull_request";
    readonly destination: string;
  };
  readonly nextRun: LoopTrigger;
  readonly stopConditions: readonly LoopStopCondition[];
}

export interface LoopSourceObservation {
  readonly sourceId: string;
  readonly observedAt: string;
  readonly provenance:
    | {
        readonly kind: "connected_provider";
        readonly tenant: TenantRef;
        readonly providerId: string;
        readonly connectionId: string;
        readonly externalAccountId: string;
        readonly propertyId: string | null;
        readonly operationId: string;
        readonly readBackHash: string;
        readonly fetchedAt: string;
        readonly reportingWindow: {
          readonly startedAt: string;
          readonly endedAt: string;
          readonly timezone: string;
        };
        readonly quality: {
          readonly status: "complete" | "partial";
          readonly limitations: readonly string[];
        };
        readonly releaseVersion: string;
      }
    | { readonly kind: "fixture"; readonly fixtureId: string };
  readonly metrics: Readonly<Record<string, number | null>>;
  readonly evidenceRefs: readonly string[];
}

export interface LoopIterationInput {
  readonly evaluatedAt: string;
  readonly sources: readonly LoopSourceObservation[];
}

export interface LoopRunInput {
  readonly tenant: TenantRef;
  readonly runId: string;
  readonly trigger: LoopTrigger;
  readonly iterations: readonly LoopIterationInput[];
  /** Required only for production effects; resolved by the authoritative store. */
  readonly authorizationEnvelopeId: string | null;
  /** Fixture-only effect declarations. Production resolves effects from the envelope. */
  readonly authorizedEffects: readonly string[];
}

/**
 * The only effect evidence allowed into durable loop state. Raw provider
 * payloads, diagnostics, customer fields, and credential material stay behind
 * their source boundary; the loop stores opaque references and hashes only.
 */
export interface LoopEffectEvidence {
  readonly schemaVersion: 1;
  readonly provenance: "provider_readback" | "local_checkpoint" | "fixture";
  readonly verification: "verified" | "accepted_unverified" | "confirmed_absent" | "fixture";
  readonly evidenceRefs: readonly string[];
  readonly operationId: string | null;
  readonly readBackHash: string | null;
  readonly observedAt: string;
  readonly summaryCode: string;
}

export type LoopEffectOutcome =
  | { readonly state: "applied"; readonly evidence: LoopEffectEvidence }
  | { readonly state: "confirmed_no_effect"; readonly evidence: LoopEffectEvidence }
  | { readonly state: "unknown"; readonly evidence: LoopEffectEvidence };

export type LoopEffectReconciliation =
  | { readonly state: "applied"; readonly evidence: LoopEffectEvidence }
  | {
      readonly state: "confirmed_no_effect";
      readonly evidence: LoopEffectEvidence;
      /**
       * The durable executor has fenced the exact prior attempt, so that
       * attempt can no longer complete after this result is returned.
       */
      readonly attemptFenced: true;
    }
  | { readonly state: "unknown"; readonly evidence: LoopEffectEvidence };

export interface LoopEffectRequest {
  readonly tenant: TenantRef;
  readonly runId: string;
  readonly loopId: VentureLoopId;
  readonly definitionHash: string;
  readonly iteration: number;
  readonly ruleId: string;
  readonly idempotencyKey: string;
  readonly authorizationEnvelopeId: string;
  /** Unique fencing token for this exact apply attempt. */
  readonly attemptToken: string;
  readonly action: LoopDecisionAction;
}

export interface LoopEffectExecutor {
  /**
   * Production executors must durably bind the idempotency key and attempt
   * token before transport. Fixture executors are never accepted in
   * production mode.
   */
  readonly durability: "fixture_only" | "durable_apply_once";
  apply(request: LoopEffectRequest): Promise<LoopEffectOutcome> | LoopEffectOutcome;
  /** Read-back only. It must never repeat the original effect. */
  reconcile(
    request: LoopEffectRequest,
    reconciliationEnvelopeId?: string,
  ): Promise<LoopEffectReconciliation> | LoopEffectReconciliation;
}

export interface LoopEffectAuthorizer {
  /** Resolve the active run envelope immediately before each apply attempt. */
  authorize(request: LoopEffectRequest): Promise<boolean> | boolean;
  /** Resolve a fresh read-back-only envelope; never reuse apply authority implicitly. */
  authorizeReconciliation?(
    request: LoopEffectRequest,
    reconciliationEnvelopeId: string,
  ): Promise<boolean> | boolean;
}

export type LoopActionState =
  | "observed"
  | "proposed"
  | "prepared"
  | "retryable_no_effect"
  | "applied"
  | "confirmed_no_effect"
  | "unknown"
  | "rejected";

/**
 * A durable, evidence-bound draft. A catalog action is not a proposal merely
 * because its metadata says so; this artifact must exist before the runtime
 * may persist the `proposed` state.
 */
export interface LoopProposalArtifact {
  readonly schemaVersion: 1;
  readonly kind: "proposal";
  readonly artifactId: string;
  readonly loopId: VentureLoopId;
  readonly runId: string;
  readonly iteration: number;
  readonly ruleId: string;
  readonly decisionSurface: string;
  readonly evidenceRefs: readonly string[];
  readonly generatedAt: string;
}

export interface LoopActionRecord {
  readonly iteration: number;
  readonly ruleId: string;
  readonly idempotencyKey: string;
  readonly attemptToken: string | null;
  readonly action: LoopDecisionAction;
  readonly state: LoopActionState;
  readonly reason: string | null;
  readonly evidence: LoopEffectEvidence | null;
  readonly proposalArtifact: LoopProposalArtifact | null;
}

export interface LoopIterationEvaluation {
  readonly iteration: number;
  readonly evaluatedAt: string;
  readonly assessedAt: string;
  readonly sources: readonly LoopSourceObservation[];
  readonly guardrails: readonly { readonly id: string; readonly breached: boolean }[];
  readonly decisions: readonly { readonly ruleId: string; readonly matched: boolean }[];
  readonly completionSatisfied: boolean;
  readonly limitations: readonly string[];
}

export type LoopRunStatus =
  "running" | "waiting_for_reconciliation" | "completed" | "insufficient_evidence" | "stopped";

export interface LoopRunRecord {
  readonly tenant: TenantRef;
  readonly runId: string;
  readonly loopId: VentureLoopId;
  readonly definitionHash: string;
  readonly inputHash: string;
  readonly authorizationEnvelopeId: string | null;
  readonly trigger: LoopTrigger;
  readonly inputs: readonly LoopIterationInput[];
  readonly status: LoopRunStatus;
  readonly iteration: number;
  readonly actions: readonly LoopActionRecord[];
  readonly evaluations: readonly LoopIterationEvaluation[];
  readonly limitations: readonly string[];
  readonly stopReason:
    | "completed"
    | "maximum_iterations"
    | "maximum_actions"
    | "guardrail_breach"
    | "authorization_unavailable"
    | "completion_unsatisfied"
    | "insufficient_evidence"
    | "waiting_for_reconciliation"
    | null;
  readonly output: VentureLoopDefinition["output"];
  readonly nextRun: LoopTrigger;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export type LoopRunClaim =
  | { readonly state: "owner"; readonly record: LoopRunRecord; readonly ownerToken: string }
  | { readonly state: "replay"; readonly record: LoopRunRecord }
  | { readonly state: "pending"; readonly record: LoopRunRecord }
  | { readonly state: "conflict" };

export interface LoopRunStore {
  readonly durability: "fixture_only" | "durable_atomic";
  claim(input: {
    readonly record: LoopRunRecord;
    readonly ownerToken: string;
    readonly leaseExpiresAt: string;
    readonly now: string;
  }): LoopRunClaim;
  save(record: LoopRunRecord, ownerToken: string, leaseExpiresAt: string): void;
  load(tenant: TenantRef, runId: string): LoopRunRecord | null;
}

interface StoredLoopRun {
  record: LoopRunRecord;
  ownerToken: string;
  leaseExpiresAt: string;
}

export class InMemoryLoopRunStore implements LoopRunStore {
  readonly durability = "fixture_only" as const;
  readonly #runs = new Map<string, StoredLoopRun>();

  claim(input: {
    readonly record: LoopRunRecord;
    readonly ownerToken: string;
    readonly leaseExpiresAt: string;
    readonly now: string;
  }): LoopRunClaim {
    const key = runKey(input.record.tenant, input.record.runId);
    const existing = this.#runs.get(key);
    if (!existing) {
      this.#runs.set(key, {
        record: clone(input.record),
        ownerToken: input.ownerToken,
        leaseExpiresAt: input.leaseExpiresAt,
      });
      return { state: "owner", record: clone(input.record), ownerToken: input.ownerToken };
    }
    if (
      existing.record.definitionHash !== input.record.definitionHash ||
      existing.record.inputHash !== input.record.inputHash ||
      existing.record.loopId !== input.record.loopId
    ) {
      return { state: "conflict" };
    }
    if (terminal(existing.record.status))
      return { state: "replay", record: clone(existing.record) };
    if (Date.parse(existing.leaseExpiresAt) > Date.parse(input.now)) {
      return { state: "pending", record: clone(existing.record) };
    }
    existing.ownerToken = input.ownerToken;
    existing.leaseExpiresAt = input.leaseExpiresAt;
    return { state: "owner", record: clone(existing.record), ownerToken: input.ownerToken };
  }

  save(record: LoopRunRecord, ownerToken: string, leaseExpiresAt: string): void {
    const key = runKey(record.tenant, record.runId);
    const existing = this.#runs.get(key);
    if (!existing || existing.ownerToken !== ownerToken)
      throw new Error("loop run lease is not held by this owner");
    existing.record = clone(record);
    existing.leaseExpiresAt = leaseExpiresAt;
  }

  load(tenant: TenantRef, runId: string): LoopRunRecord | null {
    return clone(this.#runs.get(runKey(tenant, runId))?.record ?? null);
  }
}

interface SqliteStatement {
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): { changes: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface LoopRunRow {
  definition_hash: string;
  input_hash: string;
  loop_id: VentureLoopId;
  owner_token: string;
  lease_expires_at: string;
  record_json: string;
  record_hmac: string | null;
}

function sqliteDatabase(path: string): SqliteDatabase {
  try {
    const location = typeof __filename === "string" ? __filename : import.meta.url;
    const { DatabaseSync } = createRequire(location)("node:sqlite") as {
      DatabaseSync: new (filename: string) => SqliteDatabase;
    };
    return new DatabaseSync(path);
  } catch (error) {
    throw new Error(
      `the durable loop store requires Node >= 22.5 (node:sqlite unavailable): ${(error as Error).message}`,
    );
  }
}

export class SqliteLoopRunStore implements LoopRunStore {
  readonly durability = "durable_atomic" as const;
  readonly #database: SqliteDatabase;
  readonly #integrityKey: Uint8Array;

  constructor(path: string, options: { readonly integrityKey: Uint8Array }) {
    if (!path.trim() || path === ":memory:")
      throw new Error("the durable loop store requires a persistent SQLite file");
    if (!(options.integrityKey instanceof Uint8Array) || options.integrityKey.byteLength < 32)
      throw new Error("the durable loop store requires an integrity key of at least 32 bytes");
    this.#integrityKey = new Uint8Array(options.integrityKey);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = sqliteDatabase(path);
    initializeSqliteWal(this.#database, { label: "durable loop store" });
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS loop_runs (
        tenant_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        loop_id TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        owner_token TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        record_json TEXT NOT NULL,
        record_hmac TEXT NOT NULL,
        PRIMARY KEY (tenant_key, run_id)
      )
    `);
    try {
      this.#database.exec("ALTER TABLE loop_runs ADD COLUMN record_hmac TEXT");
    } catch (error) {
      if (!/duplicate column/iu.test((error as Error).message)) throw error;
    }
    chmodSync(path, 0o600);
  }

  claim(input: {
    readonly record: LoopRunRecord;
    readonly ownerToken: string;
    readonly leaseExpiresAt: string;
    readonly now: string;
  }): LoopRunClaim {
    const key = safeTenantKey(input.record.tenant);
    const candidateRecordJson = stableJson(input.record as unknown as JsonObject);
    assertCredentialFree(candidateRecordJson, "serialized loop run record");
    parseRecord(candidateRecordJson);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      let row = this.#row(key, input.record.runId);
      if (!row) {
        const recordJson = candidateRecordJson;
        const recordHmac = this.#recordHmac({
          tenantKey: key,
          runId: input.record.runId,
          loopId: input.record.loopId,
          definitionHash: input.record.definitionHash,
          inputHash: input.record.inputHash,
          ownerToken: input.ownerToken,
          leaseExpiresAt: input.leaseExpiresAt,
          recordJson,
        });
        this.#database
          .prepare(
            `INSERT INTO loop_runs
              (tenant_key, run_id, loop_id, definition_hash, input_hash, owner_token,
               lease_expires_at, record_json, record_hmac)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            key,
            input.record.runId,
            input.record.loopId,
            input.record.definitionHash,
            input.record.inputHash,
            input.ownerToken,
            input.leaseExpiresAt,
            recordJson,
            recordHmac,
          );
        this.#database.exec("COMMIT");
        return { state: "owner", record: clone(input.record), ownerToken: input.ownerToken };
      }
      this.#assertRowIntegrity(key, input.record.runId, row);
      const record = parseRecord(row.record_json, {
        tenantKey: key,
        runId: input.record.runId,
        loopId: row.loop_id,
        definitionHash: row.definition_hash,
        inputHash: row.input_hash,
      });
      if (
        row.definition_hash !== input.record.definitionHash ||
        row.input_hash !== input.record.inputHash ||
        row.loop_id !== input.record.loopId
      ) {
        this.#database.exec("COMMIT");
        return { state: "conflict" };
      }
      if (terminal(record.status)) {
        this.#database.exec("COMMIT");
        return { state: "replay", record };
      }
      if (Date.parse(row.lease_expires_at) > Date.parse(input.now)) {
        this.#database.exec("COMMIT");
        return { state: "pending", record };
      }
      const nextRecordHmac = this.#recordHmac({
        tenantKey: key,
        runId: input.record.runId,
        loopId: row.loop_id,
        definitionHash: row.definition_hash,
        inputHash: row.input_hash,
        ownerToken: input.ownerToken,
        leaseExpiresAt: input.leaseExpiresAt,
        recordJson: row.record_json,
      });
      this.#database
        .prepare(
          `UPDATE loop_runs SET owner_token = ?, lease_expires_at = ?, record_hmac = ?
           WHERE tenant_key = ? AND run_id = ? AND owner_token = ?`,
        )
        .run(
          input.ownerToken,
          input.leaseExpiresAt,
          nextRecordHmac,
          key,
          input.record.runId,
          row.owner_token,
        );
      row = {
        ...row,
        owner_token: input.ownerToken,
        lease_expires_at: input.leaseExpiresAt,
        record_hmac: nextRecordHmac,
      };
      this.#database.exec("COMMIT");
      return { state: "owner", record, ownerToken: input.ownerToken };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  save(record: LoopRunRecord, ownerToken: string, leaseExpiresAt: string): void {
    const key = safeTenantKey(record.tenant);
    const recordJson = stableJson(record as unknown as JsonObject);
    assertCredentialFree(recordJson, "serialized loop run record");
    parseRecord(recordJson);
    const recordHmac = this.#recordHmac({
      tenantKey: key,
      runId: record.runId,
      loopId: record.loopId,
      definitionHash: record.definitionHash,
      inputHash: record.inputHash,
      ownerToken,
      leaseExpiresAt,
      recordJson,
    });
    const result = this.#database
      .prepare(
        `UPDATE loop_runs SET record_json = ?, lease_expires_at = ?, record_hmac = ?
         WHERE tenant_key = ? AND run_id = ? AND owner_token = ?`,
      )
      .run(recordJson, leaseExpiresAt, recordHmac, key, record.runId, ownerToken);
    if (Number(result.changes) !== 1) throw new Error("loop run lease is not held by this owner");
  }

  load(tenant: TenantRef, runId: string): LoopRunRecord | null {
    const key = safeTenantKey(tenant);
    const parsedRunId = canonicalId(runId, "runId");
    const row = this.#row(key, parsedRunId);
    if (!row) return null;
    this.#assertRowIntegrity(key, parsedRunId, row);
    return parseRecord(row.record_json, {
      tenantKey: key,
      runId: parsedRunId,
      loopId: row.loop_id,
      definitionHash: row.definition_hash,
      inputHash: row.input_hash,
    });
  }

  close(): void {
    this.#database.close();
  }

  #row(key: string, runId: string): LoopRunRow | undefined {
    return this.#database
      .prepare(
        `SELECT loop_id, definition_hash, input_hash, owner_token, lease_expires_at, record_json,
                record_hmac
         FROM loop_runs WHERE tenant_key = ? AND run_id = ?`,
      )
      .get(key, runId) as LoopRunRow | undefined;
  }

  #recordHmac(input: {
    readonly tenantKey: string;
    readonly runId: string;
    readonly loopId: VentureLoopId;
    readonly definitionHash: string;
    readonly inputHash: string;
    readonly ownerToken: string;
    readonly leaseExpiresAt: string;
    readonly recordJson: string;
  }): string {
    return createHmac("sha256", this.#integrityKey)
      .update(
        stableJson([
          input.tenantKey,
          input.runId,
          input.loopId,
          input.definitionHash,
          input.inputHash,
          input.ownerToken,
          input.leaseExpiresAt,
          input.recordJson,
        ] as JsonValue),
      )
      .digest("hex");
  }

  #assertRowIntegrity(key: string, runId: string, row: LoopRunRow): void {
    if (row.record_hmac === null || !/^[a-f0-9]{64}$/u.test(row.record_hmac))
      throw new Error("stored loop row has no valid integrity binding");
    const expected = this.#recordHmac({
      tenantKey: key,
      runId,
      loopId: row.loop_id,
      definitionHash: row.definition_hash,
      inputHash: row.input_hash,
      ownerToken: row.owner_token,
      leaseExpiresAt: row.lease_expires_at,
      recordJson: row.record_json,
    });
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(row.record_hmac, "hex")))
      throw new Error("stored loop row failed its integrity binding");
  }
}

export interface LoopAuthorizationEnvelope {
  readonly schemaVersion: 2;
  readonly tenant: TenantRef;
  readonly envelopeId: string;
  readonly runId: string;
  readonly loopId: VentureLoopId;
  readonly definitionHash: string;
  readonly purpose: "apply" | "reconcile";
  readonly allowedEffects: readonly string[];
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly targetIdempotencyKey: string | null;
  readonly targetAttemptToken: string | null;
}

interface LoopAuthorizationRow {
  envelope_json: string;
  envelope_hmac: string;
}

/** Durable, tenant-scoped authority used by production loop execution. */
export class SqliteLoopAuthorizationStore implements LoopEffectAuthorizer {
  readonly #database: SqliteDatabase;
  readonly #integrityKey: Uint8Array;
  readonly #now: () => Date;

  constructor(
    path: string,
    options: { readonly integrityKey: Uint8Array; readonly now?: () => Date },
  ) {
    if (!path.trim() || path === ":memory:")
      throw new Error("the loop authorization store requires a persistent SQLite file");
    if (!(options.integrityKey instanceof Uint8Array) || options.integrityKey.byteLength < 32)
      throw new Error(
        "the loop authorization store requires an integrity key of at least 32 bytes",
      );
    this.#integrityKey = new Uint8Array(options.integrityKey);
    this.#now = options.now ?? (() => new Date());
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = sqliteDatabase(path);
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS loop_authorizations (
        tenant_key TEXT NOT NULL,
        envelope_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        envelope_hmac TEXT NOT NULL,
        PRIMARY KEY (tenant_key, envelope_id)
      );
      CREATE TABLE IF NOT EXISTS loop_reconciliation_authorization_uses (
        tenant_key TEXT NOT NULL,
        envelope_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        attempt_token TEXT NOT NULL,
        used_at TEXT NOT NULL,
        PRIMARY KEY (tenant_key, envelope_id)
      )
    `);
    chmodSync(path, 0o600);
  }

  grant(envelopeInput: LoopAuthorizationEnvelope): void {
    const envelope = validateAuthorizationEnvelope(envelopeInput);
    const key = safeTenantKey(envelope.tenant);
    const envelopeJson = stableJson(envelope as unknown as JsonObject);
    const envelopeHmac = this.#hmac(key, envelope.envelopeId, envelopeJson);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#row(key, envelope.envelopeId);
      if (existing) {
        this.#assertIntegrity(key, envelope.envelopeId, existing);
        if (existing.envelope_json !== envelopeJson)
          throw new Error("loop authorization envelope conflict");
        this.#database.exec("COMMIT");
        return;
      }
      this.#database
        .prepare(
          `INSERT INTO loop_authorizations
             (tenant_key, envelope_id, envelope_json, envelope_hmac)
           VALUES (?, ?, ?, ?)`,
        )
        .run(key, envelope.envelopeId, envelopeJson, envelopeHmac);
      this.#database.exec("COMMIT");
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  revoke(tenant: TenantRef, envelopeId: string, revokedAt: string): void {
    const key = safeTenantKey(tenant);
    const parsedEnvelopeId = canonicalId(envelopeId, "envelopeId");
    validDate(revokedAt, "revokedAt");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#row(key, parsedEnvelopeId);
      if (!row) throw new Error("loop authorization envelope does not exist");
      this.#assertIntegrity(key, parsedEnvelopeId, row);
      assertCredentialFree(row.envelope_json, "serialized loop authorization envelope");
      const envelope = validateAuthorizationEnvelope(
        JSON.parse(row.envelope_json) as LoopAuthorizationEnvelope,
      );
      if (Date.parse(revokedAt) < Date.parse(envelope.notBefore))
        throw new Error("loop authorization revocation predates the envelope");
      const next = { ...envelope, revokedAt };
      const envelopeJson = stableJson(next as unknown as JsonObject);
      this.#database
        .prepare(
          `UPDATE loop_authorizations SET envelope_json = ?, envelope_hmac = ?
           WHERE tenant_key = ? AND envelope_id = ?`,
        )
        .run(envelopeJson, this.#hmac(key, parsedEnvelopeId, envelopeJson), key, parsedEnvelopeId);
      this.#database.exec("COMMIT");
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  authorize(request: LoopEffectRequest): boolean {
    validateEffectRequest(request);
    const key = safeTenantKey(request.tenant);
    const row = this.#row(key, request.authorizationEnvelopeId);
    if (!row) return false;
    this.#assertIntegrity(key, request.authorizationEnvelopeId, row);
    assertCredentialFree(row.envelope_json, "serialized loop authorization envelope");
    const envelope = validateAuthorizationEnvelope(
      JSON.parse(row.envelope_json) as LoopAuthorizationEnvelope,
    );
    const now = this.#now().toISOString();
    validDate(now, "loop authorization clock");
    return (
      safeTenantKey(envelope.tenant) === key &&
      envelope.envelopeId === request.authorizationEnvelopeId &&
      envelope.runId === request.runId &&
      envelope.loopId === request.loopId &&
      envelope.definitionHash === request.definitionHash &&
      envelope.purpose === "apply" &&
      envelope.allowedEffects.includes(request.action.effect) &&
      Date.parse(now) >= Date.parse(envelope.notBefore) &&
      Date.parse(now) < Date.parse(envelope.expiresAt) &&
      envelope.revokedAt === null
    );
  }

  authorizeReconciliation(request: LoopEffectRequest, reconciliationEnvelopeId: string): boolean {
    validateEffectRequest(request);
    const parsedEnvelopeId = canonicalId(reconciliationEnvelopeId, "reconciliationEnvelopeId");
    if (parsedEnvelopeId === request.authorizationEnvelopeId) return false;
    const key = safeTenantKey(request.tenant);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#row(key, parsedEnvelopeId);
      if (!row) {
        this.#database.exec("COMMIT");
        return false;
      }
      this.#assertIntegrity(key, parsedEnvelopeId, row);
      assertCredentialFree(row.envelope_json, "serialized loop authorization envelope");
      const envelope = validateAuthorizationEnvelope(
        JSON.parse(row.envelope_json) as LoopAuthorizationEnvelope,
      );
      const now = this.#now().toISOString();
      validDate(now, "loop authorization clock");
      const authorized =
        safeTenantKey(envelope.tenant) === key &&
        envelope.envelopeId === parsedEnvelopeId &&
        envelope.runId === request.runId &&
        envelope.loopId === request.loopId &&
        envelope.definitionHash === request.definitionHash &&
        envelope.purpose === "reconcile" &&
        envelope.allowedEffects.length === 1 &&
        envelope.allowedEffects[0] === "loop.reconcile" &&
        envelope.targetIdempotencyKey === request.idempotencyKey &&
        envelope.targetAttemptToken === request.attemptToken &&
        Date.parse(now) >= Date.parse(envelope.notBefore) &&
        Date.parse(now) < Date.parse(envelope.expiresAt) &&
        envelope.revokedAt === null;
      if (!authorized) {
        this.#database.exec("COMMIT");
        return false;
      }
      const priorUse = this.#database
        .prepare(
          `SELECT 1 FROM loop_reconciliation_authorization_uses
           WHERE tenant_key = ? AND envelope_id = ?`,
        )
        .get(key, parsedEnvelopeId);
      if (priorUse) {
        this.#database.exec("COMMIT");
        return false;
      }
      this.#database
        .prepare(
          `INSERT INTO loop_reconciliation_authorization_uses
             (tenant_key, envelope_id, idempotency_key, attempt_token, used_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(key, parsedEnvelopeId, request.idempotencyKey, request.attemptToken, now);
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  #row(key: string, envelopeId: string): LoopAuthorizationRow | undefined {
    return this.#database
      .prepare(
        `SELECT envelope_json, envelope_hmac FROM loop_authorizations
         WHERE tenant_key = ? AND envelope_id = ?`,
      )
      .get(key, envelopeId) as LoopAuthorizationRow | undefined;
  }

  #hmac(key: string, envelopeId: string, envelopeJson: string): string {
    return createHmac("sha256", this.#integrityKey)
      .update(stableJson([key, envelopeId, envelopeJson] as JsonValue))
      .digest("hex");
  }

  #assertIntegrity(key: string, envelopeId: string, row: LoopAuthorizationRow): void {
    if (!/^[a-f0-9]{64}$/u.test(row.envelope_hmac))
      throw new Error("loop authorization envelope has no valid integrity binding");
    const expected = this.#hmac(key, envelopeId, row.envelope_json);
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(row.envelope_hmac, "hex")))
      throw new Error("loop authorization envelope failed its integrity binding");
  }
}

function validateAuthorizationEnvelope(
  input: LoopAuthorizationEnvelope,
): LoopAuthorizationEnvelope {
  assertExactPlainObject(
    input,
    [
      "allowedEffects",
      "definitionHash",
      "envelopeId",
      "expiresAt",
      "issuedAt",
      "loopId",
      "notBefore",
      "purpose",
      "revokedAt",
      "runId",
      "schemaVersion",
      "targetAttemptToken",
      "targetIdempotencyKey",
      "tenant",
    ],
    "loop authorization envelope",
  );
  assertCredentialFree(
    stableJson(input as unknown as JsonObject),
    "serialized loop authorization envelope",
  );
  if (input.schemaVersion !== 2) throw new Error("unsupported loop authorization schema version");
  safeTenantKey(input.tenant);
  canonicalId(input.envelopeId, "envelopeId");
  canonicalId(input.runId, "runId");
  if (!VENTURE_LOOP_IDS.includes(input.loopId)) throw new Error("loop authorization ID is invalid");
  if (!/^[a-f0-9]{64}$/u.test(input.definitionHash))
    throw new Error("loop authorization definition hash is invalid");
  const canonicalDefinitionHash = sha256(definitionMaterial(loopDefinition(input.loopId)));
  if (input.definitionHash !== canonicalDefinitionHash)
    throw new Error("loop authorization is not bound to the immutable catalog definition");
  if (!(input.purpose === "apply" || input.purpose === "reconcile"))
    throw new Error("loop authorization purpose is invalid");
  if (!Array.isArray(input.allowedEffects))
    throw new Error("loop authorization effects must be an array");
  unique(input.allowedEffects.map(canonicalEffect), "loop authorization effects");
  if (input.allowedEffects.length === 0)
    throw new Error("loop authorization requires at least one effect");
  validDate(input.issuedAt, "loop authorization issuedAt");
  validDate(input.notBefore, "loop authorization notBefore");
  validDate(input.expiresAt, "loop authorization expiresAt");
  if (Date.parse(input.notBefore) < Date.parse(input.issuedAt))
    throw new Error("loop authorization cannot start before it was issued");
  if (Date.parse(input.expiresAt) <= Date.parse(input.notBefore))
    throw new Error("loop authorization expiry must follow its start");
  if (input.revokedAt !== null) {
    if (typeof input.revokedAt !== "string")
      throw new Error("loop authorization revokedAt is invalid");
    validDate(input.revokedAt, "loop authorization revokedAt");
  }
  if (input.purpose === "apply") {
    if (input.allowedEffects.includes("loop.reconcile"))
      throw new Error("an apply envelope cannot include loop.reconcile");
    const catalogEffects = new Set(loopDefinition(input.loopId).allowedEffects);
    if (input.allowedEffects.some((effect) => !catalogEffects.has(effect)))
      throw new Error("an apply envelope contains an effect outside the immutable catalog");
    if (input.targetIdempotencyKey !== null || input.targetAttemptToken !== null)
      throw new Error("an apply envelope cannot bind a reconciliation target");
  } else {
    if (stableJson(input.allowedEffects as unknown as JsonValue) !== stableJson(["loop.reconcile"]))
      throw new Error("a reconciliation envelope must be read-back only");
    if (!input.targetIdempotencyKey || !/^[a-f0-9]{64}$/u.test(input.targetIdempotencyKey))
      throw new Error("a reconciliation envelope requires an exact idempotency target");
    if (!input.targetAttemptToken)
      throw new Error("a reconciliation envelope requires an exact attempt target");
    canonicalId(input.targetAttemptToken, "loop reconciliation attemptToken");
    if (Date.parse(input.expiresAt) - Date.parse(input.issuedAt) > 5 * 60 * 1_000)
      throw new Error("a reconciliation envelope cannot be valid for more than five minutes");
  }
  return deepFreeze(structuredClone(input));
}

export interface LoopEffectTransport {
  apply(request: LoopEffectRequest): Promise<LoopEffectOutcome> | LoopEffectOutcome;
  /** Read-back/fence only; it must never repeat the original effect. */
  readBack(
    request: LoopEffectRequest,
  ): Promise<LoopEffectReconciliation> | LoopEffectReconciliation;
}

interface LoopEffectRow {
  request_hash: string;
  attempt_token: string;
  state: "prepared" | "unknown" | "applied" | "confirmed_no_effect";
  evidence_json: string;
  row_hmac: string;
}

class LoopEffectAuthorizationUnavailableError extends Error {}

/** Durable operation journal that makes production loop effects apply-once. */
export class SqliteLoopEffectExecutor implements LoopEffectExecutor {
  readonly durability = "durable_apply_once" as const;
  readonly #database: SqliteDatabase;
  readonly #integrityKey: Uint8Array;
  readonly #transport: LoopEffectTransport;
  readonly #authorizer: SqliteLoopAuthorizationStore;
  readonly #now: () => Date;

  constructor(
    path: string,
    options: {
      readonly integrityKey: Uint8Array;
      readonly transport: LoopEffectTransport;
      readonly authorizer: SqliteLoopAuthorizationStore;
      readonly now?: () => Date;
    },
  ) {
    if (!path.trim() || path === ":memory:")
      throw new Error("the loop effect journal requires a persistent SQLite file");
    if (!(options.integrityKey instanceof Uint8Array) || options.integrityKey.byteLength < 32)
      throw new Error("the loop effect journal requires an integrity key of at least 32 bytes");
    this.#integrityKey = new Uint8Array(options.integrityKey);
    this.#transport = options.transport;
    if (!(options.authorizer instanceof SqliteLoopAuthorizationStore))
      throw new Error("the loop effect journal requires the authoritative authorization store");
    this.#authorizer = options.authorizer;
    this.#now = options.now ?? (() => new Date());
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = sqliteDatabase(path);
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS loop_effect_operations (
        tenant_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        attempt_token TEXT NOT NULL,
        state TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        row_hmac TEXT NOT NULL,
        PRIMARY KEY (tenant_key, idempotency_key)
      )
    `);
    chmodSync(path, 0o600);
  }

  async apply(request: LoopEffectRequest): Promise<LoopEffectOutcome> {
    if (!this.#authorizer.authorize(request))
      throw new LoopEffectAuthorizationUnavailableError(
        "active authoritative loop effect authorization is unavailable",
      );
    const claimed = this.#claim(request);
    if (claimed) return claimed;
    if (!this.#authorizer.authorize(request))
      throw new LoopEffectAuthorizationUnavailableError(
        "active authoritative loop effect authorization expired before transport",
      );
    const outcome = await this.#transport.apply(request);
    assertOutcomeEvidence(
      outcome.state,
      outcome.evidence,
      "production",
      "loop transport evidence",
      request.action.effect,
      this.#now().toISOString(),
    );
    return this.#complete(request, outcome.state, outcome.evidence);
  }

  async reconcile(
    request: LoopEffectRequest,
    reconciliationEnvelopeId?: string,
  ): Promise<LoopEffectReconciliation> {
    validateEffectRequest(request);
    const key = safeTenantKey(request.tenant);
    const requestHash = loopEffectRequestHash(request);
    const row = this.#row(key, request.idempotencyKey);
    if (!row) throw new Error("loop effect operation is missing from the durable journal");
    this.#assertIntegrity(key, request.idempotencyKey, row);
    if (row.request_hash !== requestHash) throw new Error("loop effect idempotency conflict");
    if (row.state === "applied")
      return { state: "applied", evidence: parseEffectEvidence(row.evidence_json) };
    if (row.state === "confirmed_no_effect")
      return {
        state: "confirmed_no_effect",
        attemptFenced: true,
        evidence: parseEffectEvidence(row.evidence_json),
      };
    if (
      reconciliationEnvelopeId === undefined ||
      !this.#authorizer.authorizeReconciliation(request, reconciliationEnvelopeId)
    ) {
      throw new LoopEffectAuthorizationUnavailableError(
        "a fresh read-back-only authorization envelope is required for reconciliation",
      );
    }
    const result = await this.#transport.readBack(request);
    assertOutcomeEvidence(
      result.state,
      result.evidence,
      "production",
      "loop read-back evidence",
      request.action.effect,
      this.#now().toISOString(),
    );
    if (result.state === "confirmed_no_effect" && result.attemptFenced !== true)
      throw new Error("loop read-back cannot confirm absence without fencing the prior attempt");
    const persisted = this.#complete(request, result.state, result.evidence);
    return persisted.state === "confirmed_no_effect"
      ? { ...persisted, attemptFenced: true }
      : persisted;
  }

  close(): void {
    this.#database.close();
  }

  usesAuthorizationStore(authorizer: SqliteLoopAuthorizationStore): boolean {
    return this.#authorizer === authorizer;
  }

  #claim(request: LoopEffectRequest): LoopEffectOutcome | null {
    validateEffectRequest(request);
    const key = safeTenantKey(request.tenant);
    const requestHash = loopEffectRequestHash(request);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#row(key, request.idempotencyKey);
      if (existing) {
        this.#assertIntegrity(key, request.idempotencyKey, existing);
        if (existing.request_hash !== requestHash)
          throw new Error("loop effect idempotency conflict");
        const evidence = parseEffectEvidence(existing.evidence_json);
        if (existing.state === "applied") {
          this.#database.exec("COMMIT");
          return { state: "applied", evidence };
        }
        if (existing.state === "prepared" || existing.state === "unknown") {
          this.#database.exec("COMMIT");
          return { state: "unknown", evidence };
        }
        if (
          existing.state === "confirmed_no_effect" &&
          existing.attempt_token === request.attemptToken
        ) {
          this.#database.exec("COMMIT");
          return { state: "confirmed_no_effect", evidence };
        }
      }
      const evidence = preparedEffectEvidence(request, this.#now());
      const evidenceJson = stableJson(evidence as unknown as JsonObject);
      const row: LoopEffectRow = {
        request_hash: requestHash,
        attempt_token: request.attemptToken,
        state: "prepared",
        evidence_json: evidenceJson,
        row_hmac: "",
      };
      row.row_hmac = this.#hmac(key, request.idempotencyKey, row);
      if (existing) {
        this.#database
          .prepare(
            `UPDATE loop_effect_operations
             SET attempt_token = ?, state = ?, evidence_json = ?, row_hmac = ?
             WHERE tenant_key = ? AND idempotency_key = ? AND request_hash = ?`,
          )
          .run(
            row.attempt_token,
            row.state,
            row.evidence_json,
            row.row_hmac,
            key,
            request.idempotencyKey,
            requestHash,
          );
      } else {
        this.#database
          .prepare(
            `INSERT INTO loop_effect_operations
               (tenant_key, idempotency_key, request_hash, attempt_token, state,
                evidence_json, row_hmac)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            key,
            request.idempotencyKey,
            requestHash,
            row.attempt_token,
            row.state,
            row.evidence_json,
            row.row_hmac,
          );
      }
      this.#database.exec("COMMIT");
      return null;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  #complete(
    request: LoopEffectRequest,
    state: LoopEffectOutcome["state"],
    evidence: LoopEffectEvidence,
  ): LoopEffectOutcome {
    const key = safeTenantKey(request.tenant);
    const persistedState =
      state === "applied"
        ? "applied"
        : state === "confirmed_no_effect"
          ? "confirmed_no_effect"
          : "unknown";
    const incoming: LoopEffectRow = {
      request_hash: loopEffectRequestHash(request),
      attempt_token: request.attemptToken,
      state: persistedState,
      evidence_json: stableJson(evidence as unknown as JsonObject),
      row_hmac: "",
    };
    incoming.row_hmac = this.#hmac(key, request.idempotencyKey, incoming);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#row(key, request.idempotencyKey);
      if (!current) throw new Error("loop effect operation is missing from the durable journal");
      this.#assertIntegrity(key, request.idempotencyKey, current);
      if (current.request_hash !== incoming.request_hash)
        throw new Error("loop effect idempotency conflict");
      if (current.attempt_token !== request.attemptToken)
        throw new Error("loop effect attempt lost its durable fencing token");
      if (current.state === "applied" || current.state === "confirmed_no_effect") {
        const currentEvidence = parseEffectEvidence(current.evidence_json);
        if (state !== "unknown") {
          if (current.state !== state || current.evidence_json !== incoming.evidence_json)
            throw new Error("loop effect terminal outcome conflicts with durable provider truth");
        }
        this.#database.exec("COMMIT");
        return { state: current.state, evidence: currentEvidence };
      }
      const result = this.#database
        .prepare(
          `UPDATE loop_effect_operations
           SET state = ?, evidence_json = ?, row_hmac = ?
           WHERE tenant_key = ? AND idempotency_key = ? AND request_hash = ?
             AND attempt_token = ? AND state IN ('prepared', 'unknown')`,
        )
        .run(
          incoming.state,
          incoming.evidence_json,
          incoming.row_hmac,
          key,
          request.idempotencyKey,
          incoming.request_hash,
          request.attemptToken,
        );
      if (Number(result.changes) !== 1)
        throw new Error("loop effect attempt lost its durable transition claim");
      this.#database.exec("COMMIT");
      return { state, evidence };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  #row(key: string, idempotencyKey: string): LoopEffectRow | undefined {
    return this.#database
      .prepare(
        `SELECT request_hash, attempt_token, state, evidence_json, row_hmac
         FROM loop_effect_operations WHERE tenant_key = ? AND idempotency_key = ?`,
      )
      .get(key, idempotencyKey) as LoopEffectRow | undefined;
  }

  #hmac(key: string, idempotencyKey: string, row: LoopEffectRow): string {
    return createHmac("sha256", this.#integrityKey)
      .update(
        stableJson([
          key,
          idempotencyKey,
          row.request_hash,
          row.attempt_token,
          row.state,
          row.evidence_json,
        ] as JsonValue),
      )
      .digest("hex");
  }

  #assertIntegrity(key: string, idempotencyKey: string, row: LoopEffectRow): void {
    if (!/^[a-f0-9]{64}$/u.test(row.row_hmac))
      throw new Error("loop effect row has no valid integrity binding");
    const expected = this.#hmac(key, idempotencyKey, row);
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(row.row_hmac, "hex")))
      throw new Error("loop effect row failed its integrity binding");
  }
}

function validateEffectRequest(request: LoopEffectRequest): void {
  safeTenantKey(request.tenant);
  canonicalId(request.runId, "runId");
  if (!VENTURE_LOOP_IDS.includes(request.loopId)) throw new Error("loop effect ID is invalid");
  const definition = loopDefinition(request.loopId);
  if (!/^[a-f0-9]{64}$/u.test(request.definitionHash))
    throw new Error("loop effect definition hash is invalid");
  if (request.definitionHash !== sha256(definitionMaterial(definition)))
    throw new Error("loop effect is not bound to the immutable catalog definition");
  const ruleId = canonicalId(request.ruleId, "ruleId");
  const rule = definition.decisionRules.find(({ id }) => id === ruleId);
  if (!rule)
    throw new Error("loop effect rule is not declared by the immutable catalog definition");
  if (
    stableJson(request.action as unknown as JsonValue) !==
    stableJson(rule.action as unknown as JsonValue)
  )
    throw new Error("loop effect action does not match the immutable catalog rule");
  if (!/^[a-f0-9]{64}$/u.test(request.idempotencyKey))
    throw new Error("loop effect idempotency key is invalid");
  if (
    request.idempotencyKey !==
    loopEffectIdempotencyKey({
      tenant: request.tenant,
      runId: request.runId,
      loopId: request.loopId,
      ruleId,
      iteration: request.iteration,
    })
  ) {
    throw new Error("loop effect idempotency key is not canonically bound to the action");
  }
  canonicalId(request.authorizationEnvelopeId, "authorizationEnvelopeId");
  canonicalId(request.attemptToken, "attemptToken");
  canonicalEffect(request.action.effect);
}

function loopEffectRequestHash(request: LoopEffectRequest): string {
  return sha256([
    safeTenantKey(request.tenant),
    request.runId,
    request.loopId,
    request.definitionHash,
    request.iteration,
    request.ruleId,
    request.idempotencyKey,
    request.authorizationEnvelopeId,
    request.action as unknown as JsonValue,
  ] as JsonValue);
}

function preparedEffectEvidence(request: LoopEffectRequest, now: Date): LoopEffectEvidence {
  const observedAt = now.toISOString();
  validDate(observedAt, "loop effect journal clock");
  return {
    schemaVersion: 1,
    provenance: "local_checkpoint",
    verification: "accepted_unverified",
    evidenceRefs: [`checkpoint://loop/${request.idempotencyKey}`],
    operationId: `loop-${request.idempotencyKey.slice(0, 24)}`,
    readBackHash: null,
    observedAt,
    summaryCode: "apply_prepared",
  };
}

function parseEffectEvidence(value: string): LoopEffectEvidence {
  const evidence = JSON.parse(value) as unknown;
  assertSafeEvidence(evidence, "stored loop effect evidence");
  return evidence;
}

export interface ConnectedLoopSourceRequest {
  readonly tenant: TenantRef;
  readonly runId: string;
  readonly loopId: VentureLoopId;
  readonly trigger: LoopTrigger;
  readonly sources: readonly LoopInputSource[];
  readonly bindings: readonly ConnectedLoopSourceBinding[];
  readonly maximumIterations: number;
  readonly requestedAt: string;
}

export interface ConnectedLoopSourceBinding {
  readonly sourceId: string;
  readonly tenant: TenantRef;
  readonly providerId: string;
  readonly connectionId: string;
  readonly externalAccountId: string;
  readonly propertyId: string | null;
}

export interface ConnectedLoopSourceResult {
  readonly schemaVersion: 1;
  readonly tenant: TenantRef;
  readonly runId: string;
  readonly loopId: VentureLoopId;
  readonly fetchedAt: string;
  readonly iterations: readonly LoopIterationInput[];
}

export interface ConnectedLoopSourceTransport {
  fetch(
    request: ConnectedLoopSourceRequest,
  ): Promise<ConnectedLoopSourceResult> | ConnectedLoopSourceResult;
}

/** Validates provider-fetched inputs before the production runtime may claim a run. */
export class ConnectedLoopSourceFetcher {
  readonly #transport: ConnectedLoopSourceTransport;
  readonly #now: () => Date;
  readonly #bindings: readonly ConnectedLoopSourceBinding[];

  constructor(
    transport: ConnectedLoopSourceTransport,
    options: {
      readonly bindings: readonly ConnectedLoopSourceBinding[];
      readonly now?: () => Date;
    },
  ) {
    this.#transport = transport;
    this.#now = options.now ?? (() => new Date());
    this.#bindings = deepFreeze(structuredClone(options.bindings));
  }

  async fetch(input: {
    readonly definition: VentureLoopDefinition;
    readonly tenant: TenantRef;
    readonly runId: string;
    readonly requestedAt: string;
  }): Promise<readonly LoopIterationInput[]> {
    safeTenantKey(input.tenant);
    canonicalId(input.runId, "runId");
    validDate(input.requestedAt, "loop source request time");
    const bindings = input.definition.inputSources.map(({ id }) => {
      const candidates = this.#bindings.filter(
        (binding) =>
          binding.sourceId === id && safeTenantKey(binding.tenant) === safeTenantKey(input.tenant),
      );
      if (candidates.length !== 1)
        throw new Error(`connected loop source ${id} requires one exact trusted account binding`);
      const binding = candidates[0]!;
      assertExactPlainObject(
        binding,
        ["connectionId", "externalAccountId", "propertyId", "providerId", "sourceId", "tenant"],
        `connected source binding ${id}`,
      );
      canonicalId(binding.sourceId, "connected source binding sourceId");
      canonicalId(binding.providerId, "connected source binding providerId");
      canonicalId(binding.connectionId, "connected source binding connectionId");
      canonicalId(binding.externalAccountId, "connected source binding externalAccountId");
      if (binding.propertyId !== null)
        canonicalId(binding.propertyId, "connected source binding propertyId");
      return binding;
    });
    const result = structuredClone(
      await this.#transport.fetch({
        tenant: input.tenant,
        runId: input.runId,
        loopId: input.definition.id,
        trigger: input.definition.trigger,
        sources: input.definition.inputSources,
        bindings,
        maximumIterations: input.definition.maximumIterations,
        requestedAt: input.requestedAt,
      }),
    );
    assertExactPlainObject(
      result,
      ["fetchedAt", "iterations", "loopId", "runId", "schemaVersion", "tenant"],
      "connected loop source result",
    );
    if (!result || result.schemaVersion !== 1)
      throw new Error("connected loop source returned an unsupported result schema");
    if (safeTenantKey(result.tenant) !== safeTenantKey(input.tenant))
      throw new Error("connected loop source returned evidence for a different tenant");
    if (canonicalId(result.runId, "connected source runId") !== input.runId)
      throw new Error("connected loop source returned evidence for a different run");
    if (result.loopId !== input.definition.id)
      throw new Error("connected loop source returned evidence for a different loop");
    validDate(result.fetchedAt, "connected source fetchedAt");
    const receivedAt = this.#now().toISOString();
    validDate(receivedAt, "connected source receive clock");
    if (
      Date.parse(result.fetchedAt) < Date.parse(input.requestedAt) ||
      Date.parse(result.fetchedAt) > Date.parse(receivedAt)
    ) {
      throw new Error("connected loop source fetch time is outside the trusted request window");
    }
    const iterations = result.iterations;
    if (!Array.isArray(iterations) || iterations.length === 0)
      throw new Error("connected loop source returned no iteration evidence");
    if (iterations.length > input.definition.maximumIterations)
      throw new Error("connected loop source exceeded the immutable iteration bound");
    let priorEvaluation = Number.NEGATIVE_INFINITY;
    for (const iteration of iterations) {
      if (Date.parse(iteration.evaluatedAt) > Date.parse(result.fetchedAt))
        throw new Error("connected loop evaluation is dated after its provider fetch");
      observationMap(input.definition, iteration, receivedAt, "production", input.tenant);
      for (const observation of iteration.sources) {
        const binding = bindings.find(({ sourceId }) => sourceId === observation.sourceId);
        if (
          observation.provenance.kind !== "connected_provider" ||
          observation.provenance.fetchedAt !== result.fetchedAt ||
          !binding ||
          observation.provenance.providerId !== binding.providerId ||
          observation.provenance.connectionId !== binding.connectionId ||
          observation.provenance.externalAccountId !== binding.externalAccountId ||
          observation.provenance.propertyId !== binding.propertyId
        ) {
          throw new Error(
            "connected loop source lacks the exact trusted account read-back binding",
          );
        }
      }
      const evaluated = Date.parse(iteration.evaluatedAt);
      if (evaluated <= priorEvaluation)
        throw new Error("connected loop iterations must be strictly ordered");
      priorEvaluation = evaluated;
    }
    return deepFreeze(iterations);
  }
}

export interface LoopOutputRecord {
  readonly schemaVersion: 1;
  readonly tenant: TenantRef;
  readonly runId: string;
  readonly loopId: VentureLoopId;
  readonly status: LoopRunStatus;
  readonly stopReason: LoopRunRecord["stopReason"];
  readonly destination: string;
  readonly iterationCount: number;
  readonly actionCount: number;
  readonly completionSatisfied: boolean;
  readonly evidenceRefs: readonly string[];
  readonly proposalArtifacts: readonly LoopProposalArtifact[];
  readonly limitations: readonly string[];
  readonly generatedAt: string;
}

interface LoopOutputRow {
  output_json: string;
  output_hmac: string;
}

/** Durable local report/proposal checkpoint; it never publishes externally. */
export class SqliteLoopOutputStore {
  readonly #database: SqliteDatabase;
  readonly #integrityKey: Uint8Array;

  constructor(path: string, options: { readonly integrityKey: Uint8Array }) {
    if (!path.trim() || path === ":memory:")
      throw new Error("the loop output store requires a persistent SQLite file");
    if (!(options.integrityKey instanceof Uint8Array) || options.integrityKey.byteLength < 32)
      throw new Error("the loop output store requires an integrity key of at least 32 bytes");
    this.#integrityKey = new Uint8Array(options.integrityKey);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = sqliteDatabase(path);
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS loop_outputs (
        tenant_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        output_json TEXT NOT NULL,
        output_hmac TEXT NOT NULL,
        PRIMARY KEY (tenant_key, run_id)
      )
    `);
    chmodSync(path, 0o600);
  }

  write(run: LoopRunRecord): LoopOutputRecord {
    const runJson = stableJson(run as unknown as JsonObject);
    assertCredentialFree(runJson, "serialized loop output source record");
    parseRecord(runJson);
    const key = safeTenantKey(run.tenant);
    const evidenceRefs = [
      ...new Set(
        run.evaluations.flatMap(({ sources }) =>
          sources.flatMap(({ evidenceRefs }) => evidenceRefs),
        ),
      ),
    ].sort();
    if (run.evaluations.length === 0 && run.limitations.length === 0)
      throw new Error("loop output cannot be an evidence-free NO DATA report");
    const output: LoopOutputRecord = {
      schemaVersion: 1,
      tenant: clone(run.tenant),
      runId: run.runId,
      loopId: run.loopId,
      status: run.status,
      stopReason: run.stopReason,
      destination: run.output.destination,
      iterationCount: run.evaluations.length,
      actionCount: run.actions.filter(({ state }) => state !== "rejected").length,
      completionSatisfied:
        run.status === "completed" && run.evaluations.at(-1)?.completionSatisfied === true,
      evidenceRefs,
      proposalArtifacts: run.actions.flatMap(({ proposalArtifact }) =>
        proposalArtifact === null ? [] : [clone(proposalArtifact)],
      ),
      limitations: clone(run.limitations),
      generatedAt: run.updatedAt,
    };
    assertCredentialFree(output, "loop output");
    const outputJson = stableJson(output as unknown as JsonObject);
    const outputHmac = this.#hmac(key, run.runId, outputJson);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#row(key, run.runId);
      if (existing) this.#assertIntegrity(key, run.runId, existing);
      this.#database
        .prepare(
          `INSERT INTO loop_outputs (tenant_key, run_id, output_json, output_hmac)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (tenant_key, run_id) DO UPDATE SET
             output_json = excluded.output_json,
             output_hmac = excluded.output_hmac`,
        )
        .run(key, run.runId, outputJson, outputHmac);
      this.#database.exec("COMMIT");
      return deepFreeze(output);
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  load(tenant: TenantRef, runId: string): LoopOutputRecord | null {
    const key = safeTenantKey(tenant);
    const parsedRunId = canonicalId(runId, "runId");
    const row = this.#row(key, parsedRunId);
    if (!row) return null;
    this.#assertIntegrity(key, parsedRunId, row);
    const output = JSON.parse(row.output_json) as LoopOutputRecord;
    assertCredentialFree(output, "stored loop output");
    assertExactPlainObject(
      output,
      [
        "actionCount",
        "completionSatisfied",
        "destination",
        "evidenceRefs",
        "generatedAt",
        "iterationCount",
        "limitations",
        "loopId",
        "proposalArtifacts",
        "runId",
        "schemaVersion",
        "status",
        "stopReason",
        "tenant",
      ],
      "stored loop output",
    );
    if (safeTenantKey(output.tenant) !== key || output.runId !== parsedRunId)
      throw new Error("stored loop output does not match its durable row identity");
    if (!Array.isArray(output.proposalArtifacts))
      throw new Error("stored loop proposal artifacts are invalid");
    for (const artifact of output.proposalArtifacts) {
      const matchingAction = {
        action: { decisionSurface: artifact.decisionSurface },
        iteration: artifact.iteration,
        ruleId: artifact.ruleId,
      } as Pick<LoopActionRecord, "action" | "iteration" | "ruleId">;
      validateProposalArtifact(
        artifact,
        { loopId: output.loopId, runId: output.runId },
        matchingAction,
      );
    }
    return deepFreeze(output);
  }

  close(): void {
    this.#database.close();
  }

  #row(key: string, runId: string): LoopOutputRow | undefined {
    return this.#database
      .prepare(
        `SELECT output_json, output_hmac FROM loop_outputs
         WHERE tenant_key = ? AND run_id = ?`,
      )
      .get(key, runId) as LoopOutputRow | undefined;
  }

  #hmac(key: string, runId: string, outputJson: string): string {
    return createHmac("sha256", this.#integrityKey)
      .update(stableJson([key, runId, outputJson] as JsonValue))
      .digest("hex");
  }

  #assertIntegrity(key: string, runId: string, row: LoopOutputRow): void {
    if (!/^[a-f0-9]{64}$/u.test(row.output_hmac))
      throw new Error("stored loop output has no valid integrity binding");
    const expected = this.#hmac(key, runId, row.output_json);
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(row.output_hmac, "hex")))
      throw new Error("stored loop output failed its integrity binding");
  }
}

export interface ProductionLoopRequest {
  readonly loopId: VentureLoopId;
  readonly tenant: TenantRef;
  readonly runId: string;
  readonly authorizationEnvelopeId?: string;
  readonly reconciliationEnvelopeId?: string;
}

/** Concrete production composition for provider fetch -> decision -> effect -> local output. */
export class ProductionLoopRuntime {
  readonly #runs: SqliteLoopRunStore;
  readonly #authorizations: SqliteLoopAuthorizationStore;
  readonly #effects?: SqliteLoopEffectExecutor;
  readonly #sources: ConnectedLoopSourceFetcher;
  readonly #outputs: SqliteLoopOutputStore;
  readonly #now: () => Date;

  constructor(options: {
    readonly runs: SqliteLoopRunStore;
    readonly authorizations: SqliteLoopAuthorizationStore;
    readonly effects?: SqliteLoopEffectExecutor;
    readonly sources: ConnectedLoopSourceFetcher;
    readonly outputs: SqliteLoopOutputStore;
    readonly now?: () => Date;
  }) {
    if (!(options.runs instanceof SqliteLoopRunStore))
      throw new Error("production loops require the concrete durable SQLite run store");
    if (!(options.authorizations instanceof SqliteLoopAuthorizationStore))
      throw new Error("production loops require the authoritative SQLite authorization store");
    if (!(options.sources instanceof ConnectedLoopSourceFetcher))
      throw new Error("production loops require the concrete connected-source fetcher");
    if (!(options.outputs instanceof SqliteLoopOutputStore))
      throw new Error("production loops require the concrete durable local output store");
    if (options.effects !== undefined && !(options.effects instanceof SqliteLoopEffectExecutor))
      throw new Error("production loop effects require the durable SQLite apply-once executor");
    if (options.effects && !options.effects.usesAuthorizationStore(options.authorizations))
      throw new Error(
        "production loop effects must use the runtime's authoritative authorization store",
      );
    this.#runs = options.runs;
    this.#authorizations = options.authorizations;
    this.#effects = options.effects;
    this.#sources = options.sources;
    this.#outputs = options.outputs;
    this.#now = options.now ?? (() => new Date());
  }

  async run(request: ProductionLoopRequest): Promise<LoopRunRecord> {
    const definition = loopDefinition(request.loopId);
    safeTenantKey(request.tenant);
    canonicalId(request.runId, "runId");
    const existing = this.#runs.load(request.tenant, request.runId);
    if (existing && existing.loopId !== definition.id)
      throw new Error("production loop request conflicts with the durable loop ID");
    const requestedAt = this.#now().toISOString();
    validDate(requestedAt, "production loop clock");
    const iterations =
      existing?.inputs ??
      (await this.#sources.fetch({
        definition,
        tenant: request.tenant,
        runId: request.runId,
        requestedAt,
      }));
    const authorizationEnvelopeId =
      existing?.authorizationEnvelopeId ?? request.authorizationEnvelopeId ?? null;
    const result = await executeVentureLoopCore({
      definition,
      input: {
        tenant: request.tenant,
        runId: request.runId,
        trigger: definition.trigger,
        iterations,
        authorizationEnvelopeId,
        authorizedEffects: [],
      },
      store: this.#runs,
      executor: this.#effects,
      authorizer: this.#authorizations,
      reconciliationEnvelopeId: request.reconciliationEnvelopeId,
      executionMode: "production",
      now: this.#now,
    });
    this.#outputs.write(result);
    return result;
  }
}

function rollback(database: SqliteDatabase): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original transactional failure.
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function runKey(tenant: TenantRef, runId: string): string {
  return `${safeTenantKey(tenant)}\u0000${canonicalId(runId, "runId")}`;
}

function terminal(status: LoopRunStatus): boolean {
  return status === "completed" || status === "insufficient_evidence" || status === "stopped";
}

const LOOP_TRIGGER_KINDS = new Set<LoopTriggerKind>(["manual", "schedule", "event"]);
const LOOP_AUTONOMY_VALUES = new Set<LoopAutonomy>([
  "observe",
  "report",
  "propose",
  "open_pr",
  "apply_low_risk",
  "apply_within_policy",
]);
const LOOP_METRIC_DIRECTIONS = new Set<LoopMetricDirection>([
  "increase",
  "decrease",
  "maintain",
  "observe",
]);
const LOOP_METRIC_OPERATORS = new Set<LoopMetricOperator>(["lt", "lte", "eq", "gte", "gt"]);
const LOOP_ACTION_KINDS = new Set<LoopDecisionAction["kind"]>([
  "observation",
  "proposal",
  "verified_fix",
  "pull_request",
  "policy_action",
]);
const LOOP_RISKS = new Set<LoopRisk>(["low", "moderate", "high", "critical"]);
const LOOP_OUTPUT_KINDS = new Set<VentureLoopDefinition["output"]["kind"]>([
  "report",
  "proposal",
  "pull_request",
]);
const LOOP_RUN_STATUSES = new Set<LoopRunStatus>([
  "running",
  "waiting_for_reconciliation",
  "completed",
  "insufficient_evidence",
  "stopped",
]);
const LOOP_ACTION_STATES = new Set<LoopActionState>([
  "observed",
  "proposed",
  "prepared",
  "retryable_no_effect",
  "applied",
  "confirmed_no_effect",
  "unknown",
  "rejected",
]);
const CREDENTIAL_LIKE_VALUE =
  /(?:\bbearer\s+[a-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk|ghp|github_pat)_(?:live|test)?_?[a-z0-9_-]{8,}|(?:password|secret|token|api[_-]?key|authorization)=)/iu;

function canonicalId(value: string, field: string): string {
  if (value !== value.trim() || !/^[a-z0-9][a-z0-9._-]*$/u.test(value))
    throw new Error(`${field} must be a canonical identifier`);
  assertCredentialFree(value, field);
  return value;
}

function assertExactPlainObject(
  value: unknown,
  expectedKeys: readonly string[],
  path: string,
): void {
  assertPlainObject(value, path);
  if (stableJson(Object.keys(value as object).sort()) !== stableJson([...expectedKeys].sort()))
    throw new Error(`${path} contains unclassified fields`);
}

function assertPlainObject(value: unknown, path: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be a plain object`);
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${path} must be a plain object`);
}

function safeTenantKey(tenant: TenantRef): string {
  assertExactPlainObject(tenant, ["organizationId", "ventureId"], "tenant");
  assertCredentialFree(tenant.organizationId, "organizationId");
  assertCredentialFree(tenant.ventureId, "ventureId");
  return tenantKey(tenant);
}

function canonicalText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized !== value || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error(`${field} must be nonempty canonical text`);
  return value;
}

function safeEvidenceReference(value: string): string {
  canonicalText(value, "evidenceRef");
  assertCredentialFree(value, "evidenceRef");
  if (
    value.length > 2_048 ||
    CREDENTIAL_LIKE_VALUE.test(value) ||
    !/^(?:audit|checkpoint|fixture|provider|report):\/\/[A-Za-z0-9._~:/-]+$/u.test(value)
  )
    throw new Error("evidenceRef must be a credential-free reference of at most 2048 characters");
  return value;
}

function assertSafeEvidence(
  value: unknown,
  path = "loop evidence",
): asserts value is LoopEffectEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must use the allowlisted effect-evidence schema`);
  const record = value as Record<string, unknown>;
  assertCredentialFree(record, path);
  const allowed = [
    "schemaVersion",
    "provenance",
    "verification",
    "evidenceRefs",
    "operationId",
    "readBackHash",
    "observedAt",
    "summaryCode",
  ];
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0)
    throw new Error(`${path} contains unclassified field(s): ${unexpected.join(", ")}`);
  if (record.schemaVersion !== 1) throw new Error(`${path} has an unsupported schema version`);
  if (
    !(["provider_readback", "local_checkpoint", "fixture"] as unknown[]).includes(record.provenance)
  )
    throw new Error(`${path} provenance is invalid`);
  if (
    !(["verified", "accepted_unverified", "confirmed_absent", "fixture"] as unknown[]).includes(
      record.verification,
    )
  ) {
    throw new Error(`${path} verification is invalid`);
  }
  if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.length === 0)
    throw new Error(`${path} requires at least one opaque evidence reference`);
  unique(
    record.evidenceRefs.map((reference) => {
      if (typeof reference !== "string") throw new Error(`${path} evidenceRefs must be strings`);
      return safeEvidenceReference(reference);
    }),
    `${path} evidenceRefs`,
  );
  if (record.operationId !== null) {
    if (typeof record.operationId !== "string") throw new Error(`${path} operationId is invalid`);
    canonicalId(record.operationId, `${path} operationId`);
    assertCredentialFree(record.operationId, `${path} operationId`);
  }
  if (record.readBackHash !== null && !/^[a-f0-9]{64}$/u.test(String(record.readBackHash)))
    throw new Error(`${path} readBackHash must be a SHA-256 digest or null`);
  if (typeof record.observedAt !== "string") throw new Error(`${path} observedAt is invalid`);
  validDate(record.observedAt, `${path} observedAt`);
  if (typeof record.summaryCode !== "string") throw new Error(`${path} summaryCode is invalid`);
  canonicalId(record.summaryCode, `${path} summaryCode`);
  assertCredentialFree(record.summaryCode, `${path} summaryCode`);
  if (record.provenance === "fixture" && record.verification !== "fixture")
    throw new Error(`${path} fixture provenance must remain explicitly fixture verified`);
  if (record.provenance !== "fixture" && record.verification === "fixture")
    throw new Error(`${path} fixture verification requires fixture provenance`);
}

function assertOutcomeEvidence(
  state: LoopEffectOutcome["state"],
  evidence: unknown,
  executionMode: "fixture" | "production",
  path: string,
  effect: string,
  trustedAt?: string,
): asserts evidence is LoopEffectEvidence {
  assertSafeEvidence(evidence, path);
  if (executionMode === "production" && evidence.provenance === "fixture")
    throw new Error(`${path} cannot use fixture provenance in production`);
  if (executionMode === "fixture" && evidence.provenance === "fixture") return;
  const required =
    state === "applied"
      ? "verified"
      : state === "confirmed_no_effect"
        ? "confirmed_absent"
        : "accepted_unverified";
  if (evidence.verification !== required)
    throw new Error(`${path} must be ${required} for outcome ${state}`);
  if (executionMode === "production" && state !== "unknown") {
    const requiredProvenance = effect === "local.write" ? "local_checkpoint" : "provider_readback";
    if (
      evidence.provenance !== requiredProvenance ||
      evidence.operationId === null ||
      evidence.readBackHash === null
    ) {
      throw new Error(
        `${path} requires an exact ${requiredProvenance.replace("_", " ")} binding for ${effect}`,
      );
    }
  }
  if (trustedAt !== undefined) {
    validDate(trustedAt, `${path} trustedAt`);
    const ageSeconds = (Date.parse(trustedAt) - Date.parse(evidence.observedAt)) / 1_000;
    if (ageSeconds < 0 || ageSeconds > 300)
      throw new Error(`${path} is future-dated or stale relative to the trusted clock`);
  }
}

function canonicalEffect(value: string): string {
  if (!/^(?:none|[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)$/u.test(value))
    throw new Error(`invalid loop effect: ${value}`);
  return value;
}

function validDate(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    throw new Error(`${field} must be a canonical ISO timestamp`);
  return value;
}

function sha256(value: JsonValue): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function definitionMaterial(definition: VentureLoopDefinition): JsonValue {
  return definition as unknown as JsonValue;
}

function inputMaterial(input: LoopRunInput): JsonValue {
  return input as unknown as JsonValue;
}

function validateLoopRunInputShape(input: LoopRunInput): void {
  assertExactPlainObject(
    input,
    ["authorizationEnvelopeId", "authorizedEffects", "iterations", "runId", "tenant", "trigger"],
    "loop run input",
  );
  safeTenantKey(input.tenant);
  canonicalId(input.runId, "runId");
  assertExactPlainObject(input.trigger, ["expression", "kind"], "loop run trigger");
  if (!LOOP_TRIGGER_KINDS.has(input.trigger.kind)) throw new Error("loop run trigger is invalid");
  canonicalText(input.trigger.expression, "loop run trigger expression");
  if (!Array.isArray(input.iterations)) throw new Error("loop run iterations must be an array");
  if (!Array.isArray(input.authorizedEffects))
    throw new Error("loop run authorizedEffects must be an array");
  if (input.authorizationEnvelopeId !== null)
    canonicalId(input.authorizationEnvelopeId, "authorizationEnvelopeId");
  assertCredentialFree(stableJson(inputMaterial(input)), "serialized loop run input");
}

function proposalArtifactId(input: {
  readonly loopId: VentureLoopId;
  readonly runId: string;
  readonly iteration: number;
  readonly ruleId: string;
  readonly decisionSurface: string;
  readonly evidenceRefs: readonly string[];
}): string {
  return sha256([
    "loop-proposal-v1",
    input.loopId,
    input.runId,
    input.iteration,
    input.ruleId,
    input.decisionSurface,
    [...input.evidenceRefs].sort(),
  ] as JsonValue);
}

function validateProposalArtifact(
  artifact: LoopProposalArtifact,
  record: Pick<LoopRunRecord, "loopId" | "runId">,
  actionRecord: Pick<LoopActionRecord, "action" | "iteration" | "ruleId">,
): void {
  assertExactPlainObject(
    artifact,
    [
      "artifactId",
      "decisionSurface",
      "evidenceRefs",
      "generatedAt",
      "iteration",
      "kind",
      "loopId",
      "ruleId",
      "runId",
      "schemaVersion",
    ],
    "loop proposal artifact",
  );
  assertCredentialFree(
    stableJson(artifact as unknown as JsonObject),
    "serialized loop proposal artifact",
  );
  if (artifact.schemaVersion !== 1 || artifact.kind !== "proposal")
    throw new Error("loop proposal artifact schema is invalid");
  if (
    artifact.loopId !== record.loopId ||
    artifact.runId !== record.runId ||
    artifact.iteration !== actionRecord.iteration ||
    artifact.ruleId !== actionRecord.ruleId ||
    artifact.decisionSurface !== actionRecord.action.decisionSurface
  ) {
    throw new Error("loop proposal artifact is not bound to its durable action");
  }
  if (!Number.isInteger(artifact.iteration) || artifact.iteration < 1)
    throw new Error("loop proposal artifact iteration is invalid");
  canonicalId(artifact.runId, "loop proposal runId");
  canonicalId(artifact.ruleId, "loop proposal ruleId");
  canonicalId(artifact.decisionSurface, "loop proposal decisionSurface");
  validDate(artifact.generatedAt, "loop proposal generatedAt");
  if (!Array.isArray(artifact.evidenceRefs) || artifact.evidenceRefs.length === 0)
    throw new Error("loop proposal artifact requires evidence references");
  const evidenceRefs = artifact.evidenceRefs.map(safeEvidenceReference);
  unique(evidenceRefs, "loop proposal evidenceRefs");
  if (
    artifact.artifactId !==
    proposalArtifactId({
      loopId: artifact.loopId,
      runId: artifact.runId,
      iteration: artifact.iteration,
      ruleId: artifact.ruleId,
      decisionSurface: artifact.decisionSurface,
      evidenceRefs,
    })
  ) {
    throw new Error("loop proposal artifact ID is not canonically evidence-bound");
  }
}

function parseRecord(
  value: string,
  expected?: {
    readonly tenantKey: string;
    readonly runId: string;
    readonly loopId: VentureLoopId;
    readonly definitionHash: string;
    readonly inputHash: string;
  },
): LoopRunRecord {
  assertCredentialFree(value, "stored loop record");
  const record = JSON.parse(value) as LoopRunRecord;
  assertExactPlainObject(
    record,
    [
      "actions",
      "authorizationEnvelopeId",
      "completedAt",
      "definitionHash",
      "evaluations",
      "inputHash",
      "inputs",
      "iteration",
      "limitations",
      "loopId",
      "nextRun",
      "output",
      "runId",
      "startedAt",
      "status",
      "stopReason",
      "tenant",
      "trigger",
      "updatedAt",
    ],
    "stored loop record",
  );
  const parsedTenantKey = safeTenantKey(record.tenant);
  canonicalId(record.runId, "runId");
  if (!VENTURE_LOOP_IDS.includes(record.loopId)) throw new Error("stored loop ID is invalid");
  if (!/^[a-f0-9]{64}$/u.test(record.definitionHash) || !/^[a-f0-9]{64}$/u.test(record.inputHash))
    throw new Error("stored loop hashes are invalid");
  if (record.authorizationEnvelopeId !== null)
    canonicalId(record.authorizationEnvelopeId, "stored loop authorizationEnvelopeId");
  assertExactPlainObject(record.trigger, ["expression", "kind"], "stored loop trigger");
  if (!LOOP_TRIGGER_KINDS.has(record.trigger.kind))
    throw new Error("stored loop trigger is invalid");
  canonicalText(record.trigger.expression, "stored loop trigger expression");
  if (!Array.isArray(record.inputs) || record.inputs.length === 0)
    throw new Error("stored loop inputs are invalid");
  assertCredentialFree(record.inputs, "stored loop inputs");
  for (const iteration of record.inputs) {
    assertExactPlainObject(iteration, ["evaluatedAt", "sources"], "stored loop input iteration");
    if (!Array.isArray(iteration.sources)) throw new Error("stored loop sources are invalid");
    for (const observation of iteration.sources) {
      assertExactPlainObject(
        observation,
        ["evidenceRefs", "metrics", "observedAt", "provenance", "sourceId"],
        "stored loop source",
      );
      assertPlainObject(observation.metrics, "stored loop metrics");
      if (observation.provenance.kind === "fixture") {
        assertExactPlainObject(
          observation.provenance,
          ["fixtureId", "kind"],
          "stored loop fixture provenance",
        );
      } else if (observation.provenance.kind === "connected_provider") {
        assertExactPlainObject(
          observation.provenance,
          [
            "connectionId",
            "externalAccountId",
            "fetchedAt",
            "kind",
            "operationId",
            "propertyId",
            "providerId",
            "quality",
            "readBackHash",
            "releaseVersion",
            "reportingWindow",
            "tenant",
          ],
          "stored loop provider provenance",
        );
      } else {
        throw new Error("stored loop provenance is invalid");
      }
    }
  }
  assertExactPlainObject(record.output, ["destination", "kind"], "stored loop output");
  assertExactPlainObject(record.nextRun, ["expression", "kind"], "stored loop next run");
  if (!LOOP_OUTPUT_KINDS.has(record.output.kind)) throw new Error("stored loop output is invalid");
  canonicalText(record.output.destination, "stored loop output destination");
  if (!LOOP_TRIGGER_KINDS.has(record.nextRun.kind))
    throw new Error("stored loop next-run trigger is invalid");
  canonicalText(record.nextRun.expression, "stored loop next-run expression");
  if (!LOOP_RUN_STATUSES.has(record.status)) throw new Error("stored loop status is invalid");
  if (!Number.isInteger(record.iteration) || record.iteration < 0)
    throw new Error("stored loop iteration is invalid");
  validDate(record.startedAt, "stored loop startedAt");
  validDate(record.updatedAt, "stored loop updatedAt");
  if (record.completedAt !== null) validDate(record.completedAt, "stored loop completedAt");
  if (
    Date.parse(record.updatedAt) < Date.parse(record.startedAt) ||
    (record.completedAt !== null && Date.parse(record.completedAt) < Date.parse(record.startedAt))
  ) {
    throw new Error("stored loop chronology is invalid");
  }
  const canonicalDefinition = loopDefinition(record.loopId);
  const usesCanonicalDefinition =
    record.definitionHash === sha256(definitionMaterial(canonicalDefinition));
  if (usesCanonicalDefinition) {
    const executionMode = record.inputs.every(({ sources }) =>
      sources.every(
        (observation: LoopSourceObservation) => observation.provenance.kind === "fixture",
      ),
    )
      ? "fixture"
      : "production";
    for (const iteration of record.inputs)
      observationMap(
        canonicalDefinition,
        iteration,
        record.startedAt,
        executionMode,
        record.tenant,
      );
  }
  for (const limitation of record.limitations) {
    canonicalText(limitation, "stored loop limitation");
    if (CREDENTIAL_LIKE_VALUE.test(limitation))
      throw new Error("stored loop limitation contains credential-like material");
  }
  if (!Array.isArray(record.actions)) throw new Error("stored loop actions are invalid");
  for (const actionRecord of record.actions) {
    assertExactPlainObject(
      actionRecord,
      [
        "action",
        "attemptToken",
        "evidence",
        "idempotencyKey",
        "iteration",
        "proposalArtifact",
        "reason",
        "ruleId",
        "state",
      ],
      "stored loop action",
    );
    if (!Number.isInteger(actionRecord.iteration) || actionRecord.iteration < 1)
      throw new Error("stored loop action iteration is invalid");
    canonicalId(actionRecord.ruleId, "stored loop ruleId");
    if (!/^[a-f0-9]{64}$/u.test(actionRecord.idempotencyKey))
      throw new Error("stored loop action idempotency key is invalid");
    if (!LOOP_ACTION_STATES.has(actionRecord.state))
      throw new Error("stored loop action state is invalid");
    if (actionRecord.attemptToken !== null)
      canonicalId(actionRecord.attemptToken, "stored loop attemptToken");
    if (
      ["prepared", "retryable_no_effect", "applied", "confirmed_no_effect", "unknown"].includes(
        actionRecord.state,
      ) &&
      actionRecord.attemptToken === null
    ) {
      throw new Error("stored effectful loop action has no attempt token");
    }
    if (!LOOP_ACTION_KINDS.has(actionRecord.action.kind))
      throw new Error("stored loop action kind is invalid");
    assertExactPlainObject(
      actionRecord.action,
      ["decisionSurface", "effect", "kind", "policyApproved", "risk", "title"],
      "stored loop decision action",
    );
    if (!LOOP_RISKS.has(actionRecord.action.risk))
      throw new Error("stored loop action risk is invalid");
    canonicalText(actionRecord.action.title, "stored loop action title");
    canonicalId(actionRecord.action.decisionSurface, "stored loop decisionSurface");
    canonicalEffect(actionRecord.action.effect);
    if (actionRecord.reason !== null)
      canonicalText(actionRecord.reason, "stored loop action reason");
    if (actionRecord.evidence !== null)
      assertSafeEvidence(actionRecord.evidence, "stored loop action evidence");
    if (actionRecord.proposalArtifact !== null) {
      validateProposalArtifact(actionRecord.proposalArtifact, record, actionRecord);
      if (actionRecord.state !== "proposed")
        throw new Error("stored loop proposal artifact is attached to a non-proposed action");
    } else if (actionRecord.state === "proposed") {
      throw new Error("stored proposed loop action has no durable proposal artifact");
    }
  }
  if (!Array.isArray(record.evaluations)) throw new Error("stored loop evaluations are invalid");
  let priorEvaluation = 0;
  for (const evaluation of record.evaluations as readonly LoopIterationEvaluation[]) {
    assertExactPlainObject(
      evaluation,
      [
        "assessedAt",
        "completionSatisfied",
        "decisions",
        "evaluatedAt",
        "guardrails",
        "iteration",
        "limitations",
        "sources",
      ],
      "stored loop evaluation",
    );
    if (!Number.isInteger(evaluation.iteration) || evaluation.iteration < 1)
      throw new Error("stored loop evaluation iteration is invalid");
    if (evaluation.iteration <= priorEvaluation)
      throw new Error("stored loop evaluations are not strictly ordered");
    priorEvaluation = evaluation.iteration;
    validDate(evaluation.evaluatedAt, "stored loop evaluatedAt");
    validDate(evaluation.assessedAt, "stored loop assessedAt");
    if (
      Date.parse(evaluation.evaluatedAt) > Date.parse(evaluation.assessedAt) ||
      Date.parse(evaluation.assessedAt) < Date.parse(record.startedAt)
    ) {
      throw new Error("stored loop evaluation chronology is invalid");
    }
    if (!Array.isArray(evaluation.sources) || evaluation.sources.length === 0)
      throw new Error("stored loop evaluation sources are invalid");
    unique(
      evaluation.sources.map((observation: LoopSourceObservation) => {
        assertExactPlainObject(
          observation,
          ["evidenceRefs", "metrics", "observedAt", "provenance", "sourceId"],
          "stored loop evaluation source",
        );
        assertPlainObject(observation.metrics, "stored loop evaluation metrics");
        canonicalId(observation.sourceId, "stored loop sourceId");
        validDate(observation.observedAt, "stored loop observedAt");
        if (Date.parse(observation.observedAt) > Date.parse(evaluation.evaluatedAt))
          throw new Error("stored loop observation chronology is invalid");
        if (observation.provenance.kind === "connected_provider") {
          validateConnectedProviderProvenance(
            observation.provenance,
            observation.observedAt,
            evaluation.assessedAt,
            record.tenant,
            `stored loop source ${observation.sourceId}`,
          );
        } else if (observation.provenance.kind === "fixture") {
          canonicalId(observation.provenance.fixtureId, "stored loop fixtureId");
        } else {
          throw new Error("stored loop provenance is invalid");
        }
        unique(observation.evidenceRefs.map(safeEvidenceReference), "stored loop evidenceRefs");
        for (const [metricId, metricValue] of Object.entries(observation.metrics)) {
          canonicalId(metricId, "stored loop metricId");
          if (metricValue !== null && !Number.isFinite(metricValue))
            throw new Error("stored loop metric must be finite or null");
        }
        return observation.sourceId;
      }),
      "stored loop sources",
    );
    unique(
      evaluation.guardrails.map(
        (guardrail: { readonly id: string; readonly breached: boolean }) => {
          assertExactPlainObject(guardrail, ["breached", "id"], "stored loop guardrail");
          const { id, breached } = guardrail;
          canonicalId(id, "stored loop guardrailId");
          if (typeof breached !== "boolean") throw new Error("stored loop guardrail is invalid");
          return id;
        },
      ),
      "stored loop guardrails",
    );
    unique(
      evaluation.decisions.map(
        (decision: { readonly ruleId: string; readonly matched: boolean }) => {
          assertExactPlainObject(decision, ["matched", "ruleId"], "stored loop decision");
          const { ruleId, matched } = decision;
          canonicalId(ruleId, "stored loop ruleId");
          if (typeof matched !== "boolean") throw new Error("stored loop decision is invalid");
          return ruleId;
        },
      ),
      "stored loop decisions",
    );
    if (typeof evaluation.completionSatisfied !== "boolean")
      throw new Error("stored loop completion evaluation is invalid");
    for (const limitation of evaluation.limitations) {
      canonicalText(limitation, "stored loop evaluation limitation");
      if (CREDENTIAL_LIKE_VALUE.test(limitation))
        throw new Error("stored loop evaluation limitation contains credential-like material");
    }
  }
  if (priorEvaluation > record.iteration)
    throw new Error("stored loop evaluations exceed the durable iteration");
  if (record.status === "completed" && record.evaluations.at(-1)?.completionSatisfied !== true)
    throw new Error("stored completed loop has no satisfied completion predicate");
  if (
    record.status === "completed" &&
    usesCanonicalDefinition &&
    !requiredCompletionEffectsApplied(
      canonicalDefinition,
      record.evaluations.at(-1)!,
      record.actions,
    )
  ) {
    throw new Error("stored completed loop has no verified required effect");
  }
  if (
    record.stopReason === "completion_unsatisfied" &&
    usesCanonicalDefinition &&
    record.evaluations.at(-1)?.completionSatisfied === true &&
    requiredCompletionEffectsApplied(
      canonicalDefinition,
      record.evaluations.at(-1)!,
      record.actions,
    )
  ) {
    throw new Error("stored unresolved loop contradicts a satisfied completion predicate");
  }
  if (
    (terminal(record.status) && record.completedAt === null) ||
    (!terminal(record.status) && record.completedAt !== null)
  ) {
    throw new Error("stored loop terminal timestamps are inconsistent");
  }
  if (expected) {
    if (
      parsedTenantKey !== expected.tenantKey ||
      record.runId !== expected.runId ||
      record.loopId !== expected.loopId ||
      record.definitionHash !== expected.definitionHash ||
      record.inputHash !== expected.inputHash
    ) {
      throw new Error("stored loop record does not match its durable row identity");
    }
  }
  return record;
}

function unique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`${field} must not contain duplicates`);
}

export function validateLoopDefinition(definition: VentureLoopDefinition): VentureLoopDefinition {
  assertCredentialFree(stableJson(definitionMaterial(definition)), "serialized loop definition");
  if (definition.schemaVersion !== 1) throw new Error("unsupported loop schema version");
  if (!VENTURE_LOOP_IDS.includes(definition.id))
    throw new Error(`unknown loop ID: ${definition.id}`);
  canonicalText(definition.title, "loop title");
  if (!LOOP_TRIGGER_KINDS.has(definition.trigger.kind))
    throw new Error("loop trigger kind is invalid");
  if (!LOOP_TRIGGER_KINDS.has(definition.nextRun.kind))
    throw new Error("loop next-run kind is invalid");
  canonicalText(definition.trigger.expression, "loop trigger expression");
  canonicalText(definition.nextRun.expression, "loop next-run expression");
  if (definition.inputSources.length === 0) throw new Error("loop inputSources must not be empty");
  unique(
    definition.inputSources.map(({ id }) => canonicalId(id, "sourceId")),
    "loop inputSources",
  );
  const sourceIds = new Set(definition.inputSources.map(({ id }) => id));
  for (const source of definition.inputSources) {
    if (typeof source.required !== "boolean")
      throw new Error(`loop source ${source.id} required must be boolean`);
    if (!Number.isInteger(source.freshnessSeconds) || source.freshnessSeconds < 1)
      throw new Error(`loop source ${source.id} freshnessSeconds must be positive`);
  }
  if (definition.primaryMetrics.length === 0)
    throw new Error("loop primaryMetrics must not be empty");
  unique(
    definition.primaryMetrics.map(({ sourceId, metricId }) => `${sourceId}.${metricId}`),
    "loop primaryMetrics",
  );
  for (const reference of [
    ...definition.primaryMetrics,
    ...definition.guardrails,
    ...definition.decisionRules.flatMap(({ when }) => when),
    ...definition.completion.when,
  ]) {
    if (!sourceIds.has(reference.sourceId))
      throw new Error(`loop metric references unknown source ${reference.sourceId}`);
    canonicalId(reference.metricId, "metricId");
    if ("threshold" in reference) {
      if (!LOOP_METRIC_OPERATORS.has(reference.operator))
        throw new Error("loop predicate operator is invalid");
      if (!Number.isFinite(reference.threshold))
        throw new Error("loop predicate threshold must be finite");
    } else if (!LOOP_METRIC_DIRECTIONS.has(reference.direction)) {
      throw new Error("loop metric direction is invalid");
    }
  }
  unique(
    definition.guardrails.map(({ id }) => canonicalId(id, "guardrailId")),
    "loop guardrails",
  );
  unique(
    definition.decisionRules.map(({ id }) => canonicalId(id, "ruleId")),
    "loop decisionRules",
  );
  for (const rule of definition.decisionRules) {
    if (rule.when.length === 0) throw new Error(`loop decision rule ${rule.id} has no predicate`);
    if (!LOOP_ACTION_KINDS.has(rule.action.kind))
      throw new Error(`loop rule ${rule.id} has an invalid action kind`);
    if (!LOOP_RISKS.has(rule.action.risk))
      throw new Error(`loop rule ${rule.id} has an invalid risk`);
    if (typeof rule.action.policyApproved !== "boolean")
      throw new Error(`loop rule ${rule.id} policyApproved must be boolean`);
    canonicalText(rule.action.title, "loop action title");
    canonicalId(rule.action.decisionSurface, "decisionSurface");
    canonicalEffect(rule.action.effect);
  }
  for (const guardrail of definition.guardrails) {
    if (guardrail.onBreach !== "stop")
      throw new Error(`loop guardrail ${guardrail.id} must stop on breach`);
  }
  if (!(definition.completion.mode === "all" || definition.completion.mode === "any"))
    throw new Error("loop completion mode is invalid");
  if (definition.completion.when.length === 0)
    throw new Error("loop completion must have at least one executable predicate");
  canonicalText(definition.completion.description, "loop completion description");
  if (!Number.isInteger(definition.maximumActions) || definition.maximumActions < 0)
    throw new Error("loop maximumActions must be a nonnegative integer");
  if (!Number.isInteger(definition.maximumIterations) || definition.maximumIterations < 1)
    throw new Error("loop maximumIterations must be positive");
  if (!LOOP_AUTONOMY_VALUES.has(definition.autonomy)) throw new Error("loop autonomy is invalid");
  unique(definition.allowedEffects.map(canonicalEffect), "loop allowedEffects");
  for (const rule of definition.decisionRules) {
    if (!definition.allowedEffects.includes(rule.action.effect))
      throw new Error(`loop rule ${rule.id} uses an undeclared effect`);
  }
  if (!/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u.test(definition.output.destination))
    throw new Error("loop output destination must be a safe relative path");
  if (!LOOP_OUTPUT_KINDS.has(definition.output.kind))
    throw new Error("loop output kind is invalid");
  const requiredStops: LoopStopKind[] = [
    "insufficient_evidence",
    ...(definition.guardrails.length > 0 ? (["guardrail_breach"] as const) : []),
    ...(definitionMayApply(definition) ? (["authorization_unavailable"] as const) : []),
    "completion_unsatisfied",
    "maximum_actions",
    "maximum_iterations",
    "unknown_effect",
    "completed",
  ];
  unique(
    definition.stopConditions.map(({ kind }) => kind),
    "loop stopConditions",
  );
  const knownStops = new Set<LoopStopKind>([
    "insufficient_evidence",
    "guardrail_breach",
    "authorization_unavailable",
    "completion_unsatisfied",
    "maximum_actions",
    "maximum_iterations",
    "unknown_effect",
    "completed",
  ]);
  if (definition.stopConditions.some(({ kind }) => !knownStops.has(kind)))
    throw new Error("loop stopConditions contain an invalid kind");
  for (const required of requiredStops) {
    if (!definition.stopConditions.some(({ kind }) => kind === required))
      throw new Error(`loop stopConditions must declare ${required}`);
  }
  definition.stopConditions.forEach(({ description }) =>
    canonicalText(description, "loop stop condition"),
  );
  return deepFreeze(structuredClone(definition));
}

function loop(definition: Omit<VentureLoopDefinition, "schemaVersion">): VentureLoopDefinition {
  return validateLoopDefinition({ schemaVersion: 1, ...definition });
}

function source(id: string, freshnessSeconds: number): LoopInputSource {
  return { id, required: true, freshnessSeconds };
}

function metric(
  sourceId: string,
  metricId: string,
  direction: LoopMetricDirection,
): LoopMetricReference {
  return { sourceId, metricId, direction };
}

function predicate(
  sourceId: string,
  metricId: string,
  operator: LoopMetricOperator,
  threshold: number,
): LoopMetricPredicate {
  return { sourceId, metricId, operator, threshold };
}

function action(
  kind: LoopDecisionAction["kind"],
  title: string,
  decisionSurface: string,
  effect: string,
  risk: LoopRisk,
  policyApproved: boolean,
): LoopDecisionAction {
  return { kind, title, decisionSurface, effect, risk, policyApproved };
}

function completion(
  mode: LoopCompletionRule["mode"],
  description: string,
  ...when: readonly LoopMetricPredicate[]
): LoopCompletionRule {
  return { mode, description, when };
}

function stops(completion: string): readonly LoopStopCondition[] {
  return [
    {
      kind: "insufficient_evidence",
      description:
        "Stop when required evidence is missing, stale, null, or invalid; missing is not zero.",
    },
    { kind: "guardrail_breach", description: "Stop when any declared guardrail is breached." },
    {
      kind: "authorization_unavailable",
      description: "Stop before an effect when its active run envelope is absent or invalid.",
    },
    {
      kind: "completion_unsatisfied",
      description: "Stop unresolved when the executable completion predicate is not satisfied.",
    },
    { kind: "maximum_actions", description: "Stop at the immutable per-run action cap." },
    { kind: "maximum_iterations", description: "Stop at the immutable iteration cap." },
    {
      kind: "unknown_effect",
      description:
        "Stop and reconcile when an effect outcome is unknown; never apply it again blindly.",
    },
    { kind: "completed", description: completion },
  ];
}

/**
 * Complete v0.2 operating-loop catalog. Definitions are inert data until an
 * explicit trigger, fresh evidence, a durable store, and (for effects) an
 * authorized executor are supplied.
 */
export const VENTURE_LOOP_CATALOG: readonly VentureLoopDefinition[] = Object.freeze([
  loop({
    id: "inner_build",
    title: "Inner build verification",
    trigger: { kind: "event", expression: "source.changed" },
    inputSources: [source("build_checks", 900)],
    primaryMetrics: [metric("build_checks", "failed_checks", "decrease")],
    guardrails: [
      {
        id: "critical_failure",
        ...predicate("build_checks", "critical_failures", "gt", 0),
        onBreach: "stop",
      },
    ],
    decisionRules: [
      {
        id: "repair_verified_failure",
        when: [predicate("build_checks", "failed_checks", "gt", 0)],
        action: action(
          "verified_fix",
          "Repair one reproduced build failure",
          "build",
          "local.write",
          "low",
          true,
        ),
      },
    ],
    completion: completion(
      "all",
      "Every declared build check passes.",
      predicate("build_checks", "failed_checks", "eq", 0),
    ),
    maximumActions: 3,
    maximumIterations: 3,
    autonomy: "apply_low_risk",
    allowedEffects: ["local.write"],
    output: { kind: "report", destination: "reports/loops/inner-build" },
    nextRun: { kind: "event", expression: "source.changed" },
    stopConditions: stops("Complete when every declared build check passes."),
  }),
  loop({
    id: "provider_verification",
    title: "Provider read-back verification",
    trigger: { kind: "event", expression: "provider.operation.accepted" },
    inputSources: [source("provider_readback", 300)],
    primaryMetrics: [metric("provider_readback", "matched", "increase")],
    guardrails: [
      {
        id: "ambiguous_outcome",
        ...predicate("provider_readback", "unknown", "gt", 0),
        onBreach: "stop",
      },
    ],
    decisionRules: [
      {
        id: "record_verified_readback",
        when: [predicate("provider_readback", "matched", "gte", 1)],
        action: action(
          "observation",
          "Record provider read-back evidence",
          "provider_verification",
          "none",
          "low",
          true,
        ),
      },
    ],
    completion: completion(
      "any",
      "Provider read-back matches or proves definitive absence.",
      predicate("provider_readback", "matched", "gte", 1),
      predicate("provider_readback", "confirmed_absent", "gte", 1),
    ),
    maximumActions: 1,
    maximumIterations: 5,
    autonomy: "report",
    allowedEffects: ["none"],
    output: { kind: "report", destination: "reports/loops/provider-verification" },
    nextRun: { kind: "event", expression: "provider.readback.due" },
    stopConditions: stops("Complete on matched provider read-back or verified definitive absence."),
  }),
  loop({
    id: "launch",
    title: "Launch readiness",
    trigger: { kind: "manual", expression: "launch.run" },
    inputSources: [source("launch_graph", 900), source("quality_gate", 900)],
    primaryMetrics: [metric("quality_gate", "passed_checks", "increase")],
    guardrails: [
      {
        id: "failed_gate",
        ...predicate("quality_gate", "failed_checks", "gt", 0),
        onBreach: "stop",
      },
      {
        id: "unauthorized_effect",
        ...predicate("launch_graph", "unauthorized_effects", "gt", 0),
        onBreach: "stop",
      },
    ],
    decisionRules: [
      {
        id: "propose_launch",
        when: [
          predicate("quality_gate", "failed_checks", "eq", 0),
          predicate("quality_gate", "passed_checks", "gte", 1),
          predicate("launch_graph", "required_nodes_total", "gte", 1),
          predicate("launch_graph", "required_nodes_remaining", "eq", 0),
          predicate("launch_graph", "exact_release_mismatches", "eq", 0),
        ],
        action: action(
          "proposal",
          "Propose the verified launch checkpoint",
          "launch",
          "none",
          "moderate",
          false,
        ),
      },
    ],
    completion: completion(
      "all",
      "Every required launch node and quality gate is verified.",
      predicate("quality_gate", "failed_checks", "eq", 0),
      predicate("quality_gate", "passed_checks", "gte", 1),
      predicate("launch_graph", "required_nodes_total", "gte", 1),
      predicate("launch_graph", "required_nodes_remaining", "eq", 0),
      predicate("launch_graph", "exact_release_mismatches", "eq", 0),
    ),
    maximumActions: 1,
    maximumIterations: 3,
    autonomy: "propose",
    allowedEffects: ["none"],
    output: { kind: "proposal", destination: "reports/loops/launch" },
    nextRun: { kind: "manual", expression: "launch.resume" },
    stopConditions: stops("Complete after every required launch node and quality gate verifies."),
  }),
  loop({
    id: "daily_early_signal",
    title: "Daily early-signal review",
    trigger: { kind: "schedule", expression: "15 5 * * *" },
    inputSources: [source("early_signals", 86_400)],
    primaryMetrics: [metric("early_signals", "qualified_events", "increase")],
    guardrails: [
      {
        id: "tracking_invalid",
        ...predicate("early_signals", "tracking_errors", "gt", 0),
        onBreach: "stop",
      },
    ],
    decisionRules: [
      {
        id: "report_signal",
        when: [predicate("early_signals", "qualified_events", "gte", 1)],
        action: action(
          "observation",
          "Report fresh early-signal evidence",
          "acquisition",
          "none",
          "low",
          true,
        ),
      },
    ],
    completion: completion(
      "all",
      "Fresh early-signal evidence was completely ingested, including a valid zero-signal result.",
      predicate("early_signals", "evidence_complete", "gte", 1),
    ),
    maximumActions: 1,
    maximumIterations: 1,
    autonomy: "report",
    allowedEffects: ["none"],
    output: { kind: "report", destination: "reports/learning/daily" },
    nextRun: { kind: "schedule", expression: "15 5 * * *" },
    stopConditions: stops("Complete after the fresh early-signal report is recorded."),
  }),
  loop({
    id: "weekly_growth",
    title: "Weekly growth review",
    trigger: { kind: "schedule", expression: "25 5 * * 1" },
    inputSources: [source("growth_metrics", 604_800)],
    primaryMetrics: [metric("growth_metrics", "activation_rate", "increase")],
    guardrails: [
      {
        id: "retention_regression",
        ...predicate("growth_metrics", "retention_regression", "gt", 0),
        onBreach: "stop",
      },
    ],
    decisionRules: [
      {
        id: "propose_growth_hypothesis",
        when: [predicate("growth_metrics", "sample_sufficient", "gte", 1)],
        action: action(
          "proposal",
          "Propose one growth hypothesis per decision surface",
          "growth",
          "none",
          "moderate",
          false,
        ),
      },
    ],
    completion: completion(
      "all",
      "The weekly growth sample is sufficient for a bounded decision.",
      predicate("growth_metrics", "sample_sufficient", "gte", 1),
    ),
    maximumActions: 3,
    maximumIterations: 1,
    autonomy: "propose",
    allowedEffects: ["none"],
    output: { kind: "proposal", destination: "reports/learning/weekly" },
    nextRun: { kind: "schedule", expression: "25 5 * * 1" },
    stopConditions: stops("Complete after bounded growth decisions are reported or proposed."),
  }),
  loop({
    id: "biweekly_product",
    title: "Biweekly product review",
    trigger: { kind: "schedule", expression: "0 7 1,15 * *" },
    inputSources: [source("product_metrics", 1_209_600)],
    primaryMetrics: [metric("product_metrics", "task_completion_rate", "increase")],
    guardrails: [
      {
        id: "reliability_regression",
        ...predicate("product_metrics", "reliability_regression", "gt", 0),
        onBreach: "stop",
      },
    ],
    decisionRules: [
      {
        id: "propose_product_hypothesis",
        when: [predicate("product_metrics", "sample_sufficient", "gte", 1)],
        action: action(
          "proposal",
          "Propose one product hypothesis per decision surface",
          "product",
          "none",
          "moderate",
          false,
        ),
      },
    ],
    completion: completion(
      "all",
      "The biweekly product sample is sufficient for a bounded decision.",
      predicate("product_metrics", "sample_sufficient", "gte", 1),
    ),
    maximumActions: 2,
    maximumIterations: 1,
    autonomy: "propose",
    allowedEffects: ["none"],
    output: { kind: "proposal", destination: "reports/learning/biweekly" },
    nextRun: { kind: "schedule", expression: "0 7 1,15 * *" },
    stopConditions: stops("Complete after bounded product decisions are reported or proposed."),
  }),
  loop({
    id: "monthly_strategy",
    title: "Monthly strategy review",
    trigger: { kind: "schedule", expression: "35 5 1 * *" },
    inputSources: [source("strategy_metrics", 2_678_400)],
    primaryMetrics: [metric("strategy_metrics", "retained_value", "increase")],
    guardrails: [
      {
        id: "cash_guardrail",
        ...predicate("strategy_metrics", "cash_guardrail_breached", "gt", 0),
        onBreach: "stop",
      },
    ],
    decisionRules: [
      {
        id: "propose_strategy_change",
        when: [predicate("strategy_metrics", "decision_ready", "gte", 1)],
        action: action(
          "proposal",
          "Propose one evidence-bound strategy decision",
          "strategy",
          "none",
          "high",
          false,
        ),
      },
    ],
    completion: completion(
      "all",
      "The monthly strategy evidence is decision-ready.",
      predicate("strategy_metrics", "decision_ready", "gte", 1),
    ),
    maximumActions: 1,
    maximumIterations: 1,
    autonomy: "propose",
    allowedEffects: ["none"],
    output: { kind: "proposal", destination: "reports/learning/monthly" },
    nextRun: { kind: "schedule", expression: "35 5 1 * *" },
    stopConditions: stops("Complete after one evidence-bound strategy decision is proposed."),
  }),
  loop({
    id: "winner_metric_snapshots",
    title: "Winner Loop metric snapshots",
    trigger: { kind: "schedule", expression: "*/30 * * * *" },
    inputSources: [source("winner_provider_metrics", 3_600)],
    primaryMetrics: [metric("winner_provider_metrics", "fresh_snapshots", "increase")],
    guardrails: [
      {
        id: "definition_conflict",
        ...predicate("winner_provider_metrics", "definition_conflicts", "gt", 0),
        onBreach: "stop",
      },
    ],
    decisionRules: [
      {
        id: "persist_snapshot",
        when: [predicate("winner_provider_metrics", "fresh_snapshots", "gte", 1)],
        action: action(
          "verified_fix",
          "Persist normalized metric snapshots",
          "winner_metrics",
          "local.write",
          "low",
          true,
        ),
      },
    ],
    completion: completion(
      "all",
      "At least one fresh normalized snapshot is durably persisted.",
      predicate("winner_provider_metrics", "fresh_snapshots", "gte", 1),
    ),
    maximumActions: 1,
    maximumIterations: 1,
    autonomy: "apply_low_risk",
    allowedEffects: ["local.write"],
    output: { kind: "report", destination: "reports/loops/winner-metric-snapshots" },
    nextRun: { kind: "schedule", expression: "*/30 * * * *" },
    stopConditions: stops("Complete after every fresh normalized metric snapshot is persisted."),
  }),
  loop({
    id: "creative_fatigue",
    title: "Creative fatigue review",
    trigger: { kind: "schedule", expression: "20 6 * * *" },
    inputSources: [source("creative_performance", 86_400)],
    primaryMetrics: [metric("creative_performance", "fatigue_score", "decrease")],
    guardrails: [
      {
        id: "attribution_uncertain",
        ...predicate("creative_performance", "attribution_uncertain", "gt", 0),
        onBreach: "stop",
      },
    ],
    decisionRules: [
      {
        id: "propose_fatigue_pause",
        when: [predicate("creative_performance", "fatigue_score", "gte", 1)],
        action: action(
          "proposal",
          "Propose a creative pause without scaling",
          "creative_fatigue",
          "provider.write",
          "high",
          false,
        ),
      },
    ],
    completion: completion(
      "all",
      "The fatigue evaluation is complete even when no pause is proposed.",
      predicate("creative_performance", "evaluation_complete", "gte", 1),
    ),
    maximumActions: 1,
    maximumIterations: 1,
    autonomy: "propose",
    allowedEffects: ["provider.write"],
    output: { kind: "proposal", destination: "reports/loops/creative-fatigue" },
    nextRun: { kind: "schedule", expression: "20 6 * * *" },
    stopConditions: stops("Complete after the fatigue recommendation is reported without scaling."),
  }),
  loop({
    id: "fleet_upgrade",
    title: "Fleet upgrade rollout",
    trigger: { kind: "event", expression: "core.release.verified" },
    inputSources: [source("release_manifest", 86_400), source("fleet_registry", 86_400)],
    primaryMetrics: [metric("fleet_registry", "eligible_ventures", "observe")],
    guardrails: [
      {
        id: "canary_failed",
        ...predicate("fleet_registry", "failed_canaries", "gt", 0),
        onBreach: "stop",
      },
      {
        id: "release_unverified",
        ...predicate("release_manifest", "verified", "lt", 1),
        onBreach: "stop",
      },
    ],
    decisionRules: [
      {
        id: "open_upgrade_pr",
        when: [predicate("fleet_registry", "eligible_ventures", "gte", 1)],
        action: action(
          "pull_request",
          "Open a bounded Fleet upgrade pull request",
          "fleet_upgrade",
          "git.open_pr",
          "moderate",
          true,
        ),
      },
    ],
    completion: completion(
      "all",
      "Every selected Fleet target verifies the exact release.",
      predicate("fleet_registry", "selected_targets_total", "gte", 1),
      predicate("fleet_registry", "selected_targets_remaining", "eq", 0),
      predicate("fleet_registry", "exact_release_mismatches", "eq", 0),
      predicate("fleet_registry", "rollout_verified", "gte", 1),
    ),
    maximumActions: 1,
    maximumIterations: 10,
    autonomy: "open_pr",
    allowedEffects: ["git.open_pr"],
    output: { kind: "pull_request", destination: "reports/loops/fleet-upgrade" },
    nextRun: { kind: "event", expression: "core.release.verified" },
    stopConditions: stops("Complete after every selected Fleet target verifies the exact release."),
  }),
]);

export function loopDefinition(id: VentureLoopId): VentureLoopDefinition {
  const definition = VENTURE_LOOP_CATALOG.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`unknown loop: ${id}`);
  return definition;
}

export function loopDefinitionHash(id: VentureLoopId): string {
  return sha256(definitionMaterial(loopDefinition(id)));
}

export function loopEffectIdempotencyKey(input: {
  readonly tenant: TenantRef;
  readonly runId: string;
  readonly loopId: VentureLoopId;
  readonly ruleId: string;
  readonly iteration: number;
}): string {
  const definition = loopDefinition(input.loopId);
  const runId = canonicalId(input.runId, "runId");
  const ruleId = canonicalId(input.ruleId, "ruleId");
  if (!definition.decisionRules.some(({ id }) => id === ruleId))
    throw new Error("loop effect rule is not declared by the immutable catalog definition");
  if (
    !Number.isInteger(input.iteration) ||
    input.iteration < 1 ||
    input.iteration > definition.maximumIterations
  ) {
    throw new Error("loop effect iteration is outside the immutable catalog bound");
  }
  return sha256([
    safeTenantKey(input.tenant),
    runId,
    input.loopId,
    ruleId,
    input.iteration,
  ] as JsonValue);
}

function compare(value: number, predicate: LoopMetricPredicate): boolean {
  if (predicate.operator === "lt") return value < predicate.threshold;
  if (predicate.operator === "lte") return value <= predicate.threshold;
  if (predicate.operator === "eq") return value === predicate.threshold;
  if (predicate.operator === "gte") return value >= predicate.threshold;
  return value > predicate.threshold;
}

type ConnectedProviderProvenance = Extract<
  LoopSourceObservation["provenance"],
  { readonly kind: "connected_provider" }
>;

function validateConnectedProviderProvenance(
  provenance: ConnectedProviderProvenance,
  observedAt: string,
  trustedAt: string,
  expectedTenant: TenantRef,
  path: string,
): readonly string[] {
  const keys = Object.keys(provenance).sort();
  const expectedKeys = [
    "connectionId",
    "externalAccountId",
    "fetchedAt",
    "kind",
    "operationId",
    "propertyId",
    "providerId",
    "quality",
    "readBackHash",
    "releaseVersion",
    "reportingWindow",
    "tenant",
  ];
  if (stableJson(keys) !== stableJson(expectedKeys))
    throw new Error(`${path} provider provenance is invalid`);
  if (safeTenantKey(provenance.tenant) !== safeTenantKey(expectedTenant))
    throw new Error(`${path} provider provenance belongs to a different tenant`);
  canonicalId(provenance.providerId, `${path} providerId`);
  canonicalId(provenance.connectionId, `${path} connectionId`);
  canonicalId(provenance.externalAccountId, `${path} externalAccountId`);
  if (provenance.propertyId !== null) canonicalId(provenance.propertyId, `${path} propertyId`);
  canonicalId(provenance.operationId, `${path} operationId`);
  if (!/^[a-f0-9]{64}$/u.test(provenance.readBackHash))
    throw new Error(`${path} readBackHash must be a SHA-256 digest`);
  validDate(provenance.fetchedAt, `${path} fetchedAt`);
  assertExactPlainObject(
    provenance.reportingWindow,
    ["endedAt", "startedAt", "timezone"],
    `${path} reportingWindow`,
  );
  validDate(provenance.reportingWindow.startedAt, `${path} reportingWindow.startedAt`);
  validDate(provenance.reportingWindow.endedAt, `${path} reportingWindow.endedAt`);
  if (
    Date.parse(provenance.reportingWindow.startedAt) >=
      Date.parse(provenance.reportingWindow.endedAt) ||
    Date.parse(provenance.reportingWindow.endedAt) > Date.parse(provenance.fetchedAt) ||
    Date.parse(observedAt) > Date.parse(provenance.fetchedAt) ||
    Date.parse(provenance.fetchedAt) > Date.parse(trustedAt)
  ) {
    throw new Error(`${path} provider chronology is invalid`);
  }
  if (!/^(?:UTC|[A-Za-z_]+\/[A-Za-z0-9_+.-]+)$/u.test(provenance.reportingWindow.timezone))
    throw new Error(`${path} reporting timezone is invalid`);
  assertExactPlainObject(provenance.quality, ["limitations", "status"], `${path} provider quality`);
  if (!(provenance.quality.status === "complete" || provenance.quality.status === "partial"))
    throw new Error(`${path} provider quality status is invalid`);
  if (!Array.isArray(provenance.quality.limitations))
    throw new Error(`${path} provider quality limitations are invalid`);
  const limitations = provenance.quality.limitations.map((limitation) => {
    return canonicalId(limitation, `${path} provider quality limitation code`);
  });
  if (provenance.quality.status === "complete" && limitations.length > 0)
    throw new Error(`${path} complete provider evidence cannot carry quality limitations`);
  if (provenance.quality.status === "partial" && limitations.length === 0)
    throw new Error(`${path} partial provider evidence must explain its limitation`);
  canonicalId(provenance.releaseVersion, `${path} releaseVersion`);
  return limitations.map((limitation) => `${path} provider evidence is partial: ${limitation}`);
}

function observationMap(
  definition: VentureLoopDefinition,
  iteration: LoopIterationInput,
  executionStartedAt: string,
  executionMode: "fixture" | "production",
  expectedTenant: TenantRef,
): { readonly observations: Map<string, LoopSourceObservation>; readonly limitations: string[] } {
  assertExactPlainObject(iteration, ["evaluatedAt", "sources"], "loop iteration input");
  if (!Array.isArray(iteration.sources)) throw new Error("loop iteration sources must be an array");
  validDate(iteration.evaluatedAt, "evaluatedAt");
  if (Date.parse(iteration.evaluatedAt) > Date.parse(executionStartedAt))
    throw new Error("loop evaluation cannot be dated after execution started");
  const observations = new Map<string, LoopSourceObservation>();
  const limitations: string[] = [];
  for (const observation of iteration.sources) {
    assertExactPlainObject(
      observation,
      ["evidenceRefs", "metrics", "observedAt", "provenance", "sourceId"],
      `loop source ${observation.sourceId || "unknown"}`,
    );
    assertCredentialFree(observation, `loop source ${observation.sourceId || "unknown"}`);
    canonicalId(observation.sourceId, "sourceId");
    if (!definition.inputSources.some(({ id }) => id === observation.sourceId))
      throw new Error(`loop source ${observation.sourceId} is not declared by the definition`);
    if (observations.has(observation.sourceId))
      throw new Error(`duplicate loop source observation: ${observation.sourceId}`);
    validDate(observation.observedAt, "observedAt");
    if (Date.parse(observation.observedAt) > Date.parse(iteration.evaluatedAt))
      throw new Error(`loop source ${observation.sourceId} is dated after evaluation`);
    if (!observation.provenance || typeof observation.provenance !== "object")
      throw new Error(`loop source ${observation.sourceId} requires explicit provenance`);
    if (observation.provenance.kind === "connected_provider") {
      limitations.push(
        ...validateConnectedProviderProvenance(
          observation.provenance,
          observation.observedAt,
          executionStartedAt,
          expectedTenant,
          `loop source ${observation.sourceId}`,
        ),
      );
    } else if (observation.provenance.kind === "fixture") {
      const keys = Object.keys(observation.provenance).sort();
      if (stableJson(keys) !== stableJson(["fixtureId", "kind"]))
        throw new Error(`loop source ${observation.sourceId} fixture provenance is invalid`);
      canonicalId(observation.provenance.fixtureId, "fixtureId");
      if (executionMode === "production")
        throw new Error(
          `production loop source ${observation.sourceId} cannot use fixture provenance`,
        );
    } else {
      throw new Error(`loop source ${observation.sourceId} provenance kind is invalid`);
    }
    if (!Array.isArray(observation.evidenceRefs))
      throw new Error(`loop source ${observation.sourceId} evidenceRefs must be an array`);
    unique(observation.evidenceRefs.map(safeEvidenceReference), "evidenceRefs");
    if (observation.evidenceRefs.length === 0)
      limitations.push(`Loop source ${observation.sourceId} has no evidence reference.`);
    assertPlainObject(observation.metrics, `loop source ${observation.sourceId} metrics`);
    const declaredMetrics = new Set(
      [
        ...definition.primaryMetrics,
        ...definition.guardrails,
        ...definition.decisionRules.flatMap(({ when }) => when),
        ...definition.completion.when,
      ]
        .filter(({ sourceId }) => sourceId === observation.sourceId)
        .map(({ metricId }) => metricId),
    );
    for (const [metricId, value] of Object.entries(observation.metrics)) {
      canonicalId(metricId, "metricId");
      if (!declaredMetrics.has(metricId))
        throw new Error(
          `loop metric ${observation.sourceId}.${metricId} is not declared by the immutable definition`,
        );
      if (value !== null && !Number.isFinite(value))
        throw new Error(`loop metric ${observation.sourceId}.${metricId} must be finite or null`);
    }
    observations.set(observation.sourceId, observation);
  }
  for (const required of definition.inputSources.filter(({ required }) => required)) {
    const observation = observations.get(required.id);
    if (!observation) {
      limitations.push(`Required loop source ${required.id} is missing; missing is not zero.`);
      continue;
    }
    const ageSeconds =
      (Date.parse(executionStartedAt) - Date.parse(observation.observedAt)) / 1_000;
    if (ageSeconds > required.freshnessSeconds) {
      limitations.push(
        `Required loop source ${required.id} is stale (${ageSeconds}s > ${required.freshnessSeconds}s).`,
      );
    }
  }
  for (const primary of definition.primaryMetrics) {
    const value = observations.get(primary.sourceId)?.metrics[primary.metricId];
    if (value === null || value === undefined)
      limitations.push(
        `Primary loop metric ${primary.sourceId}.${primary.metricId} is unavailable.`,
      );
  }
  for (const guardrail of definition.guardrails) {
    const value = observations.get(guardrail.sourceId)?.metrics[guardrail.metricId];
    if (value === null || value === undefined)
      limitations.push(
        `Guardrail loop metric ${guardrail.sourceId}.${guardrail.metricId} is unavailable.`,
      );
  }
  const decisionMetrics = new Map<string, LoopMetricPredicate>();
  for (const predicate of definition.decisionRules.flatMap(({ when }) => when)) {
    decisionMetrics.set(`${predicate.sourceId}.${predicate.metricId}`, predicate);
  }
  for (const predicate of decisionMetrics.values()) {
    const value = observations.get(predicate.sourceId)?.metrics[predicate.metricId];
    if (value === null || value === undefined)
      limitations.push(
        `Decision loop metric ${predicate.sourceId}.${predicate.metricId} is unavailable; missing is not false.`,
      );
  }
  const completionMetrics = new Map<string, LoopMetricPredicate>();
  for (const predicate of definition.completion.when) {
    completionMetrics.set(`${predicate.sourceId}.${predicate.metricId}`, predicate);
  }
  for (const predicate of completionMetrics.values()) {
    const value = observations.get(predicate.sourceId)?.metrics[predicate.metricId];
    if (value === null || value === undefined)
      limitations.push(
        `Completion loop metric ${predicate.sourceId}.${predicate.metricId} is unavailable; completion cannot be inferred.`,
      );
  }
  return { observations, limitations };
}

function predicateValue(
  observations: ReadonlyMap<string, LoopSourceObservation>,
  predicate: LoopMetricPredicate,
): number | null {
  return observations.get(predicate.sourceId)?.metrics[predicate.metricId] ?? null;
}

function predicatesSatisfied(
  mode: "all" | "any",
  predicates: readonly LoopMetricPredicate[],
  observations: ReadonlyMap<string, LoopSourceObservation>,
): boolean {
  const results = predicates.map((condition) => {
    const value = predicateValue(observations, condition);
    return value !== null && compare(value, condition);
  });
  return mode === "all" ? results.every(Boolean) : results.some(Boolean);
}

function createProposalArtifact(input: {
  readonly definition: VentureLoopDefinition;
  readonly runId: string;
  readonly iteration: number;
  readonly rule: LoopDecisionRule;
  readonly sources: readonly LoopSourceObservation[];
  readonly generatedAt: string;
}): LoopProposalArtifact {
  const evidenceRefs = [
    ...new Set(
      input.sources.flatMap(({ evidenceRefs }) => evidenceRefs.map(safeEvidenceReference)),
    ),
  ].sort();
  if (evidenceRefs.length === 0)
    throw new Error("a loop proposal cannot be materialized without evidence references");
  const artifact: LoopProposalArtifact = {
    schemaVersion: 1,
    kind: "proposal",
    artifactId: proposalArtifactId({
      loopId: input.definition.id,
      runId: input.runId,
      iteration: input.iteration,
      ruleId: input.rule.id,
      decisionSurface: input.rule.action.decisionSurface,
      evidenceRefs,
    }),
    loopId: input.definition.id,
    runId: input.runId,
    iteration: input.iteration,
    ruleId: input.rule.id,
    decisionSurface: input.rule.action.decisionSurface,
    evidenceRefs,
    generatedAt: input.generatedAt,
  };
  validateProposalArtifact(
    artifact,
    { loopId: input.definition.id, runId: input.runId },
    {
      action: input.rule.action,
      iteration: input.iteration,
      ruleId: input.rule.id,
    },
  );
  return deepFreeze(artifact);
}

function actionDisposition(
  definition: VentureLoopDefinition,
  action: LoopDecisionAction,
  authorizedEffects: ReadonlySet<string>,
): { readonly apply: boolean; readonly state: LoopActionState; readonly reason: string | null } {
  if (!definition.allowedEffects.includes(action.effect))
    return { apply: false, state: "rejected", reason: "effect is not declared by the loop" };
  if (definition.autonomy === "observe" || definition.autonomy === "report")
    return { apply: false, state: "observed", reason: null };
  if (definition.autonomy === "propose") return { apply: false, state: "proposed", reason: null };
  if (!authorizedEffects.has(action.effect))
    return {
      apply: false,
      state: "rejected",
      reason: "effect is outside the active authorization",
    };
  if (definition.autonomy === "open_pr" && action.effect !== "git.open_pr")
    return { apply: false, state: "rejected", reason: "open_pr autonomy permits only git.open_pr" };
  if (definition.autonomy === "apply_low_risk" && action.risk !== "low")
    return { apply: false, state: "proposed", reason: "effect is not low risk" };
  if (
    definition.autonomy === "apply_within_policy" &&
    (!action.policyApproved || action.risk === "critical")
  )
    return { apply: false, state: "proposed", reason: "effect is outside approved policy" };
  return { apply: true, state: "prepared", reason: null };
}

function definitionMayApply(definition: VentureLoopDefinition): boolean {
  if (
    definition.autonomy === "observe" ||
    definition.autonomy === "report" ||
    definition.autonomy === "propose"
  ) {
    return false;
  }
  return definition.decisionRules.some(({ action }) => action.effect !== "none");
}

function requiredCompletionEffectsApplied(
  definition: VentureLoopDefinition,
  evaluation: LoopIterationEvaluation,
  actions: readonly LoopActionRecord[],
): boolean {
  if (!definitionMayApply(definition)) return true;
  const requiredRuleIds = evaluation.decisions
    .filter(({ matched }) => matched)
    .map(({ ruleId }) => ruleId)
    .filter((ruleId) => {
      const rule = definition.decisionRules.find((candidate) => candidate.id === ruleId);
      return rule !== undefined && rule.action.effect !== "none";
    });
  return requiredRuleIds.every((ruleId) =>
    actions.some(
      (actionRecord) => actionRecord.ruleId === ruleId && actionRecord.state === "applied",
    ),
  );
}

function effectRequest(record: LoopRunRecord, actionRecord: LoopActionRecord): LoopEffectRequest {
  if (!actionRecord.attemptToken)
    throw new Error("effectful loop action is missing its fencing attempt token");
  if (!record.authorizationEnvelopeId)
    throw new Error("effectful loop action is missing its authorization envelope");
  return {
    tenant: record.tenant,
    runId: record.runId,
    loopId: record.loopId,
    definitionHash: record.definitionHash,
    iteration: actionRecord.iteration,
    ruleId: actionRecord.ruleId,
    idempotencyKey: actionRecord.idempotencyKey,
    authorizationEnvelopeId: record.authorizationEnvelopeId,
    attemptToken: actionRecord.attemptToken,
    action: actionRecord.action,
  };
}

function updated(record: LoopRunRecord, patch: Partial<LoopRunRecord>, now: string): LoopRunRecord {
  return { ...record, ...patch, updatedAt: now };
}

async function reconcilePreparedActions(
  record: LoopRunRecord,
  executor: LoopEffectExecutor | undefined,
  reconciliationEnvelopeId: string | undefined,
  executionMode: "fixture" | "production",
  now: string,
): Promise<LoopRunRecord> {
  let next = record;
  for (const [index, actionRecord] of next.actions.entries()) {
    if (!(["prepared", "unknown"] as LoopActionState[]).includes(actionRecord.state)) continue;
    if (!executor) {
      return updated(
        next,
        { status: "waiting_for_reconciliation", stopReason: "waiting_for_reconciliation" },
        now,
      );
    }
    const request = effectRequest(next, actionRecord);
    if (executionMode === "production" && reconciliationEnvelopeId === undefined)
      return updated(
        next,
        {
          status: "waiting_for_reconciliation",
          stopReason: "waiting_for_reconciliation",
          limitations: [
            ...next.limitations,
            "A fresh read-back-only authorization envelope is required for reconciliation.",
          ],
        },
        now,
      );
    let reconciled: LoopEffectReconciliation;
    try {
      reconciled = await executor.reconcile(request, reconciliationEnvelopeId);
    } catch (error) {
      if (
        executionMode !== "production" ||
        !(error instanceof LoopEffectAuthorizationUnavailableError)
      ) {
        throw error;
      }
      return updated(
        next,
        {
          status: "waiting_for_reconciliation",
          stopReason: "waiting_for_reconciliation",
          limitations: [
            ...next.limitations,
            "A fresh read-back-only authorization envelope is required for reconciliation.",
          ],
        },
        now,
      );
    }
    assertOutcomeEvidence(
      reconciled.state,
      reconciled.evidence,
      executionMode,
      "loop reconciliation evidence",
      request.action.effect,
      now,
    );
    const state =
      reconciled.state === "applied"
        ? "applied"
        : reconciled.state === "confirmed_no_effect"
          ? reconciled.attemptFenced === true
            ? "retryable_no_effect"
            : "unknown"
          : "unknown";
    const actions = [...next.actions];
    actions[index] = { ...actionRecord, state, evidence: reconciled.evidence };
    next = updated(next, { actions }, now);
    if (state === "unknown") {
      return updated(
        next,
        { status: "waiting_for_reconciliation", stopReason: "waiting_for_reconciliation" },
        now,
      );
    }
  }
  return updated(next, { status: "running", stopReason: null }, now);
}

interface VentureLoopExecutionOptions {
  readonly definition: VentureLoopDefinition;
  readonly input: LoopRunInput;
  readonly store: LoopRunStore;
  readonly executor?: LoopEffectExecutor;
  readonly authorizer?: LoopEffectAuthorizer;
  readonly reconciliationEnvelopeId?: string;
  readonly executionMode: "fixture" | "production";
  readonly now?: () => Date;
  readonly ownerToken?: string;
  readonly leaseMilliseconds?: number;
}

/**
 * Execute an explicitly labeled fixture loop. Production callers cannot
 * supply observations here; only ProductionLoopRuntime can enter the private
 * production core after ConnectedLoopSourceFetcher validates provider input.
 */
export async function executeVentureLoop(
  options: Omit<VentureLoopExecutionOptions, "executionMode"> & {
    readonly executionMode?: "fixture";
  },
): Promise<LoopRunRecord> {
  if ((options as { readonly executionMode?: unknown }).executionMode === "production")
    throw new Error(
      "raw production loop execution is forbidden; use ProductionLoopRuntime with connected evidence",
    );
  return executeVentureLoopCore({ ...options, executionMode: "fixture" });
}

async function executeVentureLoopCore(
  options: VentureLoopExecutionOptions,
): Promise<LoopRunRecord> {
  const definition = validateLoopDefinition(options.definition);
  validateLoopRunInputShape(options.input);
  const input = deepFreeze(structuredClone(options.input));
  const executionMode = options.executionMode;
  if (
    executionMode === "production" &&
    sha256(definitionMaterial(definition)) !==
      sha256(definitionMaterial(loopDefinition(definition.id)))
  ) {
    throw new Error("production loop execution requires the immutable catalog definition");
  }
  if (executionMode === "production" && !(options.store instanceof SqliteLoopRunStore))
    throw new Error("production loop execution requires the concrete durable SQLite run store");
  if (definitionMayApply(definition) && !options.executor)
    throw new Error("effectful loop execution requires an injected apply-once executor");
  if (
    executionMode === "production" &&
    definitionMayApply(definition) &&
    !(options.executor instanceof SqliteLoopEffectExecutor)
  ) {
    throw new Error("production loop effects require the durable SQLite apply-once executor");
  }
  if (options.reconciliationEnvelopeId !== undefined)
    canonicalId(options.reconciliationEnvelopeId, "reconciliationEnvelopeId");
  if (
    executionMode === "production" &&
    definitionMayApply(definition) &&
    !(options.authorizer instanceof SqliteLoopAuthorizationStore)
  ) {
    throw new Error("production loop effects require the authoritative SQLite envelope store");
  }
  safeTenantKey(input.tenant);
  canonicalId(input.runId, "runId");
  if (
    input.trigger.kind !== definition.trigger.kind ||
    input.trigger.expression !== definition.trigger.expression
  ) {
    throw new Error("loop trigger does not match the immutable definition");
  }
  unique(input.authorizedEffects.map(canonicalEffect), "authorizedEffects");
  if (input.authorizationEnvelopeId !== null)
    canonicalId(input.authorizationEnvelopeId, "authorizationEnvelopeId");
  if (executionMode === "production" && input.authorizedEffects.length > 0)
    throw new Error("production loop execution cannot trust caller-declared authorized effects");
  if (
    executionMode === "production" &&
    definitionMayApply(definition) &&
    input.authorizationEnvelopeId === null
  ) {
    throw new Error("production loop effects require an authorization envelope ID");
  }
  if (input.iterations.length === 0) throw new Error("loop execution requires iteration input");
  if (input.iterations.length > definition.maximumIterations)
    throw new Error("loop iteration input exceeds the immutable maximumIterations");
  const now = options.now ?? (() => new Date());
  const leaseMilliseconds = options.leaseMilliseconds ?? 30_000;
  if (!Number.isInteger(leaseMilliseconds) || leaseMilliseconds < 1)
    throw new Error("loop leaseMilliseconds must be positive");
  const startedAt = now().toISOString();
  validDate(startedAt, "loop execution clock");
  let lastClockMs = Date.parse(startedAt);
  const currentTimestamp = (): string => {
    const value = now().toISOString();
    validDate(value, "loop execution clock");
    const milliseconds = Date.parse(value);
    if (milliseconds < lastClockMs) throw new Error("loop execution clock moved backwards");
    lastClockMs = milliseconds;
    return value;
  };
  let priorEvaluationMs = Number.NEGATIVE_INFINITY;
  // Reject malformed/future/foreign/non-finite evidence before acquiring a
  // durable lease. Missing or stale evidence is a valid persisted no-action
  // outcome and is therefore handled again inside the claimed run.
  for (const iteration of input.iterations) {
    observationMap(definition, iteration, startedAt, executionMode, input.tenant);
    const evaluationMs = Date.parse(iteration.evaluatedAt);
    if (evaluationMs <= priorEvaluationMs)
      throw new Error("loop iteration evaluatedAt values must be strictly increasing");
    priorEvaluationMs = evaluationMs;
  }
  const record: LoopRunRecord = {
    tenant: clone(input.tenant),
    runId: input.runId,
    loopId: definition.id,
    definitionHash: sha256(definitionMaterial(definition)),
    inputHash: sha256(inputMaterial(input)),
    authorizationEnvelopeId: input.authorizationEnvelopeId,
    trigger: clone(input.trigger),
    inputs: clone(input.iterations),
    status: "running",
    iteration: 0,
    actions: [],
    evaluations: [],
    limitations: [],
    stopReason: null,
    output: clone(definition.output),
    nextRun: clone(definition.nextRun),
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
  };
  const ownerToken = canonicalId(options.ownerToken ?? randomUUID(), "ownerToken");
  const leaseExpiresAt = new Date(Date.parse(startedAt) + leaseMilliseconds).toISOString();
  const renewedLease = (): string =>
    new Date(Date.parse(currentTimestamp()) + leaseMilliseconds).toISOString();
  const claim = options.store.claim({ record, ownerToken, leaseExpiresAt, now: startedAt });
  if (claim.state === "conflict") throw new Error("loop idempotency conflict");
  if (claim.state === "pending") throw new Error("loop run is pending under another owner");
  if (claim.state === "replay") return claim.record;
  const persist = (value: LoopRunRecord): void =>
    options.store.save(value, ownerToken, renewedLease());
  const authorizedEffects = new Set(
    executionMode === "production" ? definition.allowedEffects : input.authorizedEffects,
  );
  const isApplyAuthorized = async (request: LoopEffectRequest): Promise<boolean> => {
    if (!authorizedEffects.has(request.action.effect)) return false;
    if (!options.authorizer) return executionMode === "fixture";
    return (await options.authorizer.authorize(request)) === true;
  };

  let current = await reconcilePreparedActions(
    claim.record,
    options.executor,
    options.reconciliationEnvelopeId,
    executionMode,
    currentTimestamp(),
  );
  persist(current);
  if (current.status === "waiting_for_reconciliation") return current;

  for (const [index, recovered] of current.actions.entries()) {
    if (recovered.state !== "retryable_no_effect") continue;
    if (!options.executor) {
      current = updated(
        current,
        { status: "waiting_for_reconciliation", stopReason: "waiting_for_reconciliation" },
        currentTimestamp(),
      );
      persist(current);
      return current;
    }
    const retryIteration = input.iterations[recovered.iteration - 1];
    if (!retryIteration)
      throw new Error("recovered loop action references an unavailable iteration");
    const retryFreshness = observationMap(
      definition,
      retryIteration,
      currentTimestamp(),
      executionMode,
      input.tenant,
    ).limitations;
    if (retryFreshness.length > 0) {
      current = updated(
        current,
        {
          status: "insufficient_evidence",
          stopReason: "insufficient_evidence",
          limitations: [...current.limitations, ...retryFreshness],
          completedAt: currentTimestamp(),
        },
        currentTimestamp(),
      );
      persist(current);
      return current;
    }
    let retry: LoopActionRecord = {
      ...recovered,
      attemptToken: ownerToken,
      state: "prepared",
      reason: "the prior attempt was durably fenced with no effect; retrying the same action",
      evidence: recovered.evidence,
    };
    if (!(await isApplyAuthorized(effectRequest(current, retry)))) {
      retry = {
        ...retry,
        attemptToken: null,
        state: "rejected",
        reason: "active authorization is unavailable for the reconciled retry",
      };
      const actions = [...current.actions];
      actions[index] = retry;
      current = updated(
        current,
        {
          actions,
          status: "stopped",
          stopReason: "authorization_unavailable",
          limitations: [
            ...current.limitations,
            "The reconciled loop effect has no active verified run envelope.",
          ],
          completedAt: currentTimestamp(),
        },
        currentTimestamp(),
      );
      persist(current);
      return current;
    }
    const postAuthorizationRetryFreshness = observationMap(
      definition,
      retryIteration,
      currentTimestamp(),
      executionMode,
      input.tenant,
    ).limitations;
    if (postAuthorizationRetryFreshness.length > 0) {
      current = updated(
        current,
        {
          status: "insufficient_evidence",
          stopReason: "insufficient_evidence",
          limitations: [...current.limitations, ...postAuthorizationRetryFreshness],
          completedAt: currentTimestamp(),
        },
        currentTimestamp(),
      );
      persist(current);
      return current;
    }
    let actions = [...current.actions];
    actions[index] = retry;
    current = updated(current, { actions }, currentTimestamp());
    persist(current);
    const outcome = await options.executor.apply(effectRequest(current, retry));
    assertOutcomeEvidence(
      outcome.state,
      outcome.evidence,
      executionMode,
      "loop effect evidence",
      retry.action.effect,
      currentTimestamp(),
    );
    retry = {
      ...retry,
      state:
        outcome.state === "applied"
          ? "applied"
          : outcome.state === "confirmed_no_effect"
            ? "confirmed_no_effect"
            : "unknown",
      evidence: outcome.evidence,
    };
    actions = [...current.actions];
    actions[index] = retry;
    current = updated(current, { actions }, currentTimestamp());
    if (retry.state === "unknown") {
      current = updated(
        current,
        { status: "waiting_for_reconciliation", stopReason: "waiting_for_reconciliation" },
        currentTimestamp(),
      );
      persist(current);
      return current;
    }
    persist(current);
  }

  const recoveredEvaluation = current.evaluations.at(-1);
  if (
    recoveredEvaluation?.completionSatisfied === true &&
    requiredCompletionEffectsApplied(definition, recoveredEvaluation, current.actions)
  ) {
    const completedAt = currentTimestamp();
    current = updated(
      current,
      { status: "completed", stopReason: "completed", completedAt },
      completedAt,
    );
    persist(current);
    return current;
  }

  const usedSurfaces = new Set(
    current.actions
      .filter(({ state, action }) => state !== "rejected" && action.kind === "proposal")
      .map(({ action }) => action.decisionSurface),
  );
  let materialActions = current.actions.filter(({ state }) => state !== "rejected").length;

  for (let index = current.iteration; index < input.iterations.length; index += 1) {
    const iterationNumber = index + 1;
    const assessedAt = currentTimestamp();
    const { observations, limitations } = observationMap(
      definition,
      input.iterations[index]!,
      assessedAt,
      executionMode,
      input.tenant,
    );
    const guardrailEvaluations = definition.guardrails.map((guardrail) => ({
      id: guardrail.id,
      breached: predicatesSatisfied("all", [guardrail], observations),
    }));
    const decisionEvaluations = definition.decisionRules.map((rule) => ({
      ruleId: rule.id,
      matched: predicatesSatisfied("all", rule.when, observations),
    }));
    const completionSatisfied = predicatesSatisfied(
      definition.completion.mode,
      definition.completion.when,
      observations,
    );
    const evaluation: LoopIterationEvaluation = {
      iteration: iterationNumber,
      evaluatedAt: input.iterations[index]!.evaluatedAt,
      assessedAt,
      sources: clone(input.iterations[index]!.sources),
      guardrails: guardrailEvaluations,
      decisions: decisionEvaluations,
      completionSatisfied,
      limitations: clone(limitations),
    };
    current = updated(
      current,
      { evaluations: [...current.evaluations, evaluation] },
      currentTimestamp(),
    );
    if (limitations.length > 0) {
      current = updated(
        current,
        {
          status: "insufficient_evidence",
          iteration: iterationNumber,
          limitations: [...current.limitations, ...limitations],
          stopReason: "insufficient_evidence",
          completedAt: currentTimestamp(),
        },
        currentTimestamp(),
      );
      persist(current);
      return current;
    }
    const breached = definition.guardrails.filter(
      ({ id }) => guardrailEvaluations.find((result) => result.id === id)?.breached,
    );
    if (breached.length > 0) {
      current = updated(
        current,
        {
          status: "stopped",
          iteration: iterationNumber,
          limitations: [
            ...current.limitations,
            ...breached.map(({ id }) => `Loop guardrail ${id} breached.`),
          ],
          stopReason: "guardrail_breach",
          completedAt: currentTimestamp(),
        },
        currentTimestamp(),
      );
      persist(current);
      return current;
    }

    const requiredAppliedRuleIds = definitionMayApply(definition)
      ? decisionEvaluations
          .filter(({ matched }) => matched)
          .map(({ ruleId }) => ruleId)
          .filter((ruleId) => {
            const rule = definition.decisionRules.find((candidate) => candidate.id === ruleId);
            return rule !== undefined && rule.action.effect !== "none";
          })
      : [];
    const requiredEffectsApplied = (): boolean =>
      requiredCompletionEffectsApplied(definition, evaluation, current.actions);
    if (completionSatisfied && requiredAppliedRuleIds.length > 0 && requiredEffectsApplied()) {
      const completedAt = currentTimestamp();
      current = updated(
        current,
        {
          status: "completed",
          iteration: iterationNumber,
          stopReason: "completed",
          completedAt,
        },
        completedAt,
      );
      persist(current);
      return current;
    }

    for (const rule of definition.decisionRules) {
      if (!decisionEvaluations.find(({ ruleId }) => ruleId === rule.id)?.matched) continue;
      if (rule.action.kind === "proposal" && usedSurfaces.has(rule.action.decisionSurface)) {
        const duplicate: LoopActionRecord = {
          iteration: iterationNumber,
          ruleId: rule.id,
          idempotencyKey: loopEffectIdempotencyKey({
            tenant: input.tenant,
            runId: input.runId,
            loopId: definition.id,
            ruleId: rule.id,
            iteration: iterationNumber,
          }),
          attemptToken: null,
          action: clone(rule.action),
          state: "rejected",
          reason: "one conceptual action is already active for this decision surface",
          evidence: null,
          proposalArtifact: null,
        };
        current = updated(
          current,
          { actions: [...current.actions, duplicate] },
          currentTimestamp(),
        );
        continue;
      }
      if (materialActions >= definition.maximumActions) {
        current = updated(
          current,
          {
            status: "stopped",
            iteration: iterationNumber,
            stopReason: "maximum_actions",
            completedAt: currentTimestamp(),
          },
          currentTimestamp(),
        );
        persist(current);
        return current;
      }
      const disposition = actionDisposition(definition, rule.action, authorizedEffects);
      const idempotencyKey = loopEffectIdempotencyKey({
        tenant: input.tenant,
        runId: input.runId,
        loopId: definition.id,
        ruleId: rule.id,
        iteration: iterationNumber,
      });
      let actionRecord: LoopActionRecord = {
        iteration: iterationNumber,
        ruleId: rule.id,
        idempotencyKey,
        attemptToken: disposition.apply ? ownerToken : null,
        action: clone(rule.action),
        state: disposition.state,
        reason: disposition.reason,
        evidence: null,
        proposalArtifact:
          disposition.state === "proposed"
            ? createProposalArtifact({
                definition,
                runId: input.runId,
                iteration: iterationNumber,
                rule,
                sources: input.iterations[index]!.sources,
                generatedAt: currentTimestamp(),
              })
            : null,
      };
      let shouldApply = disposition.apply;
      if (shouldApply) {
        const effectFreshness = observationMap(
          definition,
          input.iterations[index]!,
          currentTimestamp(),
          executionMode,
          input.tenant,
        ).limitations;
        if (effectFreshness.length > 0) {
          current = updated(
            current,
            {
              status: "insufficient_evidence",
              iteration: iterationNumber,
              limitations: [...current.limitations, ...effectFreshness],
              stopReason: "insufficient_evidence",
              completedAt: currentTimestamp(),
            },
            currentTimestamp(),
          );
          persist(current);
          return current;
        }
      }
      if (shouldApply && !(await isApplyAuthorized(effectRequest(current, actionRecord)))) {
        shouldApply = false;
        actionRecord = {
          ...actionRecord,
          attemptToken: null,
          state: "rejected",
          reason: "effect is outside the active verified run envelope",
        };
      }
      if (shouldApply) {
        const postAuthorizationFreshness = observationMap(
          definition,
          input.iterations[index]!,
          currentTimestamp(),
          executionMode,
          input.tenant,
        ).limitations;
        if (postAuthorizationFreshness.length > 0) {
          current = updated(
            current,
            {
              status: "insufficient_evidence",
              iteration: iterationNumber,
              limitations: [...current.limitations, ...postAuthorizationFreshness],
              stopReason: "insufficient_evidence",
              completedAt: currentTimestamp(),
            },
            currentTimestamp(),
          );
          persist(current);
          return current;
        }
      }
      current = updated(
        current,
        { iteration: iterationNumber, actions: [...current.actions, actionRecord] },
        currentTimestamp(),
      );
      if (actionRecord.state !== "rejected") {
        materialActions += 1;
        if (actionRecord.action.kind === "proposal")
          usedSurfaces.add(actionRecord.action.decisionSurface);
      }
      persist(current);
      if (actionRecord.state === "rejected") {
        current = updated(
          current,
          {
            status: "stopped",
            stopReason: "authorization_unavailable",
            limitations: [
              ...current.limitations,
              `Loop action ${rule.id} was not authorized and no effect was attempted.`,
            ],
            completedAt: currentTimestamp(),
          },
          currentTimestamp(),
        );
        persist(current);
        return current;
      }
      if (!shouldApply) continue;
      if (!options.executor)
        throw new Error("authorized loop effect requires an injected executor");
      const outcome = await options.executor.apply(effectRequest(current, actionRecord));
      assertOutcomeEvidence(
        outcome.state,
        outcome.evidence,
        executionMode,
        "loop effect evidence",
        actionRecord.action.effect,
        currentTimestamp(),
      );
      const state =
        outcome.state === "applied"
          ? "applied"
          : outcome.state === "confirmed_no_effect"
            ? "confirmed_no_effect"
            : "unknown";
      actionRecord = { ...actionRecord, state, evidence: outcome.evidence };
      current = updated(
        current,
        {
          actions: current.actions.map((candidate) =>
            candidate.idempotencyKey === idempotencyKey ? actionRecord : candidate,
          ),
        },
        currentTimestamp(),
      );
      if (state === "unknown") {
        current = updated(
          current,
          { status: "waiting_for_reconciliation", stopReason: "waiting_for_reconciliation" },
          currentTimestamp(),
        );
        persist(current);
        return current;
      }
      persist(current);
    }
    current = updated(current, { iteration: iterationNumber }, currentTimestamp());
    if (completionSatisfied && requiredEffectsApplied()) {
      const completedAt = currentTimestamp();
      current = updated(
        current,
        { status: "completed", stopReason: "completed", completedAt },
        completedAt,
      );
      persist(current);
      return current;
    }
    persist(current);
  }

  const completedAt = currentTimestamp();
  current = updated(
    current,
    {
      status: "stopped",
      stopReason: "completion_unsatisfied",
      limitations: [
        ...current.limitations,
        `Loop completion predicate was not satisfied: ${definition.completion.description}`,
      ],
      completedAt,
    },
    completedAt,
  );
  persist(current);
  return current;
}
