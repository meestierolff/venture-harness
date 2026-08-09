import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { CommandHandlerContext } from "@venture-harness/command-bus";
import type {
  StackCommandAction,
  StackCommandBoundaryResult,
  StackCommandInput,
  StackCommandRuntime,
  StackOperationInput,
  StackProfileCatalogEntry,
} from "@venture-harness/agent-runtime";
import type { JsonObject } from "@venture-harness/core";
import { Redactor } from "../credentials";
import { providerRegistry, type ProviderRegistry } from "./registry";
import {
  providerStackProfiles,
  resolveStackCapability,
  type ProviderStackProfile,
  type ResolvedStackCapability,
  type StackCapabilityRole,
} from "./stack-profiles";
import type {
  ProviderExecutionContext,
  ProviderExecutionReport,
  ProviderOperation,
  ProviderPlan,
  ProviderReadBackReport,
  ProviderReadBackResult,
  ProviderVerificationReport,
} from "./types";

export interface StackPreparedOperation {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly ventureId: string;
  readonly operationId: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly role: string;
  readonly providerId: string;
  readonly capability: string;
  readonly environment: string;
  readonly requestHash: string;
  readonly planHash: string;
  readonly plan: ProviderPlan;
  readonly preparedAt: string;
}

export interface StackOperationRecord {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly ventureId: string;
  readonly operationId: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly role: string;
  readonly providerId: string;
  readonly capability: string;
  readonly environment: string;
  readonly requestHash: string;
  readonly planHash: string;
  readonly report: ProviderExecutionReport;
  readonly readBack?: ProviderReadBackReport;
  readonly verification?: ProviderVerificationReport;
  readonly evidenceClass?: "fixture" | "live";
  readonly updatedAt: string;
}

export interface StackOperationStore {
  readonly durability: "fixture_only" | "durable_atomic";
  get(key: string): Promise<StackOperationRecord | null>;
  claim(
    key: string,
    input: {
      requestHash: string;
      ownerToken: string;
      now: string;
      prepared: StackPreparedOperation;
    },
  ): Promise<StackOperationClaim>;
  complete(
    key: string,
    input: { requestHash: string; ownerToken: string; record: StackOperationRecord },
  ): Promise<void>;
  update(key: string, input: { requestHash: string; record: StackOperationRecord }): Promise<void>;
  inspect(
    key: string,
    input: { requestHash: string; now: string },
  ): Promise<StackOperationInspection>;
  resolve(key: string, input: { requestHash: string; record: StackOperationRecord }): Promise<void>;
  release(key: string, input: { requestHash: string }): Promise<void>;
  markAmbiguous(
    key: string,
    input: { requestHash: string; ownerToken: string; ambiguousAt: string },
  ): Promise<void>;
}

export type StackOperationClaim =
  | { kind: "owner"; ownerToken: string }
  | { kind: "replay"; record: StackOperationRecord }
  | { kind: "conflict"; existingRequestHash: string }
  | { kind: "pending"; claimedAt: string; pendingExpiresAt: string }
  | { kind: "ambiguous"; ambiguousAt: string };

export type StackOperationInspection =
  | { kind: "missing" }
  | { kind: "conflict"; existingRequestHash: string }
  | { kind: "pending"; pendingExpiresAt: string; prepared: StackPreparedOperation }
  | { kind: "ambiguous"; ambiguousAt: string; prepared: StackPreparedOperation }
  | { kind: "completed"; record: StackOperationRecord; prepared: StackPreparedOperation };

export interface StackManualEvidenceRequest {
  readonly input: StackOperationInput;
  readonly operation: ProviderOperation;
  readonly readBack: ProviderReadBackResult;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly providerId: string;
  readonly capability: string;
  readonly evidenceClass: "fixture" | "live";
}

export interface RepositoryStackHostContext {
  readonly execution: ProviderExecutionContext;
  readonly credentialRefs?: readonly string[];
  readonly evidenceClass: "fixture" | "live";
  /** Manual adapters cannot self-prove their evidence; a trusted host must attest it. */
  readonly validateManualEvidence?: (
    request: StackManualEvidenceRequest,
  ) => Promise<boolean> | boolean;
}

export interface RepositoryStackContextRequest {
  readonly action: Exclude<StackCommandAction, "plan" | "dry_run">;
  readonly input: StackCommandInput;
  readonly resolved: ResolvedStackCapability;
  readonly plan: ProviderPlan | null;
  readonly invocation: CommandHandlerContext;
}

export interface RepositoryStackCommandRuntimeOptions {
  readonly profiles?: readonly ProviderStackProfile[];
  readonly registry?: ProviderRegistry;
  readonly operationStore?: StackOperationStore;
  readonly resolveContext: (
    request: RepositoryStackContextRequest,
  ) => Promise<RepositoryStackHostContext> | RepositoryStackHostContext;
  readonly now?: () => Date;
}

interface StoredStackOperationEntry {
  readonly state: "pending" | "completed" | "ambiguous";
  readonly requestHash: string;
  readonly ownerToken?: string;
  readonly claimedAt: string;
  readonly pendingExpiresAt: string;
  readonly ambiguousAt?: string;
  readonly prepared: StackPreparedOperation;
  readonly record?: StackOperationRecord;
}

const SECRET_KEY =
  /(?:authorization|api[-_]?key|secret|password|access[-_]?token|refresh[-_]?token)/iu;
const SECRET_VALUE =
  /(?:\bbearer\s+[a-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk|pk|atk)_(?:live|test)?_?[a-z0-9_-]{8,})/iu;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertNoSecrets(value: unknown, path = "value"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const reference = /(?:ref|reference)s?$/iu.test(key);
      if (SECRET_KEY.test(key) && !reference) {
        throw new Error(`secret-bearing field ${path}.${key} cannot enter Stack Profile state`);
      }
      assertNoSecrets(item, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && SECRET_VALUE.test(value)) {
    throw new Error(`credential-like value cannot enter Stack Profile state at ${path}`);
  }
}

export class InMemoryStackOperationStore implements StackOperationStore {
  readonly durability = "fixture_only" as const;
  readonly #entries = new Map<string, StoredStackOperationEntry>();
  readonly #pendingTimeoutMs = 5 * 60_000;

  async get(key: string): Promise<StackOperationRecord | null> {
    const entry = this.#entries.get(key);
    return entry?.state === "completed" ? cloneJson(entry.record!) : null;
  }

  async claim(
    key: string,
    input: {
      requestHash: string;
      ownerToken: string;
      now: string;
      prepared: StackPreparedOperation;
    },
  ): Promise<StackOperationClaim> {
    const existing = this.#entries.get(key);
    if (!existing) {
      this.#entries.set(key, {
        state: "pending",
        requestHash: input.requestHash,
        ownerToken: input.ownerToken,
        claimedAt: input.now,
        pendingExpiresAt: new Date(Date.parse(input.now) + this.#pendingTimeoutMs).toISOString(),
        prepared: cloneJson(input.prepared),
      });
      return { kind: "owner", ownerToken: input.ownerToken };
    }
    if (existing.requestHash !== input.requestHash) {
      return { kind: "conflict", existingRequestHash: existing.requestHash };
    }
    if (existing.state === "completed")
      return { kind: "replay", record: cloneJson(existing.record!) };
    if (existing.state === "ambiguous")
      return { kind: "ambiguous", ambiguousAt: existing.ambiguousAt! };
    return {
      kind: "pending",
      claimedAt: existing.claimedAt,
      pendingExpiresAt: existing.pendingExpiresAt,
    };
  }

  async complete(
    key: string,
    input: { requestHash: string; ownerToken: string; record: StackOperationRecord },
  ): Promise<void> {
    assertNoSecrets(input.record);
    const existing = this.#entries.get(key);
    if (
      !existing ||
      existing.state !== "pending" ||
      existing.requestHash !== input.requestHash ||
      existing.ownerToken !== input.ownerToken
    ) {
      throw new Error("Stack Profile completion does not own the request-bound claim");
    }
    this.#entries.set(key, {
      ...existing,
      state: "completed",
      ownerToken: undefined,
      record: cloneJson(input.record),
    });
  }

  async update(
    key: string,
    input: { requestHash: string; record: StackOperationRecord },
  ): Promise<void> {
    assertNoSecrets(input.record);
    const existing = this.#entries.get(key);
    if (!existing || existing.state !== "completed" || existing.requestHash !== input.requestHash) {
      throw new Error("Stack Profile update does not match a completed request-bound claim");
    }
    this.#entries.set(key, { ...existing, record: cloneJson(input.record) });
  }

  async inspect(
    key: string,
    input: { requestHash: string; now: string },
  ): Promise<StackOperationInspection> {
    const existing = this.#entries.get(key);
    if (!existing) return { kind: "missing" };
    if (existing.requestHash !== input.requestHash) {
      return { kind: "conflict", existingRequestHash: existing.requestHash };
    }
    if (
      existing.state === "pending" &&
      Date.parse(input.now) >= Date.parse(existing.pendingExpiresAt)
    ) {
      const ambiguous = { ...existing, state: "ambiguous" as const, ambiguousAt: input.now };
      this.#entries.set(key, ambiguous);
      return {
        kind: "ambiguous",
        ambiguousAt: input.now,
        prepared: cloneJson(existing.prepared),
      };
    }
    if (existing.state === "pending") {
      return {
        kind: "pending",
        pendingExpiresAt: existing.pendingExpiresAt,
        prepared: cloneJson(existing.prepared),
      };
    }
    if (existing.state === "ambiguous") {
      return {
        kind: "ambiguous",
        ambiguousAt: existing.ambiguousAt!,
        prepared: cloneJson(existing.prepared),
      };
    }
    return {
      kind: "completed",
      record: cloneJson(existing.record!),
      prepared: cloneJson(existing.prepared),
    };
  }

  async resolve(
    key: string,
    input: { requestHash: string; record: StackOperationRecord },
  ): Promise<void> {
    const existing = this.#entries.get(key);
    if (
      !existing ||
      !["pending", "ambiguous"].includes(existing.state) ||
      existing.requestHash !== input.requestHash
    ) {
      throw new Error("Stack Profile resolution does not match an unresolved request");
    }
    this.#entries.set(key, {
      ...existing,
      state: "completed",
      ownerToken: undefined,
      record: cloneJson(input.record),
    });
  }

  async release(key: string, input: { requestHash: string }): Promise<void> {
    const existing = this.#entries.get(key);
    if (
      !existing ||
      !["pending", "ambiguous"].includes(existing.state) ||
      existing.requestHash !== input.requestHash
    ) {
      throw new Error("Stack Profile release does not match an unresolved request");
    }
    this.#entries.delete(key);
  }

  async markAmbiguous(
    key: string,
    input: { requestHash: string; ownerToken: string; ambiguousAt: string },
  ): Promise<void> {
    const existing = this.#entries.get(key);
    if (
      !existing ||
      existing.state !== "pending" ||
      existing.requestHash !== input.requestHash ||
      existing.ownerToken !== input.ownerToken
    ) {
      throw new Error("Stack Profile ambiguity does not own the request-bound claim");
    }
    this.#entries.set(key, {
      ...existing,
      state: "ambiguous",
      ownerToken: undefined,
      ambiguousAt: input.ambiguousAt,
    });
  }
}

interface StackOperationRow {
  request_hash: string;
  state: "pending" | "completed" | "ambiguous";
  owner_token: string | null;
  claimed_at: string;
  pending_expires_at: string;
  ambiguous_at: string | null;
  prepared_json: string;
  record_json: string | null;
}

interface SqliteStatement {
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function openStackDatabase(path: string): SqliteDatabase {
  const moduleLocation = typeof __filename === "string" ? __filename : import.meta.url;
  const { DatabaseSync } = createRequire(moduleLocation)("node:sqlite") as {
    DatabaseSync: new (filename: string) => SqliteDatabase;
  };
  return new DatabaseSync(path);
}

/** Cross-process request claims and crash recovery use SQLite BEGIN IMMEDIATE. */
export class SqliteStackOperationStore implements StackOperationStore {
  readonly durability = "durable_atomic" as const;
  readonly #database: SqliteDatabase;
  readonly #pendingTimeoutMs: number;

  constructor(
    private readonly path: string,
    options: { pendingTimeoutMs?: number } = {},
  ) {
    this.#pendingTimeoutMs = options.pendingTimeoutMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.#pendingTimeoutMs) || this.#pendingTimeoutMs < 1) {
      throw new Error("pendingTimeoutMs must be a positive safe integer");
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.#database = openStackDatabase(this.path);
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS stack_operations (
        ledger_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'ambiguous')),
        owner_token TEXT,
        claimed_at TEXT NOT NULL,
        pending_expires_at TEXT NOT NULL,
        ambiguous_at TEXT,
        prepared_json TEXT NOT NULL,
        record_json TEXT,
        CHECK (
          (state = 'pending' AND owner_token IS NOT NULL AND ambiguous_at IS NULL AND record_json IS NULL)
          OR (state = 'completed' AND owner_token IS NULL AND ambiguous_at IS NULL AND record_json IS NOT NULL)
          OR (state = 'ambiguous' AND owner_token IS NULL AND ambiguous_at IS NOT NULL AND record_json IS NULL)
        )
      )
    `);
    chmodSync(this.path, 0o600);
  }

  async get(key: string): Promise<StackOperationRecord | null> {
    const row = this.#read(key);
    return row?.state === "completed" ? this.#record(row) : null;
  }

  async claim(
    key: string,
    input: {
      requestHash: string;
      ownerToken: string;
      now: string;
      prepared: StackPreparedOperation;
    },
  ): Promise<StackOperationClaim> {
    assertNoSecrets(input.prepared);
    return this.#transaction(() => {
      const existing = this.#read(key);
      const preparedJson = stableJson(input.prepared);
      if (!existing) {
        const pendingExpiresAt = new Date(
          Date.parse(input.now) + this.#pendingTimeoutMs,
        ).toISOString();
        this.#database
          .prepare(
            `INSERT INTO stack_operations
              (ledger_key, request_hash, state, owner_token, claimed_at,
               pending_expires_at, prepared_json)
             VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
          )
          .run(
            sha256(key),
            input.requestHash,
            input.ownerToken,
            input.now,
            pendingExpiresAt,
            preparedJson,
          );
        return { kind: "owner", ownerToken: input.ownerToken };
      }
      if (existing.request_hash !== input.requestHash) {
        return { kind: "conflict", existingRequestHash: existing.request_hash };
      }
      if (existing.state === "completed") return { kind: "replay", record: this.#record(existing) };
      if (existing.state === "ambiguous") {
        return { kind: "ambiguous", ambiguousAt: existing.ambiguous_at! };
      }
      if (Date.parse(input.now) >= Date.parse(existing.pending_expires_at)) {
        this.#markExpired(key, input.now);
        return { kind: "ambiguous", ambiguousAt: input.now };
      }
      return {
        kind: "pending",
        claimedAt: existing.claimed_at,
        pendingExpiresAt: existing.pending_expires_at,
      };
    });
  }

  async complete(
    key: string,
    input: { requestHash: string; ownerToken: string; record: StackOperationRecord },
  ): Promise<void> {
    await this.#transaction(() => {
      const existing = this.#read(key);
      if (
        !existing ||
        existing.state !== "pending" ||
        existing.request_hash !== input.requestHash ||
        existing.owner_token !== input.ownerToken
      ) {
        throw new Error("Stack Profile completion does not own the request-bound claim");
      }
      this.#complete(key, input.record);
    });
  }

  async update(
    key: string,
    input: { requestHash: string; record: StackOperationRecord },
  ): Promise<void> {
    await this.#transaction(() => {
      const existing = this.#read(key);
      if (
        !existing ||
        existing.state !== "completed" ||
        existing.request_hash !== input.requestHash
      ) {
        throw new Error("Stack Profile update does not match a completed request-bound claim");
      }
      this.#complete(key, input.record);
    });
  }

  async inspect(
    key: string,
    input: { requestHash: string; now: string },
  ): Promise<StackOperationInspection> {
    return this.#transaction(() => {
      let existing = this.#read(key);
      if (!existing) return { kind: "missing" };
      if (existing.request_hash !== input.requestHash) {
        return { kind: "conflict", existingRequestHash: existing.request_hash };
      }
      if (
        existing.state === "pending" &&
        Date.parse(input.now) >= Date.parse(existing.pending_expires_at)
      ) {
        this.#markExpired(key, input.now);
        existing = this.#read(key)!;
      }
      const prepared = this.#prepared(existing);
      if (existing.state === "pending") {
        return { kind: "pending", pendingExpiresAt: existing.pending_expires_at, prepared };
      }
      if (existing.state === "ambiguous") {
        return { kind: "ambiguous", ambiguousAt: existing.ambiguous_at!, prepared };
      }
      return { kind: "completed", record: this.#record(existing), prepared };
    });
  }

  async resolve(
    key: string,
    input: { requestHash: string; record: StackOperationRecord },
  ): Promise<void> {
    await this.#transaction(() => {
      const existing = this.#read(key);
      if (
        !existing ||
        !["pending", "ambiguous"].includes(existing.state) ||
        existing.request_hash !== input.requestHash
      ) {
        throw new Error("Stack Profile resolution does not match an unresolved request");
      }
      this.#complete(key, input.record);
    });
  }

  async release(key: string, input: { requestHash: string }): Promise<void> {
    await this.#transaction(() => {
      const existing = this.#read(key);
      if (
        !existing ||
        !["pending", "ambiguous"].includes(existing.state) ||
        existing.request_hash !== input.requestHash
      ) {
        throw new Error("Stack Profile release does not match an unresolved request");
      }
      this.#database.prepare("DELETE FROM stack_operations WHERE ledger_key = ?").run(sha256(key));
    });
  }

  async markAmbiguous(
    key: string,
    input: { requestHash: string; ownerToken: string; ambiguousAt: string },
  ): Promise<void> {
    await this.#transaction(() => {
      const existing = this.#read(key);
      if (
        !existing ||
        existing.state !== "pending" ||
        existing.request_hash !== input.requestHash ||
        existing.owner_token !== input.ownerToken
      ) {
        throw new Error("Stack Profile ambiguity does not own the request-bound claim");
      }
      this.#markExpired(key, input.ambiguousAt);
    });
  }

  close(): void {
    this.#database.close();
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
  }

  #read(key: string): StackOperationRow | undefined {
    return this.#database
      .prepare(
        `SELECT request_hash, state, owner_token, claimed_at, pending_expires_at,
                ambiguous_at, prepared_json, record_json
           FROM stack_operations WHERE ledger_key = ?`,
      )
      .get(sha256(key)) as StackOperationRow | undefined;
  }

  #prepared(row: StackOperationRow): StackPreparedOperation {
    const prepared = JSON.parse(row.prepared_json) as StackPreparedOperation;
    assertNoSecrets(prepared);
    return prepared;
  }

  #record(row: StackOperationRow): StackOperationRecord {
    if (!row.record_json) throw new Error("Completed Stack Profile operation has no record");
    const record = JSON.parse(row.record_json) as StackOperationRecord;
    assertNoSecrets(record);
    return record;
  }

  #complete(key: string, record: StackOperationRecord): void {
    assertNoSecrets(record);
    this.#database
      .prepare(
        `UPDATE stack_operations
            SET state = 'completed', owner_token = NULL, ambiguous_at = NULL, record_json = ?
          WHERE ledger_key = ?`,
      )
      .run(stableJson(record), sha256(key));
  }

  #markExpired(key: string, ambiguousAt: string): void {
    this.#database
      .prepare(
        `UPDATE stack_operations
            SET state = 'ambiguous', owner_token = NULL, ambiguous_at = ?
          WHERE ledger_key = ?`,
      )
      .run(ambiguousAt, sha256(key));
  }
}

/** Compatibility name; persistence is transactional SQLite, not a JSON file. */
export class FileStackOperationStore extends SqliteStackOperationStore {}

function operationInput(input: StackCommandInput): StackOperationInput {
  if (!("operationId" in input) || !("payload" in input)) {
    throw new Error("Stack Profile operation input is required");
  }
  return input as StackOperationInput;
}

function providerPlanHash(plan: ProviderPlan): string {
  return sha256({
    provider: plan.provider,
    environment: plan.environment,
    dryRun: plan.dryRun,
    operations: plan.operations,
    limitations: plan.limitations,
  });
}

function requestHash(input: StackOperationInput, plan: ProviderPlan): string {
  return sha256({
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    role: input.role,
    providerId: input.providerId,
    capability: input.capability,
    environment: input.environment,
    operationId: input.operationId,
    payload: input.payload,
    planHash: providerPlanHash(plan),
  });
}

function operationStoreKey(input: StackOperationInput, invocation: CommandHandlerContext): string {
  return stableJson({
    organizationId: invocation.context.tenant.organizationId,
    ventureId: invocation.context.tenant.ventureId,
    operationId: input.operationId,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    role: input.role,
  });
}

function preparedFor(
  input: StackOperationInput,
  invocation: CommandHandlerContext,
  plan: ProviderPlan,
  preparedAt: string,
): StackPreparedOperation {
  return {
    schemaVersion: 1,
    organizationId: invocation.context.tenant.organizationId,
    ventureId: invocation.context.tenant.ventureId,
    operationId: input.operationId,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    role: input.role,
    providerId: input.providerId,
    capability: input.capability,
    environment: input.environment,
    requestHash: requestHash(input, plan),
    planHash: providerPlanHash(plan),
    plan: cloneJson(plan),
    preparedAt,
  };
}

function assertPreparedBinding(
  prepared: StackPreparedOperation,
  input: StackOperationInput,
  invocation: CommandHandlerContext,
  plan: ProviderPlan,
): void {
  const expected = preparedFor(input, invocation, plan, prepared.preparedAt);
  if (
    prepared.schemaVersion !== 1 ||
    prepared.organizationId !== expected.organizationId ||
    prepared.ventureId !== expected.ventureId ||
    prepared.operationId !== expected.operationId ||
    prepared.profileId !== expected.profileId ||
    prepared.profileVersion !== expected.profileVersion ||
    prepared.role !== expected.role ||
    prepared.providerId !== expected.providerId ||
    prepared.capability !== expected.capability ||
    prepared.environment !== expected.environment ||
    prepared.requestHash !== expected.requestHash ||
    prepared.planHash !== expected.planHash ||
    providerPlanHash(prepared.plan) !== expected.planHash
  ) {
    throw new Error("Prepared Stack Profile claim failed its tenant, profile, or plan attestation");
  }
}

function assertPlanBinding(resolved: ResolvedStackCapability, plan: ProviderPlan): void {
  if (
    plan.provider !== resolved.providerId ||
    plan.operations.length === 0 ||
    plan.operations.some(
      (operation) =>
        operation.provider !== resolved.providerId ||
        operation.capability !== resolved.capability ||
        operation.environment !== plan.environment,
    )
  ) {
    throw new Error("Provider plan does not match the exact Stack Profile binding");
  }
}

function assertReportBinding(
  record: StackOperationRecord,
  input: StackOperationInput,
  invocation: CommandHandlerContext,
  plan: ProviderPlan,
): void {
  const tenant = invocation.context.tenant;
  const expectedRequestHash = requestHash(input, plan);
  if (
    record.organizationId !== tenant.organizationId ||
    record.ventureId !== tenant.ventureId ||
    record.operationId !== input.operationId ||
    record.profileId !== input.profileId ||
    record.profileVersion !== input.profileVersion ||
    record.role !== input.role ||
    record.providerId !== input.providerId ||
    record.capability !== input.capability ||
    record.environment !== input.environment ||
    record.requestHash !== expectedRequestHash ||
    record.planHash !== providerPlanHash(plan) ||
    record.report.planId !== plan.id ||
    record.report.provider !== plan.provider ||
    stableJson(record.report.operations.map(({ operation }) => operation)) !==
      stableJson(plan.operations)
  ) {
    throw new Error("Stored provider report failed its Stack Profile and request attestation");
  }
}

function assertReadBackBinding(
  report: ProviderExecutionReport,
  readBack: ProviderReadBackReport,
): void {
  const expected = report.operations.map(({ operation }) => operation.id).sort();
  const observed = readBack.results.map(({ operationId }) => operationId).sort();
  if (
    readBack.planId !== report.planId ||
    readBack.provider !== report.provider ||
    stableJson(observed) !== stableJson(expected) ||
    new Set(observed).size !== observed.length
  ) {
    throw new Error("Provider read-back did not attest every exact planned operation once");
  }
}

function selectedProfile(
  profiles: readonly ProviderStackProfile[],
  input: StackCommandInput,
): ProviderStackProfile {
  const matches = profiles.filter(({ profileId }) => profileId === input.profileId);
  if (matches.length !== 1)
    throw new Error(`Unknown or duplicate Stack Profile ${input.profileId}`);
  const profile = matches[0]!;
  if (profile.version !== input.profileVersion) {
    throw new Error(
      `Stack Profile ${input.profileId} version mismatch: expected ${profile.version}`,
    );
  }
  return profile;
}

function resolvedSelection(
  profiles: readonly ProviderStackProfile[],
  registry: ProviderRegistry,
  input: StackCommandInput,
): ResolvedStackCapability {
  const profile = selectedProfile(profiles, input);
  const resolved = resolveStackCapability(profile, input.role as StackCapabilityRole, registry);
  if (resolved.providerId !== input.providerId || resolved.capability !== input.capability) {
    throw new Error(
      "Provider and capability attestation does not match the selected Stack Profile",
    );
  }
  if (!resolved.adapter.descriptor.environments.includes(input.environment)) {
    throw new Error(`${resolved.providerId} does not support ${input.environment}`);
  }
  return resolved;
}

function buildPlan(
  resolved: ResolvedStackCapability,
  input: StackOperationInput,
  dryRun: boolean,
): ProviderPlan {
  const plan = resolved.adapter.plan({
    environment: input.environment,
    capabilities: [resolved.capability],
    inputs: input.payload,
    dryRun,
  });
  assertPlanBinding(resolved, plan);
  return plan;
}

function planData(plan: ProviderPlan): JsonObject {
  return cloneJson({
    planId: plan.id,
    provider: plan.provider,
    environment: plan.environment,
    dryRun: plan.dryRun,
    operations: plan.operations,
    limitations: plan.limitations,
    manualActions: plan.operations
      .filter(({ manual }) => manual !== undefined)
      .map(({ id, action, manual, verification }) => ({
        operationId: id,
        action,
        system: manual!.system,
        instructions: manual!.instructions,
        requiredFields: manual!.requiredFields,
        completionEvidence: manual!.completionEvidence,
        verification: verification.description,
      })),
  }) as unknown as JsonObject;
}

function providerInvocation(report: ProviderExecutionReport): boolean | "unknown" {
  if (report.state === "planned") return false;
  if (report.operations.every(({ result }) => result.status === "waiting_manual")) return false;
  if (
    report.operations.every(
      ({ result }) => result.status === "skipped" || result.effectOutcome === "confirmed_no_write",
    )
  ) {
    return false;
  }
  return report.operations.some(({ result }) => result.status === "succeeded") ? true : "unknown";
}

function externalEffect(report: ProviderExecutionReport): boolean | "unknown" {
  if (report.operations.some(({ result }) => result.effectOutcome === "confirmed_write")) {
    return true;
  }
  if (report.operations.some(({ result }) => result.effectOutcome === "unknown")) return "unknown";
  return false;
}

async function assertManualEvidence(
  host: RepositoryStackHostContext,
  input: StackOperationInput,
  plan: ProviderPlan,
  readBack: ProviderReadBackReport,
): Promise<boolean> {
  const manual = plan.operations.filter(({ verification }) => verification.strategy === "manual");
  if (manual.length === 0) return true;
  if (!host.validateManualEvidence) return false;
  for (const operation of manual) {
    const result = readBack.results.find(({ operationId }) => operationId === operation.id)!;
    if (
      result.status !== "matched" ||
      !(await host.validateManualEvidence({
        input,
        operation,
        readBack: result,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        providerId: input.providerId,
        capability: input.capability,
        evidenceClass: host.evidenceClass,
      }))
    ) {
      return false;
    }
  }
  return true;
}

function durableContext(host: RepositoryStackHostContext, store: StackOperationStore): void {
  if (store.durability !== "durable_atomic") {
    throw new Error("Stack Profile apply requires a durable atomic operation store");
  }
  if (host.execution.idempotencyLedger?.durability !== "durable_atomic") {
    throw new Error("Stack Profile apply requires a durable atomic provider idempotency ledger");
  }
}

function recordFor(
  input: StackOperationInput,
  invocation: CommandHandlerContext,
  plan: ProviderPlan,
  report: ProviderExecutionReport,
  now: () => Date,
  details: {
    readBack?: ProviderReadBackReport;
    verification?: ProviderVerificationReport;
    evidenceClass?: "fixture" | "live";
  } = {},
): StackOperationRecord {
  const tenant = invocation.context.tenant;
  return {
    schemaVersion: 1,
    organizationId: tenant.organizationId,
    ventureId: tenant.ventureId,
    operationId: input.operationId,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    role: input.role,
    providerId: input.providerId,
    capability: input.capability,
    environment: input.environment,
    requestHash: requestHash(input, plan),
    planHash: providerPlanHash(plan),
    report: cloneJson(report),
    readBack: details.readBack ? cloneJson(details.readBack) : undefined,
    verification: details.verification ? cloneJson(details.verification) : undefined,
    evidenceClass: details.evidenceClass,
    updatedAt: now().toISOString(),
  };
}

function catalog(profiles: readonly ProviderStackProfile[]): readonly StackProfileCatalogEntry[] {
  return profiles.map((profile) => ({
    profileId: profile.profileId,
    profileVersion: profile.version,
    label: profile.label,
    verification: profile.verification,
    implementationConfigured: true,
    credentialState: "host_managed",
    liveVerification: "pending",
    providerEffectsConfigured: false,
    bindings: Object.fromEntries(
      Object.entries(profile.bindings).map(([role, binding]) => [
        role,
        { providerId: binding.providerId, capability: binding.capability },
      ]),
    ),
  }));
}

function failure(
  status: string,
  code: string,
  message: string,
  nextAction: string,
  providerInvoked: boolean | "unknown" = false,
): StackCommandBoundaryResult {
  return {
    status,
    providerInvoked,
    externalEffectOccurred: providerInvoked === "unknown" ? "unknown" : false,
    liveVerified: false,
    data: { diagnostic: { code, message, nextAction } },
  };
}

export function createRepositoryStackCommandRuntime(
  options: RepositoryStackCommandRuntimeOptions,
): StackCommandRuntime {
  const profiles = options.profiles ?? providerStackProfiles;
  const registry = options.registry ?? providerRegistry;
  const store = options.operationStore ?? new InMemoryStackOperationStore();
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    catalog: Object.freeze(catalog(profiles)),
    async execute(
      action: StackCommandAction,
      commandInput: StackCommandInput,
      invocation: CommandHandlerContext,
    ): Promise<StackCommandBoundaryResult> {
      const resolved = resolvedSelection(profiles, registry, commandInput);

      if (action === "doctor") {
        const host = await options.resolveContext({
          action,
          input: commandInput,
          resolved,
          plan: null,
          invocation,
        });
        const doctor = await resolved.adapter.doctor(
          {
            credentialRefs: host.credentialRefs,
            requiredCapabilities: [resolved.capability],
          },
          { ...host.execution, authorization: "dry_run" },
        );
        if (doctor.provider !== resolved.providerId) {
          throw new Error("Provider doctor returned evidence for the wrong adapter");
        }
        return {
          status: doctor.status,
          providerInvoked: resolved.adapter.descriptor.transports.every(
            (transport) => transport === "manual",
          )
            ? false
            : "unknown",
          externalEffectOccurred: false,
          liveVerified: false,
          data: {
            binding: {
              profileId: resolved.profileId,
              profileVersion: resolved.profileVersion,
              role: resolved.role,
              providerId: resolved.providerId,
              capability: resolved.capability,
            },
            doctor: cloneJson(doctor) as unknown as JsonObject,
          },
        };
      }

      const input = operationInput(commandInput);
      if (action === "plan") {
        const plan = buildPlan(resolved, input, true);
        return {
          status: "planned",
          providerInvoked: false,
          externalEffectOccurred: false,
          liveVerified: false,
          data: { plan: planData(plan), requestHash: requestHash(input, plan) },
        };
      }

      if (action === "dry_run") {
        const plan = buildPlan(resolved, input, true);
        const report = await resolved.adapter.apply(plan, {
          authorization: "dry_run",
          transports: {},
          redactor: new Redactor(),
        });
        return {
          status: report.state,
          providerInvoked: false,
          externalEffectOccurred: false,
          liveVerified: false,
          data: { plan: planData(plan), report: cloneJson(report) as unknown as JsonObject },
        };
      }

      const plan = buildPlan(resolved, input, false);
      const key = operationStoreKey(input, invocation);

      if (action === "apply") {
        const host = await options.resolveContext({
          action,
          input,
          resolved,
          plan,
          invocation,
        });
        durableContext(host, store);
        if (host.execution.authorization !== "approved") {
          return failure(
            "authorization_required",
            "provider_authorization_required",
            "The trusted provider context did not authorize apply",
            "Supply an exact active grant through the host context",
          );
        }
        const boundRequestHash = requestHash(input, plan);
        const ownerToken = randomUUID();
        const claim = await store.claim(key, {
          requestHash: boundRequestHash,
          ownerToken,
          now: now().toISOString(),
          prepared: preparedFor(input, invocation, plan, now().toISOString()),
        });
        if (claim.kind === "conflict") {
          return failure(
            "idempotency_conflict",
            "stack_operation_conflict",
            "The Stack Profile operation ID is bound to a different canonical request",
            "Use the original request or a new operation ID after fresh authorization",
          );
        }
        if (claim.kind === "pending") {
          return failure(
            "idempotency_pending",
            "stack_operation_pending",
            "The exact Stack Profile operation is already executing",
            `Retry read-back after ${claim.pendingExpiresAt}`,
          );
        }
        if (claim.kind === "ambiguous") {
          return failure(
            "idempotency_ambiguous",
            "stack_operation_ambiguous",
            "The exact Stack Profile operation has an ambiguous prior outcome",
            "Reconcile the provider ledger before any new apply",
            "unknown",
          );
        }
        if (claim.kind === "replay") {
          assertReportBinding(claim.record, input, invocation, plan);
          return {
            status:
              claim.record.report.state === "applied"
                ? "applied_unverified"
                : claim.record.report.state,
            providerInvoked: false,
            externalEffectOccurred: externalEffect(claim.record.report),
            liveVerified: false,
            data: {
              plan: planData(plan),
              report: cloneJson(claim.record.report) as unknown as JsonObject,
              replayed: true,
            },
          };
        }
        let report: ProviderExecutionReport;
        try {
          report = await resolved.adapter.apply(plan, host.execution);
          await store.complete(key, {
            requestHash: boundRequestHash,
            ownerToken: claim.ownerToken,
            record: recordFor(input, invocation, plan, report, now),
          });
        } catch (error) {
          await store
            .markAmbiguous(key, {
              requestHash: boundRequestHash,
              ownerToken: claim.ownerToken,
              ambiguousAt: now().toISOString(),
            })
            .catch(() => undefined);
          throw error;
        }
        return {
          status: report.state === "applied" ? "applied_unverified" : report.state,
          providerInvoked: providerInvocation(report),
          externalEffectOccurred: externalEffect(report),
          liveVerified: false,
          data: { plan: planData(plan), report: cloneJson(report) as unknown as JsonObject },
        };
      }

      const boundRequestHash = requestHash(input, plan);
      const inspection = await store.inspect(key, {
        requestHash: boundRequestHash,
        now: now().toISOString(),
      });
      if (inspection.kind === "missing") {
        return failure(
          "operation_not_found",
          "durable_operation_missing",
          "No durable apply record exists for this exact Stack Profile request",
          "Run an authorized apply or restore the attested operation state",
        );
      }
      if (inspection.kind === "conflict") {
        return failure(
          "idempotency_conflict",
          "stack_operation_conflict",
          "The Stack Profile operation ID is bound to a different canonical request",
          "Use the original request or a new operation ID after fresh authorization",
        );
      }
      assertPreparedBinding(inspection.prepared, input, invocation, plan);
      if (inspection.kind === "pending") {
        return failure(
          "idempotency_pending",
          "stack_operation_pending",
          "The exact Stack Profile operation may still be executing",
          `Retry reconciliation after ${inspection.pendingExpiresAt}`,
        );
      }
      if (inspection.kind === "ambiguous" && action === "read_back") {
        return failure(
          "reconciliation_required",
          "stack_operation_ambiguous",
          "The prepared Stack Profile operation has no trusted completion report",
          "Run stack.reconcile with the exact original request",
          "unknown",
        );
      }
      const host = await options.resolveContext({
        action,
        input,
        resolved,
        plan,
        invocation,
      });
      durableContext(host, store);

      const unresolved = inspection.kind === "ambiguous";
      let report = inspection.kind === "completed" ? inspection.record.report : undefined;
      if (inspection.kind === "completed") {
        assertReportBinding(inspection.record, input, invocation, plan);
      }
      if (action === "reconcile") {
        const prior = await Promise.all(
          plan.operations.map(({ idempotencyKey }) =>
            host.execution.idempotencyLedger!.get(idempotencyKey),
          ),
        );
        if (prior.some((result) => result === null)) {
          if (unresolved) {
            await store.release(key, { requestHash: boundRequestHash });
            return failure(
              "confirmed_no_effect",
              "provider_attempt_absent",
              "The expired prepared claim never reached the durable provider ledger",
              "A newly authorized apply may reuse this operation ID",
            );
          }
          return failure(
            "reconciliation_blocked",
            "provider_ledger_record_missing",
            "The durable provider ledger has no prior attempt for this exact plan",
            "Restore the provider ledger; reconciliation cannot initiate a new write",
          );
        }
        if (prior.some((result) => result?.effectOutcome === "confirmed_no_write")) {
          if (unresolved) await store.release(key, { requestHash: boundRequestHash });
          return failure(
            "confirmed_no_effect",
            "provider_confirmed_no_write",
            "Provider evidence confirms the prior attempt did not create an effect",
            "Create a newly authorized apply with a new command idempotency key",
          );
        }
        report = await resolved.adapter.apply(plan, host.execution);
        const outcome = externalEffect(report);
        if (outcome === "unknown") {
          return failure(
            "reconciliation_ambiguous",
            "provider_outcome_unknown",
            "Provider reconciliation did not prove either a write or no write",
            "Retry read-only reconciliation; never repeat apply",
            "unknown",
          );
        }
        if (outcome === false) {
          if (unresolved) await store.release(key, { requestHash: boundRequestHash });
          return failure(
            "confirmed_no_effect",
            "provider_confirmed_no_write",
            "Provider reconciliation confirmed that no effect occurred",
            "A newly authorized apply may reuse this operation ID",
          );
        }
      }

      if (!report) throw new Error("Stack Profile reconciliation produced no execution report");

      const readBack = await resolved.adapter.readBack(report, {
        ...host.execution,
        authorization: "dry_run",
      });
      assertReadBackBinding(report, readBack);
      const manualEvidenceValid = await assertManualEvidence(host, input, plan, readBack);
      if (!manualEvidenceValid) {
        const record = recordFor(input, invocation, plan, report, now, {
          readBack,
          evidenceClass: host.evidenceClass,
        });
        await (unresolved
          ? store.resolve(key, { requestHash: boundRequestHash, record })
          : store.update(key, { requestHash: boundRequestHash, record }));
        return {
          status: "waiting_manual_evidence",
          providerInvoked: action === "reconcile" ? providerInvocation(report) : false,
          externalEffectOccurred: externalEffect(report),
          liveVerified: false,
          data: {
            plan: planData(plan),
            readBack: cloneJson(readBack) as unknown as JsonObject,
            diagnostic: {
              code: "manual_evidence_required",
              message: "Manual provider completion lacks exact trusted evidence",
              nextAction: "Supply the declared manual evidence through a trusted host verifier",
            },
          },
        };
      }
      const verification = resolved.adapter.verify(report, readBack);
      if (
        verification.planId !== plan.id ||
        verification.provider !== resolved.providerId ||
        stableJson(verification.checks) !== stableJson(readBack.results)
      ) {
        throw new Error("Provider verification does not match the exact read-back report");
      }
      const verifiedRecord = recordFor(input, invocation, plan, report, now, {
        readBack,
        verification,
        evidenceClass: host.evidenceClass,
      });
      await (unresolved
        ? store.resolve(key, { requestHash: boundRequestHash, record: verifiedRecord })
        : store.update(key, { requestHash: boundRequestHash, record: verifiedRecord }));
      const verified = verification.state === "verified";
      return {
        status: verified
          ? host.evidenceClass === "live"
            ? "verified_live"
            : "verified_fixture"
          : verification.state,
        providerInvoked: action === "reconcile" ? providerInvocation(report) : false,
        externalEffectOccurred: externalEffect(report),
        liveVerified: verified && host.evidenceClass === "live",
        data: {
          plan: planData(plan),
          readBack: cloneJson(readBack) as unknown as JsonObject,
          verification: cloneJson(verification) as unknown as JsonObject,
          evidenceClass: host.evidenceClass,
        },
      };
    },
  });
}
