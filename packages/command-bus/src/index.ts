import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { AuditSink } from "@venture-harness/audit";
import type { RuntimeSchema } from "@venture-harness/config";
import {
  canonicalCommandId,
  initializeSqliteWal,
  stableJson,
  tenantKey,
  type CommandExecutionContext,
  type JsonObject,
  type JsonValue,
  type TenantRef,
} from "@venture-harness/core";
import type { EventSink } from "@venture-harness/events";

export interface CommandSurfaceNames {
  rest: { method: "POST"; path: string; operationId: string };
  cli: { tokens: readonly [string, string] };
  mcp: { tool: string };
  sdk: { namespace: string; method: string };
  ui: { actionId: string; label: string };
}

export interface CommandRequirements {
  activeSubscription: boolean;
  entitlements: readonly string[];
  grant: boolean;
  scopes: readonly string[];
}

export interface CommandContract<Input extends JsonValue, Output extends JsonValue> {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly input: RuntimeSchema<Input>;
  readonly output: RuntimeSchema<Output>;
  readonly requirements: CommandRequirements;
  readonly effect: "read" | "write";
  readonly meter?: string;
  readonly surfaces: CommandSurfaceNames;
}

export type AnyCommandContract = CommandContract<JsonValue, JsonValue>;

function upperCamel(parts: readonly string[]): string {
  return parts.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join("");
}

export function deriveCommandSurfaces(commandId: string, title: string): CommandSurfaceNames {
  const id = canonicalCommandId(commandId);
  const [namespace, method, ...rest] = id.split(".");
  if (!namespace || !method || rest.length)
    throw new Error(`Command ids must contain one namespace and method: ${id}`);
  const surfaces: CommandSurfaceNames = {
    rest: {
      method: "POST",
      path: `/v1/commands/${id}`,
      operationId: `${namespace}${upperCamel([method])}`,
    },
    cli: { tokens: [namespace, method] as const },
    mcp: { tool: `${namespace}_${method.replaceAll("-", "_")}` },
    sdk: { namespace, method },
    ui: { actionId: id, label: title },
  };
  return Object.freeze(surfaces);
}

export function defineCommandContract<Input extends JsonValue, Output extends JsonValue>(
  definition: Omit<CommandContract<Input, Output>, "id" | "surfaces" | "effect"> & {
    id: string;
    effect?: "read" | "write";
  },
): CommandContract<Input, Output> {
  const id = canonicalCommandId(definition.id);
  if (!Number.isInteger(definition.version) || definition.version < 1)
    throw new Error("command version must be positive");
  return Object.freeze({
    ...definition,
    id,
    effect: definition.effect ?? "write",
    surfaces: deriveCommandSurfaces(id, definition.title),
  });
}

export interface CommandInvocationOptions {
  context: CommandExecutionContext;
  idempotencyKey: string;
}

export interface CommandHandlerContext extends CommandInvocationOptions {
  commandId: string;
  occurredAt: string;
}

export type CommandHandler<Input extends JsonValue, Output extends JsonValue> = (
  input: Input,
  context: CommandHandlerContext,
) => Promise<Output> | Output;

export interface IdempotencyRecord {
  requestHash: string;
  output: JsonValue;
  occurredAt: string;
  actorId: string;
  artifactsEmittedAt: string | null;
}

export interface IdempotencyClaimInput {
  requestHash: string;
  ownerToken: string;
  now: string;
}

export type IdempotencyClaim =
  | { kind: "owner"; ownerToken: string; claimedAt: string; pendingExpiresAt: string }
  | { kind: "replay"; record: IdempotencyRecord; completedAt: string }
  | { kind: "conflict"; existingRequestHash: string }
  | { kind: "pending"; claimedAt: string; pendingExpiresAt: string }
  | { kind: "ambiguous"; claimedAt: string; ambiguousAt: string };

export interface IdempotencyCompletion extends IdempotencyRecord {
  ownerToken: string;
  completedAt: string;
}

export interface IdempotencyAmbiguousFailure {
  requestHash: string;
  ownerToken: string;
  ambiguousAt: string;
}

export interface IdempotencyArtifactsCompletion {
  requestHash: string;
  artifactsEmittedAt: string;
}

export interface IdempotencyRetryableFailure {
  requestHash: string;
  ownerToken: string;
}

/**
 * The command bus requires an atomic claim before it invokes a handler. A
 * durable implementation must make claim/complete/markAmbiguous atomic across
 * every process that can execute commands for the same ledger.
 */
export interface IdempotencyStore {
  readonly durability: "fixture_only" | "durable_atomic";
  claim(key: string, input: IdempotencyClaimInput): Promise<IdempotencyClaim> | IdempotencyClaim;
  complete(key: string, value: IdempotencyCompletion): Promise<void> | void;
  markAmbiguous(key: string, value: IdempotencyAmbiguousFailure): Promise<void> | void;
  markArtifactsEmitted(key: string, value: IdempotencyArtifactsCompletion): Promise<void> | void;
  release(key: string, value: IdempotencyRetryableFailure): Promise<void> | void;
}

type InMemoryIdempotencyEntry =
  | {
      state: "pending";
      requestHash: string;
      ownerToken: string;
      claimedAt: string;
      pendingExpiresAt: string;
    }
  | {
      state: "completed";
      requestHash: string;
      output: JsonValue;
      completedAt: string;
      occurredAt: string;
      actorId: string;
      artifactsEmittedAt: string | null;
    }
  | {
      state: "ambiguous";
      requestHash: string;
      claimedAt: string;
      ambiguousAt: string;
    };

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly durability = "fixture_only" as const;
  readonly #entries = new Map<string, InMemoryIdempotencyEntry>();
  readonly #pendingTimeoutMs: number;

  constructor(options: { pendingTimeoutMs?: number } = {}) {
    this.#pendingTimeoutMs = options.pendingTimeoutMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.#pendingTimeoutMs) || this.#pendingTimeoutMs < 1) {
      throw new Error("pendingTimeoutMs must be a positive safe integer");
    }
  }

  claim(key: string, input: IdempotencyClaimInput): IdempotencyClaim {
    nonEmpty(key, "idempotency ledger key");
    nonEmpty(input.requestHash, "requestHash");
    nonEmpty(input.ownerToken, "ownerToken");
    const nowMs = timestamp(input.now, "claim now");
    const existing = this.#entries.get(key);
    if (!existing) {
      const pendingExpiresAt = new Date(nowMs + this.#pendingTimeoutMs).toISOString();
      this.#entries.set(key, {
        state: "pending",
        requestHash: input.requestHash,
        ownerToken: input.ownerToken,
        claimedAt: input.now,
        pendingExpiresAt,
      });
      return {
        kind: "owner",
        ownerToken: input.ownerToken,
        claimedAt: input.now,
        pendingExpiresAt,
      };
    }
    if (existing.requestHash !== input.requestHash) {
      return { kind: "conflict", existingRequestHash: existing.requestHash };
    }
    if (existing.state === "completed") {
      return {
        kind: "replay",
        record: {
          requestHash: existing.requestHash,
          output: structuredClone(existing.output),
          occurredAt: existing.occurredAt,
          actorId: existing.actorId,
          artifactsEmittedAt: existing.artifactsEmittedAt,
        },
        completedAt: existing.completedAt,
      };
    }
    if (existing.state === "ambiguous") {
      return {
        kind: "ambiguous",
        claimedAt: existing.claimedAt,
        ambiguousAt: existing.ambiguousAt,
      };
    }
    if (nowMs >= timestamp(existing.pendingExpiresAt, "pending expiry")) {
      const ambiguous: InMemoryIdempotencyEntry = {
        state: "ambiguous",
        requestHash: existing.requestHash,
        claimedAt: existing.claimedAt,
        ambiguousAt: input.now,
      };
      this.#entries.set(key, ambiguous);
      return { kind: "ambiguous", claimedAt: ambiguous.claimedAt, ambiguousAt: input.now };
    }
    return {
      kind: "pending",
      claimedAt: existing.claimedAt,
      pendingExpiresAt: existing.pendingExpiresAt,
    };
  }

  complete(key: string, value: IdempotencyCompletion): void {
    const existing = this.#entries.get(key);
    if (!existing) throw new Error("cannot complete an idempotency claim that does not exist");
    if (existing.requestHash !== value.requestHash) {
      throw new Error("cannot complete an idempotency claim bound to different input");
    }
    if (existing.state === "completed") {
      if (stableJson(existing.output) !== stableJson(value.output)) {
        throw new Error("completed idempotency output is immutable");
      }
      return;
    }
    if (existing.state === "ambiguous") {
      throw new Error("cannot complete an ambiguous idempotency claim");
    }
    if (existing.ownerToken !== value.ownerToken) {
      throw new Error("only the idempotency claim owner may complete it");
    }
    timestamp(value.completedAt, "completedAt");
    timestamp(value.occurredAt, "occurredAt");
    nonEmpty(value.actorId, "actorId");
    this.#entries.set(key, {
      state: "completed",
      requestHash: value.requestHash,
      output: structuredClone(value.output),
      completedAt: value.completedAt,
      occurredAt: value.occurredAt,
      actorId: value.actorId,
      artifactsEmittedAt: value.artifactsEmittedAt,
    });
  }

  markAmbiguous(key: string, value: IdempotencyAmbiguousFailure): void {
    const existing = this.#entries.get(key);
    if (!existing) throw new Error("cannot mark an idempotency claim that does not exist");
    if (existing.requestHash !== value.requestHash) {
      throw new Error("cannot mark an idempotency claim bound to different input");
    }
    if (existing.state === "completed" || existing.state === "ambiguous") return;
    if (existing.ownerToken !== value.ownerToken) {
      throw new Error("only the idempotency claim owner may mark it ambiguous");
    }
    timestamp(value.ambiguousAt, "ambiguousAt");
    this.#entries.set(key, {
      state: "ambiguous",
      requestHash: value.requestHash,
      claimedAt: existing.claimedAt,
      ambiguousAt: value.ambiguousAt,
    });
  }

  markArtifactsEmitted(key: string, value: IdempotencyArtifactsCompletion): void {
    timestamp(value.artifactsEmittedAt, "artifactsEmittedAt");
    const existing = this.#entries.get(key);
    if (!existing || existing.state !== "completed") {
      throw new Error("only a completed idempotency claim may finish its artifacts");
    }
    if (existing.requestHash !== value.requestHash) {
      throw new Error("cannot finish artifacts for an idempotency claim bound to different input");
    }
    if (existing.artifactsEmittedAt) return;
    this.#entries.set(key, { ...existing, artifactsEmittedAt: value.artifactsEmittedAt });
  }

  release(key: string, value: IdempotencyRetryableFailure): void {
    const existing = this.#entries.get(key);
    if (!existing || existing.state !== "pending") {
      throw new Error("only a pending idempotency claim may be released");
    }
    if (existing.requestHash !== value.requestHash || existing.ownerToken !== value.ownerToken) {
      throw new Error("only the idempotency claim owner may release it");
    }
    this.#entries.delete(key);
  }
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

interface SqliteIdempotencyRow {
  request_hash: string;
  state: "pending" | "completed" | "ambiguous";
  owner_token: string | null;
  claimed_at: string;
  pending_expires_at: string;
  completed_at: string | null;
  ambiguous_at: string | null;
  output_json: string | null;
  occurred_at: string | null;
  actor_id: string | null;
  artifacts_emitted_at: string | null;
}

function sqliteDatabase(path: string): SqliteDatabase {
  try {
    const moduleLocation = typeof __filename === "string" ? __filename : import.meta.url;
    const { DatabaseSync } = createRequire(moduleLocation)("node:sqlite") as {
      DatabaseSync: new (filename: string) => SqliteDatabase;
    };
    return new DatabaseSync(path);
  } catch (error) {
    throw new Error(
      `the durable command idempotency store requires Node >= 22.5 (node:sqlite unavailable): ${(error as Error).message}`,
    );
  }
}

/** Cross-process atomic idempotency ledger for production command effects. */
export class SqliteIdempotencyStore implements IdempotencyStore {
  readonly durability = "durable_atomic" as const;
  readonly #database: SqliteDatabase;
  readonly #pendingTimeoutMs: number;

  constructor(path: string, options: { pendingTimeoutMs?: number } = {}) {
    if (path === ":memory:") {
      throw new Error("the durable idempotency store requires a filesystem path");
    }
    nonEmpty(path, "SQLite idempotency path");
    this.#pendingTimeoutMs = options.pendingTimeoutMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.#pendingTimeoutMs) || this.#pendingTimeoutMs < 1) {
      throw new Error("pendingTimeoutMs must be a positive safe integer");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = sqliteDatabase(path);
    initializeSqliteWal(this.#database, { label: "durable command idempotency store" });
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS command_idempotency (
        ledger_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'ambiguous')),
        owner_token TEXT,
        claimed_at TEXT NOT NULL,
        pending_expires_at TEXT NOT NULL,
        completed_at TEXT,
        ambiguous_at TEXT,
        output_json TEXT,
        occurred_at TEXT,
        actor_id TEXT,
        artifacts_emitted_at TEXT,
        CHECK (
          (state = 'pending' AND owner_token IS NOT NULL AND completed_at IS NULL AND ambiguous_at IS NULL AND output_json IS NULL)
          OR (state = 'completed' AND owner_token IS NULL AND completed_at IS NOT NULL AND ambiguous_at IS NULL AND output_json IS NOT NULL AND occurred_at IS NOT NULL AND actor_id IS NOT NULL)
          OR (state = 'ambiguous' AND owner_token IS NULL AND completed_at IS NULL AND ambiguous_at IS NOT NULL AND output_json IS NULL)
        )
      )
    `);
    chmodSync(path, 0o600);
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
        // Preserve the original transactional failure.
      }
      throw error;
    }
  }

  #read(key: string): SqliteIdempotencyRow | undefined {
    return this.#database
      .prepare(
        `SELECT request_hash, state, owner_token, claimed_at, pending_expires_at,
                completed_at, ambiguous_at, output_json, occurred_at, actor_id,
                artifacts_emitted_at
           FROM command_idempotency
          WHERE ledger_key = ?`,
      )
      .get(key) as SqliteIdempotencyRow | undefined;
  }

  claim(key: string, input: IdempotencyClaimInput): IdempotencyClaim {
    nonEmpty(key, "idempotency ledger key");
    nonEmpty(input.requestHash, "requestHash");
    nonEmpty(input.ownerToken, "ownerToken");
    const nowMs = timestamp(input.now, "claim now");
    return this.#transaction(() => {
      const existing = this.#read(key);
      if (!existing) {
        const pendingExpiresAt = new Date(nowMs + this.#pendingTimeoutMs).toISOString();
        this.#database
          .prepare(
            `INSERT INTO command_idempotency
              (ledger_key, request_hash, state, owner_token, claimed_at, pending_expires_at)
             VALUES (?, ?, 'pending', ?, ?, ?)`,
          )
          .run(key, input.requestHash, input.ownerToken, input.now, pendingExpiresAt);
        return {
          kind: "owner",
          ownerToken: input.ownerToken,
          claimedAt: input.now,
          pendingExpiresAt,
        };
      }
      if (existing.request_hash !== input.requestHash) {
        return { kind: "conflict", existingRequestHash: existing.request_hash };
      }
      if (existing.state === "completed") {
        if (
          !existing.output_json ||
          !existing.completed_at ||
          !existing.occurred_at ||
          !existing.actor_id
        ) {
          throw new Error("completed idempotency row is corrupt");
        }
        return {
          kind: "replay",
          record: {
            requestHash: existing.request_hash,
            output: JSON.parse(existing.output_json) as JsonValue,
            occurredAt: existing.occurred_at,
            actorId: existing.actor_id,
            artifactsEmittedAt: existing.artifacts_emitted_at,
          },
          completedAt: existing.completed_at,
        };
      }
      if (existing.state === "ambiguous") {
        if (!existing.ambiguous_at) throw new Error("ambiguous idempotency row is corrupt");
        return {
          kind: "ambiguous",
          claimedAt: existing.claimed_at,
          ambiguousAt: existing.ambiguous_at,
        };
      }
      if (nowMs >= timestamp(existing.pending_expires_at, "pending expiry")) {
        this.#database
          .prepare(
            `UPDATE command_idempotency
                SET state = 'ambiguous', owner_token = NULL, ambiguous_at = ?
              WHERE ledger_key = ? AND state = 'pending'`,
          )
          .run(input.now, key);
        return { kind: "ambiguous", claimedAt: existing.claimed_at, ambiguousAt: input.now };
      }
      return {
        kind: "pending",
        claimedAt: existing.claimed_at,
        pendingExpiresAt: existing.pending_expires_at,
      };
    });
  }

  complete(key: string, value: IdempotencyCompletion): void {
    timestamp(value.completedAt, "completedAt");
    timestamp(value.occurredAt, "occurredAt");
    nonEmpty(value.actorId, "actorId");
    this.#transaction(() => {
      const existing = this.#read(key);
      if (!existing) throw new Error("cannot complete an idempotency claim that does not exist");
      if (existing.request_hash !== value.requestHash) {
        throw new Error("cannot complete an idempotency claim bound to different input");
      }
      const outputJson = stableJson(value.output);
      if (existing.state === "completed") {
        if (existing.output_json !== outputJson) {
          throw new Error("completed idempotency output is immutable");
        }
        return;
      }
      if (existing.state === "ambiguous") {
        throw new Error("cannot complete an ambiguous idempotency claim");
      }
      if (existing.owner_token !== value.ownerToken) {
        throw new Error("only the idempotency claim owner may complete it");
      }
      this.#database
        .prepare(
          `UPDATE command_idempotency
              SET state = 'completed', owner_token = NULL, completed_at = ?, output_json = ?,
                  occurred_at = ?, actor_id = ?, artifacts_emitted_at = ?
            WHERE ledger_key = ? AND state = 'pending' AND owner_token = ?`,
        )
        .run(
          value.completedAt,
          outputJson,
          value.occurredAt,
          value.actorId,
          value.artifactsEmittedAt,
          key,
          value.ownerToken,
        );
    });
  }

  markAmbiguous(key: string, value: IdempotencyAmbiguousFailure): void {
    timestamp(value.ambiguousAt, "ambiguousAt");
    this.#transaction(() => {
      const existing = this.#read(key);
      if (!existing) throw new Error("cannot mark an idempotency claim that does not exist");
      if (existing.request_hash !== value.requestHash) {
        throw new Error("cannot mark an idempotency claim bound to different input");
      }
      if (existing.state === "completed" || existing.state === "ambiguous") return;
      if (existing.owner_token !== value.ownerToken) {
        throw new Error("only the idempotency claim owner may mark it ambiguous");
      }
      this.#database
        .prepare(
          `UPDATE command_idempotency
              SET state = 'ambiguous', owner_token = NULL, ambiguous_at = ?
            WHERE ledger_key = ? AND state = 'pending' AND owner_token = ?`,
        )
        .run(value.ambiguousAt, key, value.ownerToken);
    });
  }

  markArtifactsEmitted(key: string, value: IdempotencyArtifactsCompletion): void {
    timestamp(value.artifactsEmittedAt, "artifactsEmittedAt");
    this.#transaction(() => {
      const existing = this.#read(key);
      if (!existing || existing.state !== "completed") {
        throw new Error("only a completed idempotency claim may finish its artifacts");
      }
      if (existing.request_hash !== value.requestHash) {
        throw new Error(
          "cannot finish artifacts for an idempotency claim bound to different input",
        );
      }
      if (existing.artifacts_emitted_at) return;
      this.#database
        .prepare(
          `UPDATE command_idempotency
              SET artifacts_emitted_at = ?
            WHERE ledger_key = ? AND state = 'completed' AND artifacts_emitted_at IS NULL`,
        )
        .run(value.artifactsEmittedAt, key);
    });
  }

  release(key: string, value: IdempotencyRetryableFailure): void {
    this.#transaction(() => {
      const existing = this.#read(key);
      if (!existing || existing.state !== "pending") {
        throw new Error("only a pending idempotency claim may be released");
      }
      if (
        existing.request_hash !== value.requestHash ||
        existing.owner_token !== value.ownerToken
      ) {
        throw new Error("only the idempotency claim owner may release it");
      }
      this.#database
        .prepare(
          `DELETE FROM command_idempotency
            WHERE ledger_key = ? AND state = 'pending' AND owner_token = ?`,
        )
        .run(key, value.ownerToken);
    });
  }

  close(): void {
    this.#database.close();
  }
}

export function commandRequestHash(
  contract: Pick<AnyCommandContract, "id" | "version">,
  input: JsonValue,
): string {
  const canonical = stableJson({
    commandId: contract.id,
    commandVersion: contract.version,
    input,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export interface MeteringHook {
  readonly durability?: "fixture_only" | "durable_atomic";
  /** record() must deduplicate the supplied idempotencyKey. */
  record(input: {
    idempotencyKey: string;
    tenant: CommandExecutionContext["tenant"];
    commandId: string;
    meter: string;
    quantity: number;
    occurredAt: string;
  }): Promise<void> | void;
}

export interface CommandBusHooks {
  identity(context: CommandExecutionContext): Promise<void> | void;
  tenant(context: CommandExecutionContext): Promise<void> | void;
  subscription(
    contract: AnyCommandContract,
    context: CommandExecutionContext,
  ): Promise<void> | void;
  entitlement(contract: AnyCommandContract, context: CommandExecutionContext): Promise<void> | void;
  grant(
    contract: AnyCommandContract,
    context: CommandExecutionContext,
    now: Date,
  ): Promise<void> | void;
  scope(contract: AnyCommandContract, context: CommandExecutionContext): Promise<void> | void;
  idempotency: IdempotencyStore;
  audit: AuditSink;
  /** Tenant-free destination for identity or tenant authorization denials. */
  securityAudit?: AuditSink;
  metering: MeteringHook;
  events: EventSink;
}

/** Reserved global namespace for denials before a tenant has been authorized. */
export const COMMAND_SECURITY_AUDIT_TENANT: TenantRef = Object.freeze({
  organizationId: "_venture_harness_security",
  ventureId: "command_bus",
});

export interface CommandBusOptions {
  now?: () => Date;
  executionMode?: "fixture" | "production";
}

interface RegisteredCommand {
  contract: AnyCommandContract;
  handler: CommandHandler<JsonValue, JsonValue>;
}

export type CommandBusErrorCode =
  | "command_unknown"
  | "command_duplicate"
  | "authorization_denied"
  | "idempotency_conflict"
  | "idempotency_pending"
  | "idempotency_ambiguous"
  | "idempotency_store_unsafe"
  | "evidence_sink_unsafe"
  | "invalid_input"
  | "invalid_output"
  | "handler_failed";

const COMMAND_ERROR_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END|$)/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}/giu,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{8,}/giu,
];

export function sanitizeCommandFailureMessage(value: string): string {
  return COMMAND_ERROR_SECRET_PATTERNS.reduce(
    (safe, pattern) => safe.replace(pattern, "[REDACTED]"),
    value,
  );
}

export interface CommandFailureEnvelope extends JsonObject {
  error: "command_failed";
  code: CommandBusErrorCode | "internal_error";
  message: string;
}

const COMMAND_BUS_ERROR_CODES: ReadonlySet<string> = new Set<CommandBusErrorCode>([
  "command_unknown",
  "command_duplicate",
  "authorization_denied",
  "idempotency_conflict",
  "idempotency_pending",
  "idempotency_ambiguous",
  "idempotency_store_unsafe",
  "evidence_sink_unsafe",
  "invalid_input",
  "invalid_output",
  "handler_failed",
]);

function commandBusErrorLike(
  error: unknown,
): { readonly code: CommandBusErrorCode; readonly message: string } | null {
  if (error instanceof CommandBusError) return error;
  if (!error || typeof error !== "object") return null;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  if (
    candidate.name !== "CommandBusError" ||
    typeof candidate.code !== "string" ||
    !COMMAND_BUS_ERROR_CODES.has(candidate.code) ||
    typeof candidate.message !== "string"
  ) {
    return null;
  }
  return { code: candidate.code as CommandBusErrorCode, message: candidate.message };
}

export function commandFailureEnvelope(error: unknown): CommandFailureEnvelope {
  const classified = commandBusErrorLike(error);
  if (classified) {
    return {
      error: "command_failed",
      code: classified.code,
      message: sanitizeCommandFailureMessage(classified.message),
    };
  }
  return {
    error: "command_failed",
    code: "internal_error",
    message: "Command execution failed without a classified result.",
  };
}

export function commandFailureHttpStatus(
  code: CommandFailureEnvelope["code"],
): 400 | 403 | 404 | 409 | 500 | 502 | 503 {
  if (code === "invalid_input") return 400;
  if (code === "authorization_denied") return 403;
  if (code === "command_unknown") return 404;
  if (code === "idempotency_store_unsafe" || code === "evidence_sink_unsafe") return 503;
  if (code.startsWith("idempotency_")) return 409;
  if (code === "invalid_output") return 502;
  return 500;
}

export class CommandBusError extends Error {
  constructor(
    message: string,
    readonly code: CommandBusErrorCode,
  ) {
    super(sanitizeCommandFailureMessage(message));
    this.name = "CommandBusError";
  }
}

/**
 * A handler may use this only when it can prove it failed before any external
 * or local business effect. The bus then releases the idempotency claim so a
 * corrected retry is possible instead of poisoning the key as ambiguous.
 */
export class CommandDefinitiveNoEffectError extends Error {
  constructor(
    message: string,
    readonly code: CommandBusErrorCode = "handler_failed",
  ) {
    super(sanitizeCommandFailureMessage(message));
    this.name = "CommandDefinitiveNoEffectError";
  }
}

export class CommandBus {
  readonly #commands = new Map<string, RegisteredCommand>();
  readonly #hooks: CommandBusHooks & { securityAudit: AuditSink };
  readonly #now: () => Date;
  readonly #executionMode: "fixture" | "production";

  constructor(hooks: CommandBusHooks, nowOrOptions: (() => Date) | CommandBusOptions = {}) {
    this.#hooks = { ...hooks, securityAudit: hooks.securityAudit ?? hooks.audit };
    this.#now =
      typeof nowOrOptions === "function" ? nowOrOptions : (nowOrOptions.now ?? (() => new Date()));
    this.#executionMode =
      typeof nowOrOptions === "function"
        ? "production"
        : (nowOrOptions.executionMode ?? "production");
  }

  register<Input extends JsonValue, Output extends JsonValue>(
    contract: CommandContract<Input, Output>,
    handler: CommandHandler<Input, Output>,
  ): void {
    if (this.#commands.has(contract.id))
      throw new CommandBusError(`Command already registered: ${contract.id}`, "command_duplicate");
    this.#commands.set(contract.id, {
      contract: contract as unknown as AnyCommandContract,
      handler: handler as unknown as CommandHandler<JsonValue, JsonValue>,
    });
  }

  contracts(): AnyCommandContract[] {
    return [...this.#commands.values()]
      .map(({ contract }) => contract)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async execute<Input extends JsonValue, Output extends JsonValue>(
    contract: CommandContract<Input, Output>,
    input: unknown,
    options: CommandInvocationOptions,
  ): Promise<Output> {
    return (await this.executeById(contract.id, input, options)) as Output;
  }

  async executeById(
    commandId: string,
    input: unknown,
    options: CommandInvocationOptions,
  ): Promise<JsonValue> {
    const registered = this.#commands.get(canonicalCommandId(commandId));
    if (!registered) throw new CommandBusError(`Unknown command: ${commandId}`, "command_unknown");
    const { contract, handler } = registered;
    if (this.#executionMode === "production" && contract.effect === "write") {
      if (this.#hooks.idempotency.durability !== "durable_atomic") {
        throw new CommandBusError(
          `Production command ${contract.id} requires a durable atomic idempotency store.`,
          "idempotency_store_unsafe",
        );
      }
      const unsafeEvidence = [
        ["audit", this.#hooks.audit.durability],
        ["security audit", this.#hooks.securityAudit.durability],
        ["events", this.#hooks.events.durability],
        ["metering", this.#hooks.metering.durability],
      ]
        .filter(([, durability]) => durability !== "durable_atomic")
        .map(([name]) => name);
      if (unsafeEvidence.length > 0) {
        throw new CommandBusError(
          `Production command ${contract.id} requires durable atomic evidence sinks for: ${unsafeEvidence.join(", ")}.`,
          "evidence_sink_unsafe",
        );
      }
    }
    const occurredAt = this.#now().toISOString();
    const details: JsonObject = {
      commandId: contract.id,
      commandVersion: contract.version,
      idempotencyKey: options.idempotencyKey,
    };
    let tenantAuthorized = false;
    try {
      if (!options.idempotencyKey.trim()) throw new Error("idempotencyKey must not be empty");
      await this.#hooks.identity(options.context);
      await this.#hooks.tenant(options.context);
      tenantAuthorized = true;
      await this.#hooks.audit.append({
        tenant: options.context.tenant,
        actorId: options.context.identity.actorId,
        action: contract.id,
        outcome: "requested",
        occurredAt,
        details,
      });
      await this.#hooks.subscription(contract, options.context);
      await this.#hooks.entitlement(contract, options.context);
      await this.#hooks.grant(contract, options.context, new Date(occurredAt));
      await this.#hooks.scope(contract, options.context);
      let parsed: JsonValue;
      try {
        parsed = contract.input.parse(input);
      } catch (error) {
        throw new CommandBusError(
          error instanceof Error ? error.message : String(error),
          "invalid_input",
        );
      }
      const requestHash = commandRequestHash(contract, parsed);
      const ledgerKey = `${tenantKey(options.context.tenant)}:${contract.id}:${options.idempotencyKey}`;
      const completionKey = `command-completion:${createHash("sha256").update(ledgerKey).digest("hex")}`;
      const emitCompletionArtifacts = async (record: IdempotencyRecord): Promise<void> => {
        await this.#hooks.events.append({
          eventId: `${completionKey}:event`,
          tenant: options.context.tenant,
          type: "command.succeeded",
          occurredAt: record.occurredAt,
          payload: { commandId: contract.id, commandVersion: contract.version },
        });
        if (contract.meter)
          await this.#hooks.metering.record({
            idempotencyKey: `${completionKey}:meter`,
            tenant: options.context.tenant,
            commandId: contract.id,
            meter: contract.meter,
            quantity: 1,
            occurredAt: record.occurredAt,
          });
        await this.#hooks.audit.append({
          idempotencyKey: `${completionKey}:audit`,
          tenant: options.context.tenant,
          actorId: record.actorId,
          action: contract.id,
          outcome: "succeeded",
          occurredAt: record.occurredAt,
          details,
        });
        await this.#hooks.idempotency.markArtifactsEmitted(ledgerKey, {
          requestHash,
          artifactsEmittedAt: this.#now().toISOString(),
        });
      };
      const ownerToken = randomUUID();
      const claim = await this.#hooks.idempotency.claim(ledgerKey, {
        requestHash,
        ownerToken,
        now: occurredAt,
      });
      if (claim.kind === "conflict") {
        throw new CommandBusError(
          `Idempotency key "${options.idempotencyKey}" is already bound to a different ${contract.id} request.`,
          "idempotency_conflict",
        );
      }
      if (claim.kind === "replay") {
        let replayed: JsonValue;
        try {
          replayed = contract.output.parse(claim.record.output);
        } catch (error) {
          throw new CommandBusError(
            error instanceof Error ? error.message : String(error),
            "invalid_output",
          );
        }
        if (!claim.record.artifactsEmittedAt) {
          try {
            await emitCompletionArtifacts(claim.record);
          } catch (error) {
            throw new CommandBusError(
              `Command ${contract.id} completed, but its replay-safe artifacts remain pending: ${error instanceof Error ? error.message : String(error)}`,
              "idempotency_pending",
            );
          }
        }
        return replayed;
      }
      if (claim.kind === "pending") {
        throw new CommandBusError(
          `Idempotency key "${options.idempotencyKey}" is already executing; retry after ${claim.pendingExpiresAt}.`,
          "idempotency_pending",
        );
      }
      if (claim.kind === "ambiguous") {
        throw new CommandBusError(
          `Idempotency key "${options.idempotencyKey}" has an ambiguous outcome and requires reconciliation before retry.`,
          "idempotency_ambiguous",
        );
      }
      let verified: JsonValue;
      const completionRecord: IdempotencyRecord = {
        requestHash,
        output: null,
        occurredAt,
        actorId: options.context.identity.actorId,
        artifactsEmittedAt: null,
      };
      try {
        const output = await handler(parsed, { ...options, commandId: contract.id, occurredAt });
        verified = contract.output.parse(output);
        completionRecord.output = verified;
        await this.#hooks.idempotency.complete(ledgerKey, {
          ...completionRecord,
          ownerToken: claim.ownerToken,
          completedAt: this.#now().toISOString(),
        });
      } catch (error) {
        if (contract.effect === "read" || error instanceof CommandDefinitiveNoEffectError) {
          await this.#hooks.idempotency.release(ledgerKey, {
            requestHash,
            ownerToken: claim.ownerToken,
          });
          if (error instanceof CommandBusError) throw error;
          if (error instanceof CommandDefinitiveNoEffectError) {
            throw new CommandBusError(error.message, error.code);
          }
          throw new CommandBusError(
            error instanceof Error ? error.message : String(error),
            "handler_failed",
          );
        }
        try {
          await this.#hooks.idempotency.markAmbiguous(ledgerKey, {
            requestHash,
            ownerToken: claim.ownerToken,
            ambiguousAt: this.#now().toISOString(),
          });
        } catch {
          // A pending claim also fails closed and expires to ambiguous; never rerun blindly.
        }
        if (error instanceof CommandBusError) throw error;
        throw new CommandBusError(
          `Idempotency key "${options.idempotencyKey}" has an ambiguous outcome and requires reconciliation before retry.`,
          "idempotency_ambiguous",
        );
      }
      try {
        await emitCompletionArtifacts(completionRecord);
      } catch (error) {
        throw new CommandBusError(
          `Command ${contract.id} completed, but its replay-safe artifacts remain pending: ${error instanceof Error ? error.message : String(error)}`,
          "idempotency_pending",
        );
      }
      return verified;
    } catch (error) {
      const errorCode = error instanceof CommandBusError ? error.code : "authorization_denied";
      const denialDetails: JsonObject = tenantAuthorized
        ? { ...details, errorCode }
        : {
            commandId: contract.id,
            commandVersion: contract.version,
            errorCode,
          };
      await (tenantAuthorized ? this.#hooks.audit : this.#hooks.securityAudit).append({
        tenant: tenantAuthorized ? options.context.tenant : COMMAND_SECURITY_AUDIT_TENANT,
        actorId: options.context.identity.actorId,
        action: contract.id,
        outcome:
          error instanceof CommandBusError &&
          (error.code === "invalid_input" ||
            error.code === "invalid_output" ||
            error.code.startsWith("idempotency_"))
            ? "failed"
            : "denied",
        occurredAt,
        details: denialDetails,
      });
      if (error instanceof CommandBusError) throw error;
      throw new CommandBusError(
        error instanceof Error ? error.message : String(error),
        "authorization_denied",
      );
    }
  }
}
