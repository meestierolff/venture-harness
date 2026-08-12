import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  assertNonEmpty,
  initializeSqliteWal,
  tenantKey,
  type JsonObject,
  type JsonValue,
} from "@venture-harness/core";

/**
 * Compatibility primitive for packages that only need a deterministic JSON
 * state transform. Database migrations should use SqliteMigrationRunner below.
 */
export interface TypedMigration {
  id: string;
  fromVersion: number;
  toVersion: number;
  migrate(state: JsonObject): JsonObject;
}

export function runMigrations(
  state: JsonObject,
  version: number,
  target: number,
  migrations: readonly TypedMigration[],
): JsonObject {
  let current = structuredClone(state);
  let currentVersion = version;
  while (currentVersion < target) {
    const migration = migrations.find(({ fromVersion }) => fromVersion === currentVersion);
    if (!migration || migration.toVersion <= currentVersion)
      throw new Error(`no migration from version ${currentVersion}`);
    current = migration.migrate(current);
    currentVersion = migration.toVersion;
  }
  if (currentVersion !== target)
    throw new Error(`migration chain ended at ${currentVersion}, expected ${target}`);
  return current;
}

export type MigrationStream =
  | { readonly kind: "core" }
  | { readonly kind: "pack"; readonly packId: string }
  | {
      readonly kind: "venture";
      readonly organizationId: string;
      readonly ventureId: string;
    };

export interface MigrationReference {
  readonly stream: MigrationStream;
  readonly id: string;
  /**
   * Explicit repair edge. When present, this dependency may consume only a
   * journal row whose status is `failed`, recovery mode is `forward_fix`, and
   * checksum equals this value. The repair migration still has to pass its own
   * read-back before any successor can run.
   */
  readonly acceptFailedForwardFixChecksum?: string;
}

export interface MigrationRecovery {
  /**
   * `transaction_rollback` permits retry after SQLite rolled the entire
   * attempt back. `forward_fix` makes a failed identity terminal: a new,
   * dependent migration must repair it.
   */
  readonly mode: "transaction_rollback" | "forward_fix";
  readonly note: string;
}

export interface MigrationVerification {
  readonly passed: boolean;
  readonly schemaVersion: string;
  readonly evidence: JsonValue;
}

export type MigrationSqlValue = string | number | bigint | Uint8Array | null;

export interface SqliteMigrationContext {
  readonly stream: MigrationStream;
  readonly migrationId: string;
  exec(sql: string): void;
  run(
    sql: string,
    ...params: readonly MigrationSqlValue[]
  ): { readonly changes: number; readonly lastInsertRowid: number | bigint };
  get<Row extends Record<string, unknown>>(
    sql: string,
    ...params: readonly MigrationSqlValue[]
  ): Row | undefined;
  all<Row extends Record<string, unknown>>(
    sql: string,
    ...params: readonly MigrationSqlValue[]
  ): readonly Row[];
}

export interface DurableMigration {
  readonly stream: MigrationStream;
  readonly id: string;
  readonly dependsOn?: readonly MigrationReference[];
  /**
   * Exact SQL or code-version material bound into the immutable checksum.
   * Changing executable behavior requires a new migration ID.
   */
  readonly checksumMaterial: string;
  readonly recovery: MigrationRecovery;
  apply(context: SqliteMigrationContext): void;
  verify(context: SqliteMigrationContext): MigrationVerification;
}

export type MigrationJournalStatus = "applying" | "applied" | "failed";

export interface MigrationJournalEntry {
  readonly stream: MigrationStream;
  readonly migrationId: string;
  readonly checksum: string;
  readonly status: MigrationJournalStatus;
  readonly attemptCount: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly appliedAt: string | null;
  readonly schemaVersion: string | null;
  readonly verification: JsonValue | null;
  readonly recoveryMode: MigrationRecovery["mode"];
  readonly error: string | null;
}

export interface MigrationPlanEntry {
  readonly stream: MigrationStream;
  readonly migrationId: string;
  readonly checksum: string;
  readonly dependencies: readonly MigrationReference[];
  readonly state:
    | "pending"
    | "already_applied"
    | "failed_retryable"
    | "failed_forward_fix"
    | "forward_fix_pending"
    | "repaired_by_forward_fix";
}

export interface MigrationApplyResult {
  readonly stream: MigrationStream;
  readonly migrationId: string;
  readonly checksum: string;
  readonly state: "applied" | "already_applied" | "repaired_by_forward_fix";
  readonly attemptCount: number;
  readonly schemaVersion: string;
  readonly verification: JsonValue;
}

interface SqliteStatement {
  run(...params: readonly MigrationSqlValue[]): {
    readonly changes: number;
    readonly lastInsertRowid: number | bigint;
  };
  get(...params: readonly MigrationSqlValue[]): unknown;
  all(...params: readonly MigrationSqlValue[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface JournalRow {
  stream_key: string;
  stream_kind: MigrationStream["kind"];
  stream_id: string;
  organization_id: string | null;
  venture_id: string | null;
  migration_id: string;
  checksum: string;
  status: MigrationJournalStatus;
  attempt_count: number;
  started_at: string;
  updated_at: string;
  applied_at: string | null;
  schema_version: string | null;
  verification_json: string | null;
  recovery_mode: MigrationRecovery["mode"];
  error: string | null;
}

const MIGRATION_ID = /^\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STREAM_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const JOURNAL_COLUMNS = [
  "stream_key",
  "stream_kind",
  "stream_id",
  "organization_id",
  "venture_id",
  "migration_id",
  "checksum",
  "status",
  "attempt_count",
  "started_at",
  "updated_at",
  "applied_at",
  "schema_version",
  "verification_json",
  "recovery_mode",
  "error",
] as const;

function loadSqlite(): { DatabaseSync: new (path: string) => SqliteDatabase } {
  try {
    const moduleLocation = typeof __filename === "string" ? __filename : import.meta.url;
    return createRequire(moduleLocation)("node:sqlite") as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
  } catch (error) {
    throw new Error(
      `the durable migration runner requires Node >= 22.5 (node:sqlite unavailable): ${(error as Error).message}`,
    );
  }
}

function canonicalStream(stream: MigrationStream): MigrationStream {
  if (stream.kind === "core") return { kind: "core" };
  if (stream.kind === "pack") {
    const packId = assertNonEmpty(stream.packId, "packId");
    if (packId !== stream.packId || !STREAM_ID.test(packId)) {
      throw new Error("packId must be a canonical migration stream identifier");
    }
    return { kind: "pack", packId };
  }
  tenantKey(stream);
  return {
    kind: "venture",
    organizationId: stream.organizationId,
    ventureId: stream.ventureId,
  };
}

export function migrationStreamKey(stream: MigrationStream): string {
  const canonical = canonicalStream(stream);
  if (canonical.kind === "core") return JSON.stringify(["core"]);
  if (canonical.kind === "pack") return JSON.stringify(["pack", canonical.packId]);
  return JSON.stringify(["venture", canonical.organizationId, canonical.ventureId]);
}

function streamColumns(stream: MigrationStream): {
  streamKey: string;
  streamKind: MigrationStream["kind"];
  streamId: string;
  organizationId: string | null;
  ventureId: string | null;
} {
  const canonical = canonicalStream(stream);
  if (canonical.kind === "core") {
    return {
      streamKey: migrationStreamKey(canonical),
      streamKind: "core",
      streamId: "core",
      organizationId: null,
      ventureId: null,
    };
  }
  if (canonical.kind === "pack") {
    return {
      streamKey: migrationStreamKey(canonical),
      streamKind: "pack",
      streamId: canonical.packId,
      organizationId: null,
      ventureId: null,
    };
  }
  return {
    streamKey: migrationStreamKey(canonical),
    streamKind: "venture",
    streamId: tenantKey(canonical),
    organizationId: canonical.organizationId,
    ventureId: canonical.ventureId,
  };
}

function parseStream(row: JournalRow): MigrationStream {
  if (row.stream_kind === "core") return { kind: "core" };
  if (row.stream_kind === "pack") return { kind: "pack", packId: row.stream_id };
  if (!row.organization_id || !row.venture_id) {
    throw new Error(`venture migration journal row ${row.migration_id} has no tenant identity`);
  }
  return {
    kind: "venture",
    organizationId: row.organization_id,
    ventureId: row.venture_id,
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function referenceIdentity(reference: MigrationReference): string {
  if (!MIGRATION_ID.test(reference.id)) throw new Error(`invalid migration ID: ${reference.id}`);
  return `${migrationStreamKey(reference.stream)}\u0000${reference.id}`;
}

function definitionIdentity(definition: DurableMigration): string {
  return referenceIdentity({ stream: definition.stream, id: definition.id });
}

export function migrationChecksum(definition: DurableMigration): string {
  const checksumMaterial = assertNonEmpty(definition.checksumMaterial, "checksumMaterial");
  return createHash("sha256")
    .update(
      stable({
        stream: canonicalStream(definition.stream),
        id: definition.id,
        dependsOn: [...(definition.dependsOn ?? [])]
          .map((dependency) => ({
            stream: canonicalStream(dependency.stream),
            id: dependency.id,
            acceptFailedForwardFixChecksum: dependency.acceptFailedForwardFixChecksum ?? null,
          }))
          .sort((left, right) =>
            referenceIdentity({ stream: left.stream, id: left.id }).localeCompare(
              referenceIdentity({ stream: right.stream, id: right.id }),
            ),
          ),
        checksumMaterial,
        recovery: definition.recovery,
      }),
    )
    .digest("hex");
}

function migrationNumber(id: string): number {
  if (!MIGRATION_ID.test(id)) throw new Error(`invalid migration ID: ${id}`);
  return Number(id.slice(0, 3));
}

interface OrderedMigration {
  definition: DurableMigration;
  dependencies: MigrationReference[];
}

function orderedDefinitions(definitions: readonly DurableMigration[]): OrderedMigration[] {
  const byIdentity = new Map<string, DurableMigration>();
  const byStream = new Map<string, DurableMigration[]>();
  for (const definition of definitions) {
    migrationNumber(definition.id);
    canonicalStream(definition.stream);
    assertNonEmpty(definition.recovery.note, "recovery.note");
    migrationChecksum(definition);
    const identity = definitionIdentity(definition);
    if (byIdentity.has(identity)) throw new Error(`duplicate migration identity: ${identity}`);
    byIdentity.set(identity, definition);
    const key = migrationStreamKey(definition.stream);
    const stream = byStream.get(key) ?? [];
    stream.push(definition);
    byStream.set(key, stream);
  }

  const dependencies = new Map<string, MigrationReference[]>();
  for (const stream of byStream.values()) {
    stream.sort((left, right) => {
      const numbered = migrationNumber(left.id) - migrationNumber(right.id);
      return numbered === 0 ? left.id.localeCompare(right.id) : numbered;
    });
    for (let index = 0; index < stream.length; index += 1) {
      const definition = stream[index]!;
      const explicit = [...(definition.dependsOn ?? [])];
      const prior = stream[index - 1];
      if (prior) explicit.push({ stream: prior.stream, id: prior.id });
      const unique = new Map<string, MigrationReference>();
      for (const item of explicit) {
        const identity = referenceIdentity(item);
        const previous = unique.get(identity);
        if (
          previous?.acceptFailedForwardFixChecksum &&
          item.acceptFailedForwardFixChecksum &&
          previous.acceptFailedForwardFixChecksum !== item.acceptFailedForwardFixChecksum
        ) {
          throw new Error(`migration ${definition.id} has conflicting repair checksums`);
        }
        unique.set(identity, {
          ...item,
          acceptFailedForwardFixChecksum:
            item.acceptFailedForwardFixChecksum ?? previous?.acceptFailedForwardFixChecksum,
        });
      }
      dependencies.set(definitionIdentity(definition), [...unique.values()]);
    }
  }
  for (const [identity, required] of dependencies) {
    for (const dependency of required) {
      const dependencyIdentity = referenceIdentity(dependency);
      if (
        dependency.acceptFailedForwardFixChecksum !== undefined &&
        !/^[a-f0-9]{64}$/.test(dependency.acceptFailedForwardFixChecksum)
      ) {
        throw new Error(
          `migration ${identity} has an invalid failed-forward-fix checksum for ${dependencyIdentity}`,
        );
      }
      if (!byIdentity.has(dependencyIdentity) && !dependency.acceptFailedForwardFixChecksum) {
        throw new Error(`migration ${identity} has unavailable dependency ${dependencyIdentity}`);
      }
      if (dependencyIdentity === identity) {
        throw new Error(`migration ${identity} cannot depend on itself`);
      }
    }
  }

  const streamRank = (stream: MigrationStream): number =>
    stream.kind === "core" ? 0 : stream.kind === "pack" ? 1 : 2;
  const compare = (left: DurableMigration, right: DurableMigration): number => {
    const rank = streamRank(left.stream) - streamRank(right.stream);
    if (rank !== 0) return rank;
    const stream = migrationStreamKey(left.stream).localeCompare(migrationStreamKey(right.stream));
    if (stream !== 0) return stream;
    const numbered = migrationNumber(left.id) - migrationNumber(right.id);
    return numbered === 0 ? left.id.localeCompare(right.id) : numbered;
  };
  const pending = new Map(byIdentity);
  const completed = new Set<string>();
  const ordered: OrderedMigration[] = [];
  while (pending.size > 0) {
    const ready = [...pending.entries()]
      .filter(([identity]) =>
        (dependencies.get(identity) ?? []).every(
          (dependency) =>
            !byIdentity.has(referenceIdentity(dependency)) ||
            completed.has(referenceIdentity(dependency)),
        ),
      )
      .map(([, definition]) => definition)
      .sort(compare);
    if (ready.length === 0) {
      throw new Error(`migration dependency cycle: ${[...pending.keys()].sort().join(", ")}`);
    }
    for (const definition of ready) {
      const identity = definitionIdentity(definition);
      pending.delete(identity);
      completed.add(identity);
      ordered.push({ definition, dependencies: dependencies.get(identity) ?? [] });
    }
  }
  return ordered;
}

function forwardFixConsumers(
  ordered: readonly OrderedMigration[],
): Map<string, Array<{ definition: DurableMigration; dependency: MigrationReference }>> {
  const consumers = new Map<
    string,
    Array<{ definition: DurableMigration; dependency: MigrationReference }>
  >();
  for (const { definition, dependencies } of ordered) {
    for (const dependency of dependencies) {
      if (!dependency.acceptFailedForwardFixChecksum) continue;
      const identity = referenceIdentity(dependency);
      const existing = consumers.get(identity) ?? [];
      existing.push({ definition, dependency });
      consumers.set(identity, existing);
    }
  }
  return consumers;
}

function acceptsFailedForwardFix(
  dependency: MigrationReference,
  row: JournalRow | undefined,
): row is JournalRow {
  return (
    row?.status === "failed" &&
    row.recovery_mode === "forward_fix" &&
    dependency.acceptFailedForwardFixChecksum === row.checksum
  );
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown migration failure";
  return message
    .replace(/(gh[pousr]_|sk_(?:live|test)_|xox[baprs]-)[A-Za-z0-9_-]+/g, "$1[REDACTED]")
    .slice(0, 2_000);
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

function execWithBusyRetry(database: SqliteDatabase, sql: string, timeoutMs = 5_000): void {
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

function assertVerification(
  migrationId: string,
  verification: MigrationVerification,
): MigrationVerification {
  if (!verification.passed) throw new Error(`migration ${migrationId} schema read-back failed`);
  assertNonEmpty(verification.schemaVersion, "verification.schemaVersion");
  JSON.stringify(verification.evidence);
  return structuredClone(verification);
}

function assertAtomicMigrationSql(sql: string): string {
  const statement = assertNonEmpty(sql, "migration SQL");
  const withoutComments = statement.replace(/--[^\n\r]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  if (
    /(?:^|;)\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|VACUUM)\b/im.test(
      withoutComments,
    ) ||
    /(?:^|;)\s*PRAGMA\s+(?:journal_mode|locking_mode|wal_checkpoint|synchronous)\b/im.test(
      withoutComments,
    )
  ) {
    throw new Error(
      "migration SQL cannot control transactions, attach databases, or change journal durability",
    );
  }
  return statement;
}

function journalEntry(row: JournalRow): MigrationJournalEntry {
  return {
    stream: parseStream(row),
    migrationId: row.migration_id,
    checksum: row.checksum,
    status: row.status,
    attemptCount: row.attempt_count,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
    schemaVersion: row.schema_version,
    verification: row.verification_json ? (JSON.parse(row.verification_json) as JsonValue) : null,
    recoveryMode: row.recovery_mode,
    error: row.error,
  };
}

export class SqliteMigrationRunner {
  readonly #database: SqliteDatabase;
  readonly #now: () => Date;

  constructor(filename: string, options: { readonly now?: () => Date } = {}) {
    const path = assertNonEmpty(filename, "filename");
    if (path === ":memory:" || /^file:.*(?:mode=memory|:memory:)/.test(path)) {
      throw new Error("the durable migration runner requires a persistent SQLite file");
    }
    const { DatabaseSync } = loadSqlite();
    this.#database = new DatabaseSync(path);
    this.#now = options.now ?? (() => new Date());
    initializeSqliteWal(this.#database, { label: "migration runner" });
    execWithBusyRetry(
      this.#database,
      `
      CREATE TABLE IF NOT EXISTS vh_migration_journal (
        stream_key TEXT NOT NULL,
        stream_kind TEXT NOT NULL CHECK (stream_kind IN ('core','pack','venture')),
        stream_id TEXT NOT NULL,
        organization_id TEXT,
        venture_id TEXT,
        migration_id TEXT NOT NULL,
        checksum TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('applying','applied','failed')),
        attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        applied_at TEXT,
        schema_version TEXT,
        verification_json TEXT,
        recovery_mode TEXT NOT NULL CHECK (recovery_mode IN ('transaction_rollback','forward_fix')),
        error TEXT,
        PRIMARY KEY (stream_key, migration_id),
        CHECK (
          (stream_kind = 'venture' AND organization_id IS NOT NULL AND venture_id IS NOT NULL)
          OR (stream_kind != 'venture' AND organization_id IS NULL AND venture_id IS NULL)
        )
      ) STRICT
    `,
    );
    const columns = this.#database
      .prepare("PRAGMA table_info(vh_migration_journal)")
      .all() as Array<{ name: string }>;
    const observed = new Set(columns.map(({ name }) => name));
    for (const column of JOURNAL_COLUMNS) {
      if (!observed.has(column)) {
        this.#database.close();
        throw new Error(`migration journal schema read-back is missing ${column}`);
      }
    }
  }

  #context(definition: DurableMigration): SqliteMigrationContext {
    return {
      stream: canonicalStream(definition.stream),
      migrationId: definition.id,
      exec: (sql) => this.#database.exec(assertAtomicMigrationSql(sql)),
      run: (sql, ...params) => this.#database.prepare(assertAtomicMigrationSql(sql)).run(...params),
      get: <Row extends Record<string, unknown>>(
        sql: string,
        ...params: readonly MigrationSqlValue[]
      ) => this.#database.prepare(assertAtomicMigrationSql(sql)).get(...params) as Row | undefined,
      all: <Row extends Record<string, unknown>>(
        sql: string,
        ...params: readonly MigrationSqlValue[]
      ) => this.#database.prepare(assertAtomicMigrationSql(sql)).all(...params) as Row[],
    };
  }

  #row(stream: MigrationStream, migrationId: string): JournalRow | undefined {
    return this.#database
      .prepare("SELECT * FROM vh_migration_journal WHERE stream_key = ? AND migration_id = ?")
      .get(migrationStreamKey(stream), migrationId) as JournalRow | undefined;
  }

  #assertChecksum(definition: DurableMigration, row: JournalRow | undefined): void {
    if (row && row.checksum !== migrationChecksum(definition)) {
      throw new Error(
        `migration checksum mismatch for ${migrationStreamKey(definition.stream)}:${definition.id}; published migrations are immutable`,
      );
    }
  }

  plan(definitions: readonly DurableMigration[]): readonly MigrationPlanEntry[] {
    const ordered = orderedDefinitions(definitions);
    const consumers = forwardFixConsumers(ordered);
    return ordered.map(({ definition, dependencies }) => {
      const checksum = migrationChecksum(definition);
      const row = this.#row(definition.stream, definition.id);
      this.#assertChecksum(definition, row);
      for (const dependency of dependencies) {
        const dependencyRow = this.#row(dependency.stream, dependency.id);
        if (
          dependency.acceptFailedForwardFixChecksum &&
          dependencyRow?.status === "failed" &&
          !acceptsFailedForwardFix(dependency, dependencyRow)
        ) {
          throw new Error(
            `forward-fix checksum mismatch for dependency ${dependency.id}; repair authorization is immutable`,
          );
        }
      }
      const repairs = consumers
        .get(definitionIdentity(definition))
        ?.filter(({ dependency }) => acceptsFailedForwardFix(dependency, row));
      const repaired = repairs?.some(
        ({ definition: repair }) => this.#row(repair.stream, repair.id)?.status === "applied",
      );
      return {
        stream: canonicalStream(definition.stream),
        migrationId: definition.id,
        checksum,
        dependencies,
        state:
          row?.status === "applied"
            ? "already_applied"
            : row?.status === "failed" && definition.recovery.mode === "forward_fix"
              ? repaired
                ? "repaired_by_forward_fix"
                : repairs?.length
                  ? "forward_fix_pending"
                  : "failed_forward_fix"
              : row?.status === "failed"
                ? "failed_retryable"
                : "pending",
      };
    });
  }

  apply(definitions: readonly DurableMigration[]): readonly MigrationApplyResult[] {
    const ordered = orderedDefinitions(definitions);
    const consumers = forwardFixConsumers(ordered);
    const results = new Map<string, MigrationApplyResult>();
    const skipped = new Map<string, { definition: DurableMigration; row: JournalRow }>();
    for (const { definition, dependencies } of ordered) {
      const identity = definitionIdentity(definition);
      const existing = this.#row(definition.stream, definition.id);
      this.#assertChecksum(definition, existing);
      const authorizedRepair = consumers
        .get(identity)
        ?.some(({ dependency }) => acceptsFailedForwardFix(dependency, existing));
      if (
        existing?.status === "failed" &&
        existing.recovery_mode === "forward_fix" &&
        authorizedRepair
      ) {
        skipped.set(identity, { definition, row: existing });
        continue;
      }
      for (const dependency of dependencies) {
        const dependencyRow = this.#row(dependency.stream, dependency.id);
        if (
          dependencyRow?.status !== "applied" &&
          !acceptsFailedForwardFix(dependency, dependencyRow)
        ) {
          throw new Error(
            `migration ${definition.id} dependency ${dependency.id} is not durably applied`,
          );
        }
      }
      try {
        results.set(identity, this.#applyOne(definition));
      } catch (error) {
        const failed = this.#row(definition.stream, definition.id);
        const repairAfterFailure = consumers
          .get(identity)
          ?.some(({ dependency }) => acceptsFailedForwardFix(dependency, failed));
        if (
          failed?.status === "failed" &&
          failed.recovery_mode === "forward_fix" &&
          repairAfterFailure
        ) {
          skipped.set(identity, { definition, row: failed });
          continue;
        }
        throw error;
      }
    }

    for (const [identity, failed] of [...skipped.entries()].reverse()) {
      const repair = consumers.get(identity)?.find(({ definition }) => {
        const repairResult = results.get(definitionIdentity(definition));
        return (
          repairResult?.state === "applied" ||
          repairResult?.state === "already_applied" ||
          repairResult?.state === "repaired_by_forward_fix"
        );
      });
      if (!repair) {
        throw new Error(
          `migration ${failed.definition.id} remains failed_forward_fix because no authorized repair passed read-back`,
        );
      }
      const repairResult = results.get(definitionIdentity(repair.definition))!;
      results.set(identity, {
        stream: canonicalStream(failed.definition.stream),
        migrationId: failed.definition.id,
        checksum: failed.row.checksum,
        state: "repaired_by_forward_fix",
        attemptCount: failed.row.attempt_count,
        schemaVersion: repairResult.schemaVersion,
        verification: {
          failed_migration_checksum: failed.row.checksum,
          repaired_by: {
            stream_key: migrationStreamKey(repair.definition.stream),
            migration_id: repair.definition.id,
            checksum: repairResult.checksum,
          },
          repair_verification: repairResult.verification,
        },
      });
    }
    return ordered.map(({ definition }) => results.get(definitionIdentity(definition))!);
  }

  #applyOne(definition: DurableMigration): MigrationApplyResult {
    const checksum = migrationChecksum(definition);
    let prior = this.#row(definition.stream, definition.id);
    this.#assertChecksum(definition, prior);
    const context = this.#context(definition);
    if (prior?.status === "applied") {
      const verification = assertVerification(definition.id, definition.verify(context));
      return {
        stream: canonicalStream(definition.stream),
        migrationId: definition.id,
        checksum,
        state: "already_applied",
        attemptCount: prior.attempt_count,
        schemaVersion: verification.schemaVersion,
        verification: verification.evidence,
      };
    }
    if (prior?.status === "failed" && definition.recovery.mode === "forward_fix") {
      throw new Error(
        `migration ${definition.id} is failed_forward_fix; add a new dependent repair migration`,
      );
    }

    let transactionOpen = false;
    let attemptStarted = false;
    let attemptCount = (prior?.attempt_count ?? 0) + 1;
    const startedAt = this.#now().toISOString();
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      prior = this.#row(definition.stream, definition.id);
      this.#assertChecksum(definition, prior);
      attemptCount = (prior?.attempt_count ?? 0) + 1;
      if (prior?.status === "applied") {
        const verification = assertVerification(definition.id, definition.verify(context));
        this.#database.exec("COMMIT");
        transactionOpen = false;
        return {
          stream: canonicalStream(definition.stream),
          migrationId: definition.id,
          checksum,
          state: "already_applied",
          attemptCount: prior.attempt_count,
          schemaVersion: verification.schemaVersion,
          verification: verification.evidence,
        };
      }
      if (prior?.status === "failed" && definition.recovery.mode === "forward_fix") {
        throw new Error(
          `migration ${definition.id} is failed_forward_fix; add a new dependent repair migration`,
        );
      }
      if (prior?.status === "applying") {
        const verification = assertVerification(definition.id, definition.verify(context));
        const updatedAt = this.#now().toISOString();
        this.#database
          .prepare(
            `UPDATE vh_migration_journal
             SET status = 'applied', updated_at = ?, applied_at = ?, schema_version = ?,
                 verification_json = ?, error = NULL
             WHERE stream_key = ? AND migration_id = ?`,
          )
          .run(
            updatedAt,
            updatedAt,
            verification.schemaVersion,
            JSON.stringify(verification.evidence),
            migrationStreamKey(definition.stream),
            definition.id,
          );
        this.#database.exec("COMMIT");
        transactionOpen = false;
        return {
          stream: canonicalStream(definition.stream),
          migrationId: definition.id,
          checksum,
          state: "already_applied",
          attemptCount: prior.attempt_count,
          schemaVersion: verification.schemaVersion,
          verification: verification.evidence,
        };
      }

      const columns = streamColumns(definition.stream);
      this.#database
        .prepare(
          `INSERT INTO vh_migration_journal (
             stream_key, stream_kind, stream_id, organization_id, venture_id,
             migration_id, checksum, status, attempt_count, started_at, updated_at,
             applied_at, schema_version, verification_json, recovery_mode, error
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'applying', ?, ?, ?, NULL, NULL, NULL, ?, NULL)
           ON CONFLICT(stream_key, migration_id) DO UPDATE SET
             status = 'applying', attempt_count = excluded.attempt_count,
             started_at = excluded.started_at, updated_at = excluded.updated_at,
             applied_at = NULL, schema_version = NULL, verification_json = NULL, error = NULL`,
        )
        .run(
          columns.streamKey,
          columns.streamKind,
          columns.streamId,
          columns.organizationId,
          columns.ventureId,
          definition.id,
          checksum,
          attemptCount,
          startedAt,
          startedAt,
          definition.recovery.mode,
        );
      attemptStarted = true;
      const applied = definition.apply(context) as unknown;
      if (applied && typeof (applied as PromiseLike<unknown>).then === "function") {
        throw new Error(
          `migration ${definition.id} returned a promise; durable SQLite migrations must be synchronous`,
        );
      }
      const verification = assertVerification(definition.id, definition.verify(context));
      const appliedAt = this.#now().toISOString();
      this.#database
        .prepare(
          `UPDATE vh_migration_journal
           SET status = 'applied', updated_at = ?, applied_at = ?, schema_version = ?,
               verification_json = ?, error = NULL
           WHERE stream_key = ? AND migration_id = ? AND checksum = ?`,
        )
        .run(
          appliedAt,
          appliedAt,
          verification.schemaVersion,
          JSON.stringify(verification.evidence),
          columns.streamKey,
          definition.id,
          checksum,
        );
      this.#database.exec("COMMIT");
      transactionOpen = false;
      return {
        stream: canonicalStream(definition.stream),
        migrationId: definition.id,
        checksum,
        state: "applied",
        attemptCount,
        schemaVersion: verification.schemaVersion,
        verification: verification.evidence,
      };
    } catch (error) {
      if (transactionOpen) this.#database.exec("ROLLBACK");
      if (attemptStarted) {
        const columns = streamColumns(definition.stream);
        const failedAt = this.#now().toISOString();
        this.#database.exec("BEGIN IMMEDIATE");
        try {
          this.#database
            .prepare(
              `INSERT INTO vh_migration_journal (
                 stream_key, stream_kind, stream_id, organization_id, venture_id,
                 migration_id, checksum, status, attempt_count, started_at, updated_at,
                 applied_at, schema_version, verification_json, recovery_mode, error
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, NULL, NULL, NULL, ?, ?)
               ON CONFLICT(stream_key, migration_id) DO UPDATE SET
                 status = 'failed', attempt_count = excluded.attempt_count,
                 started_at = excluded.started_at, updated_at = excluded.updated_at,
                 applied_at = NULL, schema_version = NULL, verification_json = NULL,
                 recovery_mode = excluded.recovery_mode, error = excluded.error`,
            )
            .run(
              columns.streamKey,
              columns.streamKind,
              columns.streamId,
              columns.organizationId,
              columns.ventureId,
              definition.id,
              checksum,
              attemptCount,
              startedAt,
              failedAt,
              definition.recovery.mode,
              safeError(error),
            );
          this.#database.exec("COMMIT");
        } catch (journalError) {
          this.#database.exec("ROLLBACK");
          throw new AggregateError([error, journalError], "migration and journal write failed");
        }
      }
      throw error;
    }
  }

  journal(stream?: MigrationStream): readonly MigrationJournalEntry[] {
    const rows = stream
      ? (this.#database
          .prepare("SELECT * FROM vh_migration_journal WHERE stream_key = ? ORDER BY migration_id")
          .all(migrationStreamKey(stream)) as JournalRow[])
      : (this.#database
          .prepare(
            "SELECT * FROM vh_migration_journal ORDER BY stream_kind, stream_key, migration_id",
          )
          .all() as JournalRow[]);
    return rows.map(journalEntry);
  }

  close(): void {
    this.#database.close();
  }
}

export function createSqliteMigrationRunner(
  filename: string,
  options: { readonly now?: () => Date } = {},
): SqliteMigrationRunner {
  return new SqliteMigrationRunner(filename, options);
}
