import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { TenantRef } from "@venture-harness/core";
import { initializeSqliteWal, stableJson, tenantKey, type JsonObject } from "@venture-harness/core";

export interface MeteringRecord {
  /** Deterministic key for replay-safe command completion metering. */
  idempotencyKey?: string;
  tenant: TenantRef;
  commandId: string;
  meter: string;
  quantity: number;
  occurredAt: string;
}

export interface MeteringSink {
  /** Production command evidence requires a filesystem-backed atomic sink. */
  readonly durability?: "fixture_only" | "durable_atomic";
  /** Implementations must deduplicate a supplied idempotencyKey. */
  record(input: MeteringRecord): Promise<void> | void;
}

export class InMemoryMeteringSink implements MeteringSink {
  readonly durability = "fixture_only" as const;
  readonly #records: MeteringRecord[] = [];

  record(input: MeteringRecord): void {
    if (
      input.idempotencyKey &&
      this.#records.some(({ idempotencyKey }) => idempotencyKey === input.idempotencyKey)
    ) {
      return;
    }
    this.#records.push(structuredClone(input));
  }

  read(tenant: TenantRef): MeteringRecord[] {
    const key = tenantKey(tenant);
    return this.#records
      .filter((record) => tenantKey(record.tenant) === key)
      .map((record) => structuredClone(record));
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
      `the durable metering sink requires Node >= 22.5 (node:sqlite unavailable): ${(error as Error).message}`,
    );
  }
}

/** Durable replay-safe command metering ledger. */
export class SqliteMeteringSink implements MeteringSink {
  readonly durability = "durable_atomic" as const;
  readonly #database: SqliteDatabase;

  constructor(path: string) {
    if (!path.trim() || path === ":memory:") {
      throw new Error("the durable metering sink requires a filesystem path");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = sqliteDatabase(path);
    initializeSqliteWal(this.#database, { label: "durable metering sink" });
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS command_metering (
        record_id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE,
        tenant_key TEXT NOT NULL,
        record_json TEXT NOT NULL
      )
    `);
    chmodSync(path, 0o600);
  }

  record(input: MeteringRecord): void {
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO command_metering
           (idempotency_key, tenant_key, record_json) VALUES (?, ?, ?)`,
      )
      .run(
        input.idempotencyKey ?? null,
        tenantKey(input.tenant),
        stableJson(input as unknown as JsonObject),
      );
  }

  read(tenant: TenantRef): MeteringRecord[] {
    return (
      this.#database
        .prepare("SELECT record_json FROM command_metering WHERE tenant_key = ? ORDER BY record_id")
        .all(tenantKey(tenant)) as Array<{ record_json: string }>
    ).map(({ record_json }) => JSON.parse(record_json) as MeteringRecord);
  }

  close(): void {
    this.#database.close();
  }
}
