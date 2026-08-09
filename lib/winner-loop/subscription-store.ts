import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { IngestEnvironment, SubscriptionEvent } from "./subscriptions";
import {
  LEGACY_UNSCOPED_ORGANIZATION_ID,
  adoptLegacyTenantPayload,
  assertAddressableTenantScope,
  resolveLegacyTenantAdoptions,
  type LegacyAdoptionOptions,
  type LegacyTenantTarget,
} from "./legacy-adoption";

export interface SubscriptionScope {
  organizationId: string;
  ventureId: string;
  revenueCatProject: string;
  environment: IngestEnvironment;
}

export interface SubscriptionEventStore {
  readonly label: string;
  readonly durable: boolean;
  append(
    scope: SubscriptionScope,
    event: SubscriptionEvent,
  ): "accepted" | "duplicate" | "idempotency_conflict" | "currency_conflict";
  has(scope: SubscriptionScope, providerEventId: string): boolean;
  list(scope: SubscriptionScope): readonly SubscriptionEvent[];
  close(): void;
}

function scopeKey(scope: SubscriptionScope): string {
  assertAddressableTenantScope(scope, "subscription event store");
  return JSON.stringify([
    scope.organizationId,
    scope.ventureId,
    scope.revenueCatProject,
    scope.environment,
  ]);
}

function eventIntegrity(scope: SubscriptionScope, event: SubscriptionEvent): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.organizationId,
        scope.ventureId,
        scope.revenueCatProject,
        scope.environment,
        event,
      ]),
    )
    .digest("hex");
}

/** Transport metadata changes on every delivery and is not provider event identity. */
function sameProviderEvent(left: SubscriptionEvent, right: SubscriptionEvent): boolean {
  return (
    left.providerEventId === right.providerEventId &&
    left.type === right.type &&
    left.environment === right.environment &&
    left.subscriberId === right.subscriberId &&
    JSON.stringify(left.subscriberAliases ?? []) ===
      JSON.stringify(right.subscriberAliases ?? []) &&
    left.productId === right.productId &&
    left.entitlementId === right.entitlementId &&
    left.currency === right.currency &&
    left.revenueMinor === right.revenueMinor &&
    (left.transactionId ?? null) === (right.transactionId ?? null) &&
    (left.originalTransactionId ?? null) === (right.originalTransactionId ?? null) &&
    (left.entitlementExpiresAt ?? null) === (right.entitlementExpiresAt ?? null) &&
    (left.gracePeriodExpiresAt ?? null) === (right.gracePeriodExpiresAt ?? null) &&
    (left.cancellationReason ?? null) === (right.cancellationReason ?? null) &&
    (left.willRenew ?? null) === (right.willRenew ?? null) &&
    left.occurredAt === right.occurredAt
  );
}

function identities(event: SubscriptionEvent): ReadonlySet<string> {
  return new Set([event.subscriberId, ...(event.subscriberAliases ?? [])]);
}

function createsLinkedCurrencyConflict(
  existing: readonly SubscriptionEvent[],
  incoming: SubscriptionEvent,
): boolean {
  const all = [...existing, incoming];
  const linked = new Set(identities(incoming));
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of all) {
      const eventIdentities = identities(event);
      if (![...eventIdentities].some((identity) => linked.has(identity))) continue;
      for (const identity of eventIdentities) {
        if (!linked.has(identity)) {
          linked.add(identity);
          changed = true;
        }
      }
    }
  }
  const currencies = new Set(
    all.flatMap((event) =>
      event.revenueMinor !== 0 &&
      event.currency !== null &&
      [...identities(event)].some((identity) => linked.has(identity))
        ? [event.currency]
        : [],
    ),
  );
  return currencies.size > 1;
}

export function createMemorySubscriptionEventStore(): SubscriptionEventStore {
  const events = new Map<string, Map<string, SubscriptionEvent>>();
  return {
    label: "memory (test only)",
    durable: false,
    append(scope, event) {
      const key = scopeKey(scope);
      const scoped = events.get(key) ?? new Map<string, SubscriptionEvent>();
      const existing = scoped.get(event.providerEventId);
      if (existing) {
        return sameProviderEvent(existing, event) ? "duplicate" : "idempotency_conflict";
      }
      if (createsLinkedCurrencyConflict([...scoped.values()], event)) {
        return "currency_conflict";
      }
      scoped.set(event.providerEventId, Object.freeze({ ...event }));
      events.set(key, scoped);
      return "accepted";
    },
    has: (scope, providerEventId) => events.get(scopeKey(scope))?.has(providerEventId) ?? false,
    list: (scope) => Object.freeze([...(events.get(scopeKey(scope))?.values() ?? [])]),
    close() {},
  };
}

interface SqliteRunResult {
  changes: number;
}
interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): SqliteRunResult;
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
    throw new Error(`subscription SQLite store unavailable: ${(error as Error).message}`);
  }
}

const SUBSCRIPTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS subscription_events (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  revenuecat_project TEXT NOT NULL,
  environment TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, revenuecat_project, environment, provider_event_id)
);
CREATE INDEX IF NOT EXISTS subscription_events_ordered
  ON subscription_events(organization_id, venture_id, revenuecat_project, environment, occurred_at, provider_event_id);
`;

function hasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    ({ name }) => name === column,
  );
}

function rowScope(row: Record<string, unknown>, target?: LegacyTenantTarget): SubscriptionScope {
  return {
    organizationId: target?.organizationId ?? (row.organization_id as string),
    ventureId: target?.ventureId ?? (row.venture_id as string),
    revenueCatProject: row.revenuecat_project as string,
    environment: row.environment as IngestEnvironment,
  };
}

function adoptedEvent(row: Record<string, unknown>, target: LegacyTenantTarget): SubscriptionEvent {
  return adoptLegacyTenantPayload(
    JSON.parse(row.event_json as string) as SubscriptionEvent,
    target,
  );
}

function insertAdoptedSubscriptionRows(
  db: SqliteDatabase,
  rows: readonly Record<string, unknown>[],
  adoption: ReadonlyMap<string, LegacyTenantTarget>,
): void {
  const insert = db.prepare(
    `INSERT INTO subscription_events
     (organization_id, venture_id, revenuecat_project, environment, provider_event_id,
      event_json, content_hash, occurred_at, received_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const row of rows) {
    const target = adoption.get(row.venture_id as string)!;
    const scope = rowScope(row, target);
    const event = adoptedEvent(row, target);
    insert.run(
      scope.organizationId,
      scope.ventureId,
      scope.revenueCatProject,
      scope.environment,
      row.provider_event_id,
      JSON.stringify(event),
      eventIntegrity(scope, event),
      row.occurred_at,
      row.received_at,
    );
  }
}

function ensureSubscriptionIntegrity(db: SqliteDatabase): void {
  if (!hasColumn(db, "subscription_events", "content_hash")) {
    db.exec("ALTER TABLE subscription_events ADD COLUMN content_hash TEXT");
  }
  const rows = db
    .prepare("SELECT * FROM subscription_events WHERE content_hash IS NULL OR content_hash = ''")
    .all() as Record<string, unknown>[];
  const update = db.prepare(
    `UPDATE subscription_events SET content_hash = ?
     WHERE organization_id = ? AND venture_id = ? AND revenuecat_project = ?
       AND environment = ? AND provider_event_id = ?`,
  );
  for (const row of rows) {
    const scope = rowScope(row);
    const event = JSON.parse(row.event_json as string) as SubscriptionEvent;
    update.run(
      eventIntegrity(scope, event),
      scope.organizationId,
      scope.ventureId,
      scope.revenueCatProject,
      scope.environment,
      row.provider_event_id,
    );
  }
}

function migrateSubscriptionScope(db: SqliteDatabase, options: LegacyAdoptionOptions): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subscription_events'")
    .get() as { name: string } | undefined;
  if (!table) {
    db.exec(SUBSCRIPTION_SCHEMA);
    return;
  }
  const columns = db.prepare("PRAGMA table_info(subscription_events)").all() as Array<{
    name: string;
  }>;
  if (columns.some(({ name }) => name === "organization_id")) {
    const sentinelRows = db
      .prepare("SELECT * FROM subscription_events WHERE organization_id = ?")
      .all(LEGACY_UNSCOPED_ORGANIZATION_ID) as Record<string, unknown>[];
    const adoption = resolveLegacyTenantAdoptions(
      sentinelRows.map((row) => row.venture_id as string),
      options.legacyAdoption,
      "subscription event store",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      ensureSubscriptionIntegrity(db);
      if (sentinelRows.length > 0) {
        insertAdoptedSubscriptionRows(db, sentinelRows, adoption);
        db.prepare("DELETE FROM subscription_events WHERE organization_id = ?").run(
          LEGACY_UNSCOPED_ORGANIZATION_ID,
        );
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
    return;
  }
  const legacyRows = db.prepare("SELECT * FROM subscription_events").all() as Record<
    string,
    unknown
  >[];
  const requiredLegacyVentureIds =
    legacyRows.length > 0
      ? legacyRows.map((row) => row.venture_id as string)
      : (options.legacyAdoption?.mappings.map((entry) => entry.legacyVentureId) ?? [
          "empty-legacy-subscription-schema",
        ]);
  const adoption = resolveLegacyTenantAdoptions(
    requiredLegacyVentureIds,
    options.legacyAdoption,
    "subscription event store",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DROP INDEX IF EXISTS subscription_events_ordered");
    db.exec("ALTER TABLE subscription_events RENAME TO subscription_events_legacy_unscoped");
    db.exec(SUBSCRIPTION_SCHEMA);
    insertAdoptedSubscriptionRows(db, legacyRows, adoption);
    db.exec("DROP TABLE subscription_events_legacy_unscoped");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function createSqliteSubscriptionEventStore(
  filename: string,
  options: LegacyAdoptionOptions = {},
): SubscriptionEventStore {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA busy_timeout = 5000");
  const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  if (journal.journal_mode.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode = WAL");
  try {
    migrateSubscriptionScope(db, options);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    label: "sqlite",
    durable: true,
    append(scope, event) {
      assertAddressableTenantScope(scope, "subscription event store");
      db.exec("BEGIN IMMEDIATE");
      try {
        const prior = db
          .prepare(
            `SELECT event_json, content_hash FROM subscription_events
             WHERE organization_id = ? AND venture_id = ?
               AND revenuecat_project = ? AND environment = ?
               AND provider_event_id = ?`,
          )
          .get(
            scope.organizationId,
            scope.ventureId,
            scope.revenueCatProject,
            scope.environment,
            event.providerEventId,
          ) as { event_json: string; content_hash: string } | undefined;
        if (prior) {
          const priorEvent = JSON.parse(prior.event_json) as SubscriptionEvent;
          if (prior.content_hash !== eventIntegrity(scope, priorEvent)) {
            throw new Error("stored subscription event failed its tenant-bound integrity check");
          }
          db.exec("COMMIT");
          return sameProviderEvent(priorEvent, event) ? "duplicate" : "idempotency_conflict";
        }
        const scoped = db
          .prepare(
            `SELECT event_json, content_hash FROM subscription_events
             WHERE organization_id = ? AND venture_id = ?
               AND revenuecat_project = ? AND environment = ?`,
          )
          .all(
            scope.organizationId,
            scope.ventureId,
            scope.revenueCatProject,
            scope.environment,
          ) as Array<{ event_json: string; content_hash: string }>;
        const scopedEvents = scoped.map((row) => {
          const stored = JSON.parse(row.event_json) as SubscriptionEvent;
          if (row.content_hash !== eventIntegrity(scope, stored)) {
            throw new Error("stored subscription event failed its tenant-bound integrity check");
          }
          return stored;
        });
        if (createsLinkedCurrencyConflict(scopedEvents, event)) {
          db.exec("COMMIT");
          return "currency_conflict";
        }
        db.prepare(
          `INSERT INTO subscription_events
           (organization_id, venture_id, revenuecat_project, environment, provider_event_id,
            event_json, content_hash, occurred_at, received_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(
          scope.organizationId,
          scope.ventureId,
          scope.revenueCatProject,
          scope.environment,
          event.providerEventId,
          JSON.stringify(event),
          eventIntegrity(scope, event),
          event.occurredAt,
          event.receivedAt,
        );
        db.exec("COMMIT");
        return "accepted";
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    has(scope, providerEventId) {
      assertAddressableTenantScope(scope, "subscription event store");
      return Boolean(
        db
          .prepare(
            `SELECT 1 FROM subscription_events
             WHERE organization_id = ? AND venture_id = ?
               AND revenuecat_project = ? AND environment = ?
               AND provider_event_id = ?`,
          )
          .get(
            scope.organizationId,
            scope.ventureId,
            scope.revenueCatProject,
            scope.environment,
            providerEventId,
          ),
      );
    },
    list(scope) {
      assertAddressableTenantScope(scope, "subscription event store");
      const rows = db
        .prepare(
          `SELECT event_json, content_hash FROM subscription_events
           WHERE organization_id = ? AND venture_id = ?
             AND revenuecat_project = ? AND environment = ?
           ORDER BY occurred_at, provider_event_id`,
        )
        .all(
          scope.organizationId,
          scope.ventureId,
          scope.revenueCatProject,
          scope.environment,
        ) as Array<{ event_json: string; content_hash: string }>;
      return Object.freeze(
        rows.map((row) => {
          const event = JSON.parse(row.event_json) as SubscriptionEvent;
          if (row.content_hash !== eventIntegrity(scope, event)) {
            throw new Error("stored subscription event failed its tenant-bound integrity check");
          }
          return Object.freeze(event);
        }),
      );
    },
    close() {
      db.close();
    },
  };
}
