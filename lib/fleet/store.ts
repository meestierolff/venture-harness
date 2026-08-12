import { createRequire } from "node:module";
import { initializeSqliteWal } from "@venture-harness/core";
import { fleetTargetIdentity, fleetTargetKey } from "./identity";
import type { FleetRunRecord, FleetStateStore } from "./types";

interface Statement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

function sqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: string; errcode?: number };
  return (
    candidate.code === "ERR_SQLITE_BUSY" ||
    candidate.errcode === 5 ||
    /database is (?:locked|busy)/i.test(candidate.message)
  );
}

function execWithBusyRetry(database: Database, sql: string, timeoutMs = 5_000): void {
  const deadline = Date.now() + timeoutMs;
  let delayMs = 5;
  for (;;) {
    try {
      database.exec(sql);
      return;
    } catch (error) {
      if (!sqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      delayMs = Math.min(delayMs * 2, 100);
    }
  }
}

function canonicalLeaseTargets(targets: Parameters<FleetStateStore["acquireLease"]>[0]["targets"]) {
  const canonical = targets
    .map(fleetTargetIdentity)
    .sort((left, right) => fleetTargetKey(left).localeCompare(fleetTargetKey(right)));
  const keys = canonical.map(fleetTargetKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error("fleet run lease targets must be unique by organization and venture");
  }
  return canonical;
}

function sameLeaseTargets(
  left: readonly { organizationId: string; ventureId: string }[],
  right: readonly { organizationId: string; ventureId: string }[],
): boolean {
  return (
    left.length === right.length &&
    left.every((target, index) => fleetTargetKey(target) === fleetTargetKey(right[index]!))
  );
}

export function createMemoryFleetStateStore(): FleetStateStore {
  const records = new Map<string, FleetRunRecord>();
  return {
    get: (runId) => {
      const record = records.get(runId);
      return record ? structuredClone(record) : null;
    },
    put(record, leaseOwnerId) {
      const prior = records.get(record.runId);
      if (prior && prior.releaseDigest !== record.releaseDigest) {
        throw new Error("fleet run ID is already bound to another release");
      }
      if (prior && prior.selectionDigest !== record.selectionDigest) {
        throw new Error("fleet run ID is already bound to another tenant selection");
      }
      if (!leaseOwnerId) {
        if (!prior) records.set(record.runId, structuredClone(record));
        return;
      }
      if (
        leaseOwnerId &&
        (prior?.lease?.ownerId !== leaseOwnerId ||
          prior.lease.selectionDigest !== prior.selectionDigest)
      ) {
        throw new Error("fleet run lease is not held by this controller");
      }
      records.set(record.runId, structuredClone(record));
    },
    acquireLease(input) {
      const targets = canonicalLeaseTargets(input.targets);
      const record = records.get(input.runId);
      if (!record) throw new Error("fleet run must exist before acquiring a lease");
      if (record.releaseDigest !== input.releaseDigest) {
        throw new Error("fleet run ID is already bound to another release");
      }
      if (record.selectionDigest !== input.selectionDigest) {
        throw new Error("fleet run lease is bound to another tenant selection");
      }
      const active = record.lease && new Date(record.lease.expiresAt) > new Date(input.acquiredAt);
      if (
        active &&
        (record.lease?.ownerId !== input.ownerId ||
          record.lease.selectionDigest !== input.selectionDigest ||
          !sameLeaseTargets(record.lease.targets, targets))
      )
        return null;
      const leased = structuredClone({
        ...record,
        lease: {
          ownerId: input.ownerId,
          selectionDigest: input.selectionDigest,
          targets,
          acquiredAt: input.acquiredAt,
          expiresAt: input.expiresAt,
        },
      });
      records.set(input.runId, leased);
      return structuredClone(leased);
    },
    close: () => undefined,
  };
}

export function createSqliteFleetStateStore(filename: string): FleetStateStore {
  if (
    !filename.trim() ||
    filename === ":memory:" ||
    /^file:.*(?:mode=memory|:memory:)/.test(filename)
  ) {
    throw new Error("the durable fleet state store requires a persistent SQLite file");
  }
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => Database;
  };
  const database = new DatabaseSync(filename);
  initializeSqliteWal(database, { label: "fleet state store" });
  execWithBusyRetry(
    database,
    "CREATE TABLE IF NOT EXISTS fleet_runs (run_id TEXT PRIMARY KEY, release_digest TEXT NOT NULL, record_json TEXT NOT NULL)",
  );
  return {
    get(runId) {
      const row = database
        .prepare("SELECT record_json FROM fleet_runs WHERE run_id = ?")
        .get(runId) as { record_json: string } | undefined;
      return row ? (JSON.parse(row.record_json) as FleetRunRecord) : null;
    },
    put(record, leaseOwnerId) {
      if (!leaseOwnerId) {
        database
          .prepare(
            "INSERT INTO fleet_runs (run_id, release_digest, record_json) VALUES (?,?,?) ON CONFLICT(run_id) DO NOTHING",
          )
          .run(record.runId, record.releaseDigest, JSON.stringify(record));
        const persisted = database
          .prepare("SELECT release_digest, record_json FROM fleet_runs WHERE run_id = ?")
          .get(record.runId) as { release_digest: string; record_json: string } | undefined;
        if (persisted?.release_digest !== record.releaseDigest) {
          throw new Error("fleet run ID is already bound to another release");
        }
        const persistedRecord = JSON.parse(persisted.record_json) as FleetRunRecord;
        if (persistedRecord.selectionDigest !== record.selectionDigest) {
          throw new Error("fleet run ID is already bound to another tenant selection");
        }
        return;
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        const prior = database
          .prepare("SELECT release_digest, record_json FROM fleet_runs WHERE run_id = ?")
          .get(record.runId) as { release_digest: string; record_json: string } | undefined;
        if (!prior || prior.release_digest !== record.releaseDigest) {
          throw new Error("fleet run ID is already bound to another release");
        }
        const stored = JSON.parse(prior.record_json) as FleetRunRecord;
        if (stored.selectionDigest !== record.selectionDigest) {
          throw new Error("fleet run ID is already bound to another tenant selection");
        }
        if (
          stored.lease?.ownerId !== leaseOwnerId ||
          stored.lease.selectionDigest !== stored.selectionDigest
        ) {
          throw new Error("fleet run lease is not held by this controller");
        }
        database
          .prepare("UPDATE fleet_runs SET record_json = ? WHERE run_id = ?")
          .run(JSON.stringify(record), record.runId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    acquireLease(input) {
      const targets = canonicalLeaseTargets(input.targets);
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = database
          .prepare("SELECT release_digest, record_json FROM fleet_runs WHERE run_id = ?")
          .get(input.runId) as { release_digest: string; record_json: string } | undefined;
        if (!row) throw new Error("fleet run must exist before acquiring a lease");
        if (row.release_digest !== input.releaseDigest) {
          throw new Error("fleet run ID is already bound to another release");
        }
        const record = JSON.parse(row.record_json) as FleetRunRecord;
        if (record.selectionDigest !== input.selectionDigest) {
          throw new Error("fleet run lease is bound to another tenant selection");
        }
        const active =
          record.lease && new Date(record.lease.expiresAt) > new Date(input.acquiredAt);
        if (
          active &&
          (record.lease?.ownerId !== input.ownerId ||
            record.lease.selectionDigest !== input.selectionDigest ||
            !sameLeaseTargets(record.lease.targets, targets))
        ) {
          database.exec("COMMIT");
          return null;
        }
        const leased: FleetRunRecord = {
          ...record,
          lease: {
            ownerId: input.ownerId,
            selectionDigest: input.selectionDigest,
            targets,
            acquiredAt: input.acquiredAt,
            expiresAt: input.expiresAt,
          },
        };
        database
          .prepare("UPDATE fleet_runs SET record_json = ? WHERE run_id = ?")
          .run(JSON.stringify(leased), input.runId);
        database.exec("COMMIT");
        return structuredClone(leased);
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => database.close(),
  };
}
