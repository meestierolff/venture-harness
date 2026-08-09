import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { JsonObject, TenantRef } from "@venture-harness/core";
import { stableJson, tenantKey } from "@venture-harness/core";

export interface DomainEvent {
  eventId: string;
  tenant: TenantRef;
  type: string;
  occurredAt: string;
  payload: JsonObject;
}

export interface EventSink {
  /** Production command evidence requires a filesystem-backed atomic sink. */
  readonly durability?: "fixture_only" | "durable_atomic";
  /** Implementations must treat eventId as an idempotency key. */
  append(event: DomainEvent): Promise<void> | void;
}

export class InMemoryEventLog implements EventSink {
  readonly durability = "fixture_only" as const;
  readonly #events: DomainEvent[] = [];

  append(event: DomainEvent): void {
    if (this.#events.some(({ eventId }) => eventId === event.eventId)) return;
    this.#events.push(structuredClone(event));
  }

  read(tenant: TenantRef): DomainEvent[] {
    const key = tenantKey(tenant);
    return this.#events
      .filter((event) => tenantKey(event.tenant) === key)
      .map((event) => structuredClone(event));
  }
}

interface SqliteStatement {
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
      `the durable event sink requires Node >= 22.5 (node:sqlite unavailable): ${(error as Error).message}`,
    );
  }
}

/** Durable replay-safe command/domain event log. */
export class SqliteEventLog implements EventSink {
  readonly durability = "durable_atomic" as const;
  readonly #database: SqliteDatabase;

  constructor(path: string) {
    if (!path.trim() || path === ":memory:") {
      throw new Error("the durable event sink requires a filesystem path");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = sqliteDatabase(path);
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS command_events (
        event_id TEXT PRIMARY KEY,
        tenant_key TEXT NOT NULL,
        event_json TEXT NOT NULL
      )
    `);
    chmodSync(path, 0o600);
  }

  append(event: DomainEvent): void {
    this.#database
      .prepare(
        "INSERT OR IGNORE INTO command_events (event_id, tenant_key, event_json) VALUES (?, ?, ?)",
      )
      .run(event.eventId, tenantKey(event.tenant), stableJson(event as unknown as JsonObject));
  }

  read(tenant: TenantRef): DomainEvent[] {
    return (
      this.#database
        .prepare("SELECT event_json FROM command_events WHERE tenant_key = ? ORDER BY rowid")
        .all(tenantKey(tenant)) as Array<{ event_json: string }>
    ).map(({ event_json }) => JSON.parse(event_json) as DomainEvent);
  }

  close(): void {
    this.#database.close();
  }
}
