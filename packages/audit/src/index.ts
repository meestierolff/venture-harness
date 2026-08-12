import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { JsonObject, TenantRef } from "@venture-harness/core";
import { initializeSqliteWal, stableJson, tenantKey } from "@venture-harness/core";

export interface AuditInput {
  /** Deterministic key for replay-safe completion artifacts. */
  idempotencyKey?: string;
  tenant: TenantRef;
  actorId: string;
  action: string;
  outcome: "requested" | "succeeded" | "denied" | "failed";
  occurredAt: string;
  details: JsonObject;
}

export interface AuditRecord extends AuditInput {
  sequence: number;
  previousHash: string;
  hash: string;
}

export interface AuditSink {
  /** Production command evidence requires a filesystem-backed atomic sink. */
  readonly durability?: "fixture_only" | "durable_atomic";
  /** Implementations must deduplicate a supplied idempotencyKey within its tenant. */
  append(input: AuditInput): Promise<AuditRecord> | AuditRecord;
}

function digest(input: AuditInput, sequence: number, previousHash: string): string {
  return createHash("sha256")
    .update(stableJson({ ...(input as unknown as JsonObject), sequence, previousHash }))
    .digest("hex");
}

export class InMemoryAuditChain implements AuditSink {
  readonly durability = "fixture_only" as const;
  readonly #records = new Map<string, AuditRecord[]>();

  append(input: AuditInput): AuditRecord {
    const key = tenantKey(input.tenant);
    const records = this.#records.get(key) ?? [];
    if (input.idempotencyKey) {
      const existing = records.find(
        ({ idempotencyKey }) => idempotencyKey === input.idempotencyKey,
      );
      if (existing) return structuredClone(existing);
    }
    const sequence = records.length + 1;
    const previousHash = records.at(-1)?.hash ?? "0".repeat(64);
    const record = {
      ...structuredClone(input),
      sequence,
      previousHash,
      hash: digest(input, sequence, previousHash),
    };
    records.push(record);
    this.#records.set(key, records);
    return structuredClone(record);
  }

  read(tenant: TenantRef): AuditRecord[] {
    return (this.#records.get(tenantKey(tenant)) ?? []).map((record) => structuredClone(record));
  }

  verify(tenant: TenantRef): boolean {
    let previousHash = "0".repeat(64);
    return this.read(tenant).every((record, index) => {
      const { sequence, hash, previousHash: recordedPrevious, ...input } = record;
      const valid =
        sequence === index + 1 &&
        recordedPrevious === previousHash &&
        hash === digest(input, sequence, previousHash);
      previousHash = hash;
      return valid;
    });
  }
}

interface SqliteStatement {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
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
      `the durable audit sink requires Node >= 22.5 (node:sqlite unavailable): ${(error as Error).message}`,
    );
  }
}

/** Durable, cross-process hash-chained audit evidence with tenant-local ordering. */
export class SqliteAuditChain implements AuditSink {
  readonly durability = "durable_atomic" as const;
  readonly #database: SqliteDatabase;

  constructor(path: string) {
    if (!path.trim() || path === ":memory:") {
      throw new Error("the durable audit sink requires a filesystem path");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = sqliteDatabase(path);
    initializeSqliteWal(this.#database, { label: "durable audit sink" });
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS command_audit (
        tenant_key TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        idempotency_key TEXT,
        record_json TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (tenant_key, sequence)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS command_audit_idempotency
        ON command_audit (tenant_key, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
    chmodSync(path, 0o600);
  }

  append(input: AuditInput): AuditRecord {
    const key = tenantKey(input.tenant);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (input.idempotencyKey) {
        const replay = this.#database
          .prepare(
            "SELECT record_json FROM command_audit WHERE tenant_key = ? AND idempotency_key = ?",
          )
          .get(key, input.idempotencyKey) as { record_json: string } | undefined;
        if (replay) {
          this.#database.exec("COMMIT");
          return JSON.parse(replay.record_json) as AuditRecord;
        }
      }
      const previous = this.#database
        .prepare(
          "SELECT sequence, hash FROM command_audit WHERE tenant_key = ? ORDER BY sequence DESC LIMIT 1",
        )
        .get(key) as { sequence: number; hash: string } | undefined;
      const sequence = (previous?.sequence ?? 0) + 1;
      const previousHash = previous?.hash ?? "0".repeat(64);
      const record: AuditRecord = {
        ...structuredClone(input),
        sequence,
        previousHash,
        hash: digest(input, sequence, previousHash),
      };
      this.#database
        .prepare(
          `INSERT INTO command_audit
             (tenant_key, sequence, idempotency_key, record_json, hash)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          key,
          sequence,
          input.idempotencyKey ?? null,
          stableJson(record as unknown as JsonObject),
          record.hash,
        );
      this.#database.exec("COMMIT");
      return structuredClone(record);
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original transactional failure.
      }
      throw error;
    }
  }

  read(tenant: TenantRef): AuditRecord[] {
    return (
      this.#database
        .prepare("SELECT record_json FROM command_audit WHERE tenant_key = ? ORDER BY sequence")
        .all(tenantKey(tenant)) as Array<{ record_json: string }>
    ).map(({ record_json }) => JSON.parse(record_json) as AuditRecord);
  }

  verify(tenant: TenantRef): boolean {
    let previousHash = "0".repeat(64);
    return this.read(tenant).every((record, index) => {
      const { sequence, hash, previousHash: recordedPrevious, ...input } = record;
      const valid =
        sequence === index + 1 &&
        recordedPrevious === previousHash &&
        hash === digest(input, sequence, previousHash);
      previousHash = hash;
      return valid;
    });
  }

  close(): void {
    this.#database.close();
  }
}
