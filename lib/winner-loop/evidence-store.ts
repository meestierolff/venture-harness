import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  LEGACY_UNSCOPED_ORGANIZATION_ID,
  adoptLegacyTenantPayload,
  assertAddressableTenantScope,
  assertLegacyTenantAdoptionJournalCompatibility,
  recordLegacyTenantAdoptions,
  type LegacyAdoptionOptions,
} from "./legacy-adoption";

export type WinnerLoopEvidenceKind =
  "metric_snapshot" | "baseline_evidence" | "winner_evaluation" | "attribution";

export interface WinnerLoopEvidenceRecord<T = unknown> {
  organizationId: string;
  ventureId: string;
  kind: WinnerLoopEvidenceKind;
  recordId: string;
  creativeId: string | null;
  occurredAt: string;
  sourceRefs: readonly string[];
  payload: T;
}

export interface WinnerLoopEvidenceScope {
  readonly organizationId: string;
  readonly ventureId: string;
}

export interface WinnerLoopEvidenceStore {
  readonly label: string;
  readonly durable: boolean;
  put(record: WinnerLoopEvidenceRecord): void;
  get(
    scope: WinnerLoopEvidenceScope,
    kind: WinnerLoopEvidenceKind,
    recordId: string,
  ): WinnerLoopEvidenceRecord | undefined;
  list(
    scope: WinnerLoopEvidenceScope,
    kind: WinnerLoopEvidenceKind,
    creativeId?: string,
  ): readonly WinnerLoopEvidenceRecord[];
  close(): void;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function freezeRecord(record: WinnerLoopEvidenceRecord): WinnerLoopEvidenceRecord {
  const payload = structuredClone(record.payload);
  return Object.freeze({
    ...record,
    sourceRefs: Object.freeze([...record.sourceRefs]),
    payload: deepFreeze(payload),
  });
}

function fingerprint(record: WinnerLoopEvidenceRecord): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function assertEvidenceScope(scope: WinnerLoopEvidenceScope): void {
  assertAddressableTenantScope(scope, "Winner Loop evidence");
}

export function createMemoryWinnerLoopEvidenceStore(): WinnerLoopEvidenceStore {
  const records = new Map<string, WinnerLoopEvidenceRecord>();
  const key = (scope: WinnerLoopEvidenceScope, kind: WinnerLoopEvidenceKind, id: string) => {
    assertEvidenceScope(scope);
    return JSON.stringify([scope.organizationId, scope.ventureId, kind, id]);
  };
  return {
    label: "memory (test only)",
    durable: false,
    put(record) {
      const scope = { organizationId: record.organizationId, ventureId: record.ventureId };
      const storageKey = key(scope, record.kind, record.recordId);
      const current = records.get(storageKey);
      if (current && fingerprint(current) !== fingerprint(record)) {
        throw new Error(`evidence id is already bound to different content: ${record.recordId}`);
      }
      records.set(storageKey, freezeRecord(record));
    },
    get: (scope, kind, id) => records.get(key(scope, kind, id)),
    list(scope, kind, creativeId) {
      assertEvidenceScope(scope);
      return Object.freeze(
        [...records.values()].filter(
          (entry) =>
            entry.organizationId === scope.organizationId &&
            entry.ventureId === scope.ventureId &&
            entry.kind === kind &&
            (creativeId === undefined || entry.creativeId === creativeId),
        ),
      );
    },
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
    throw new Error(`Winner Loop evidence SQLite store unavailable: ${(error as Error).message}`);
  }
}

const EVIDENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS winner_loop_evidence (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  creative_id TEXT,
  occurred_at TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, kind, record_id)
);
CREATE INDEX IF NOT EXISTS winner_loop_evidence_creative
  ON winner_loop_evidence(organization_id, venture_id, kind, creative_id, occurred_at, record_id);
`;

function adoptedEvidenceRecord(
  row: Record<string, unknown>,
  target: WinnerLoopEvidenceScope,
): WinnerLoopEvidenceRecord {
  return {
    organizationId: target.organizationId,
    ventureId: target.ventureId,
    kind: row.kind as WinnerLoopEvidenceKind,
    recordId: row.record_id as string,
    creativeId: (row.creative_id as string | null) ?? null,
    occurredAt: row.occurred_at as string,
    sourceRefs: JSON.parse(row.source_refs_json as string) as string[],
    payload: adoptLegacyTenantPayload(JSON.parse(row.payload_json as string) as unknown, target),
  };
}

function insertAdoptedEvidence(
  db: SqliteDatabase,
  rows: readonly Record<string, unknown>[],
  adoption: ReadonlyMap<string, WinnerLoopEvidenceScope>,
): void {
  const insert = db.prepare(
    `INSERT INTO winner_loop_evidence (
      organization_id, venture_id, kind, record_id, creative_id, occurred_at,
      source_refs_json, payload_json, content_hash
    ) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const row of rows) {
    const target = adoption.get(row.venture_id as string)!;
    const record = adoptedEvidenceRecord(row, target);
    insert.run(
      record.organizationId,
      record.ventureId,
      record.kind,
      record.recordId,
      record.creativeId,
      record.occurredAt,
      JSON.stringify(record.sourceRefs),
      JSON.stringify(record.payload),
      fingerprint(record),
    );
  }
}

function migrateLegacyEvidence(db: SqliteDatabase, options: LegacyAdoptionOptions): void {
  assertLegacyTenantAdoptionJournalCompatibility(
    db,
    options.legacyAdoption,
    "Winner Loop evidence store",
  );
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'winner_loop_evidence'")
    .get();
  if (!exists) return;
  const hasOrganization = (
    db.prepare("PRAGMA table_info(winner_loop_evidence)").all() as Record<string, unknown>[]
  ).some((entry) => entry.name === "organization_id");
  if (hasOrganization) {
    const sentinelRows = db
      .prepare("SELECT * FROM winner_loop_evidence WHERE organization_id = ?")
      .all(LEGACY_UNSCOPED_ORGANIZATION_ID) as Record<string, unknown>[];
    if (sentinelRows.length === 0) return;
    try {
      db.exec("BEGIN IMMEDIATE");
      const resolution = recordLegacyTenantAdoptions(
        db,
        sentinelRows.map((row) => row.venture_id as string),
        options.legacyAdoption,
        "Winner Loop evidence store",
      );
      insertAdoptedEvidence(db, sentinelRows, resolution.targets);
      db.prepare("DELETE FROM winner_loop_evidence WHERE organization_id = ?").run(
        LEGACY_UNSCOPED_ORGANIZATION_ID,
      );
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
  const legacyRows = db.prepare("SELECT * FROM winner_loop_evidence").all() as Record<
    string,
    unknown
  >[];
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE winner_loop_evidence RENAME TO winner_loop_evidence_legacy_unscoped;
      DROP INDEX IF EXISTS winner_loop_evidence_creative;
      ${EVIDENCE_SCHEMA}
    `);
    if (legacyRows.length > 0) {
      const resolution = recordLegacyTenantAdoptions(
        db,
        legacyRows.map((row) => row.venture_id as string),
        options.legacyAdoption,
        "Winner Loop evidence store",
      );
      insertAdoptedEvidence(db, legacyRows, resolution.targets);
    }
    db.exec("DROP TABLE winner_loop_evidence_legacy_unscoped; COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* transaction already closed */
    }
    throw error;
  }
}

export function createSqliteWinnerLoopEvidenceStore(
  filename: string,
  options: LegacyAdoptionOptions = {},
): WinnerLoopEvidenceStore {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    if (journal.journal_mode.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode = WAL");
    migrateLegacyEvidence(db, options);
    db.exec(EVIDENCE_SCHEMA);
  } catch (error) {
    db.close();
    throw error;
  }
  const parse = (row: Record<string, unknown>): WinnerLoopEvidenceRecord =>
    freezeRecord({
      organizationId: row.organization_id as string,
      ventureId: row.venture_id as string,
      kind: row.kind as WinnerLoopEvidenceKind,
      recordId: row.record_id as string,
      creativeId: (row.creative_id as string | null) ?? null,
      occurredAt: row.occurred_at as string,
      sourceRefs: JSON.parse(row.source_refs_json as string) as string[],
      payload: JSON.parse(row.payload_json as string) as unknown,
    });
  return {
    label: "sqlite",
    durable: true,
    put(record) {
      const scope = { organizationId: record.organizationId, ventureId: record.ventureId };
      assertEvidenceScope(scope);
      const hash = fingerprint(record);
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO winner_loop_evidence
           (organization_id, venture_id, kind, record_id, creative_id, occurred_at,
            source_refs_json, payload_json, content_hash)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          record.organizationId,
          record.ventureId,
          record.kind,
          record.recordId,
          record.creativeId,
          record.occurredAt,
          JSON.stringify(record.sourceRefs),
          JSON.stringify(record.payload),
          hash,
        );
      if (result.changes === 0) {
        const existing = db
          .prepare(
            `SELECT content_hash FROM winner_loop_evidence
             WHERE organization_id = ? AND venture_id = ? AND kind = ? AND record_id = ?`,
          )
          .get(record.organizationId, record.ventureId, record.kind, record.recordId) as {
          content_hash: string;
        };
        if (existing.content_hash !== hash) {
          throw new Error(`evidence id is already bound to different content: ${record.recordId}`);
        }
      }
    },
    get(scope, kind, recordId) {
      assertEvidenceScope(scope);
      const row = db
        .prepare(
          `SELECT * FROM winner_loop_evidence
           WHERE organization_id = ? AND venture_id = ? AND kind = ? AND record_id = ?`,
        )
        .get(scope.organizationId, scope.ventureId, kind, recordId) as
        Record<string, unknown> | undefined;
      return row ? parse(row) : undefined;
    },
    list(scope, kind, creativeId) {
      assertEvidenceScope(scope);
      const rows = (
        creativeId === undefined
          ? db
              .prepare(
                `SELECT * FROM winner_loop_evidence
                 WHERE organization_id = ? AND venture_id = ? AND kind = ?
                 ORDER BY occurred_at, record_id`,
              )
              .all(scope.organizationId, scope.ventureId, kind)
          : db
              .prepare(
                `SELECT * FROM winner_loop_evidence
                 WHERE organization_id = ? AND venture_id = ? AND kind = ? AND creative_id = ?
                 ORDER BY occurred_at, record_id`,
              )
              .all(scope.organizationId, scope.ventureId, kind, creativeId)
      ) as Record<string, unknown>[];
      return Object.freeze(rows.map(parse));
    },
    close() {
      db.close();
    },
  };
}
