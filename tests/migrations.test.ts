import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  createSqliteMigrationRunner,
  migrateV01ToV02,
  migrationChecksum,
  migrationManifestSchema,
  type DurableMigration,
  type MigrationFileSystem,
} from "@/lib/migrations";
import {
  harnessLockSchema,
  launchSchema,
  loopsSchema,
  mobileSchema,
  policiesSchema,
  providersSchema,
  ventureV02Schema,
} from "@/lib/config/schemas";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class MemoryFileSystem implements MigrationFileSystem {
  readonly files: Map<string, string>;
  readonly writes: string[] = [];
  private failOnceAt: string | null;

  constructor(initial: Record<string, string>, failOnceAt: string | null = null) {
    this.files = new Map(Object.entries(initial));
    this.failOnceAt = failOnceAt;
  }

  async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    this.writes.push(path);
    if (this.failOnceAt === path) {
      this.failOnceAt = null;
      throw new Error(`synthetic write failure at ${path}`);
    }
    this.files.set(path, content);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

const fixedClock = () => new Date("2026-08-04T12:00:00.000Z");

function legacyFiles(): Record<string, string> {
  return {
    "config/framework.yaml": stringify({
      framework: {
        name: "venture-harness",
        version: "0.1.0",
        public_template: true,
        license: "MIT",
      },
      supported_agents: ["openai-codex"],
      package_manager: "pnpm",
      generated_paths: [".agents/skills"],
      sync_excludes: { claude: [], codex: [] },
      verification: { primary: "pnpm verify" },
    }),
    "config/venture.yaml": stringify({
      venture: {
        name: "legacy-venture",
        legal_name: null,
        domain: "legacy.example",
        market: "small teams in NL",
        language: "en",
        currency: "EUR",
        timezone: "Europe/Amsterdam",
        stage: "demand_validation",
        repository_visibility: "private",
        production_status: "validation_site_live",
        custom_legacy_field: "preserve-me",
      },
      validation: {
        minimum_days: 30,
        target_days: 60,
        maximum_days: 90,
        launch_date: "2026-07-01",
        primary_conversion: "qualification_completed",
        build_threshold: "10 qualified leads",
        stop_threshold: "no qualified leads",
      },
      infrastructure: {
        domain_registered: true,
        vercel_project_created: true,
        neon_database_created: false,
        ga4_property_created: false,
        vercel_analytics_enabled: false,
        google_search_console_verified: false,
        bing_webmaster_verified: false,
      },
    }),
  };
}

describe("v0.1 to v0.2 migration", () => {
  it("migrates legacy config conservatively and writes the lock last", async () => {
    const fs = new MemoryFileSystem(legacyFiles());
    const report = await migrateV01ToV02({ fileSystem: fs, clock: fixedClock });

    expect(report.status).toBe("applied");
    expect(report.lock_updated).toBe(true);
    expect(fs.writes.at(-1)).toBe("harness.lock");

    const venture = ventureV02Schema.parse(parse(fs.files.get("config/venture.yaml")!));
    expect(venture.venture).toMatchObject({
      harness_version: "0.2.0",
      app_kind: "web",
      launch_mode: "validate_first",
      target_market: "small teams in NL",
      custom_legacy_field: "preserve-me",
    });
    expect(venture.validation.primary_conversion).toBe("qualification_completed");
    expect(venture.infrastructure.domain_registered).toBe(true);

    const providers = providersSchema.parse(parse(fs.files.get("config/providers.yaml")!));
    expect(providers.providers.dns.state).toBe("configured");
    expect(providers.providers.vercel.state).toBe("configured");
    expect(providers.providers.neon.state).toBe("unconfigured");
    expect(providers.providers.vercel.last_verified_at).toBeNull();
    expect(report.warnings.some((warning) => /configured, not verified/.test(warning))).toBe(true);

    expect(launchSchema.safeParse(parse(fs.files.get("config/launch.yaml")!)).success).toBe(true);
    expect(policiesSchema.safeParse(parse(fs.files.get("config/policies.yaml")!)).success).toBe(
      true,
    );
    expect(loopsSchema.safeParse(parse(fs.files.get("config/loops.yaml")!)).success).toBe(true);
    expect(mobileSchema.safeParse(parse(fs.files.get("config/mobile.yaml")!)).success).toBe(true);
    const lock = harnessLockSchema.parse(parse(fs.files.get("harness.lock")!));
    expect(lock).toMatchObject({
      harness_version: "0.2.0",
      applied_migrations: [{ id: "001-v0-1-to-v0-2" }],
    });
    expect(lock.managed_files).toEqual([
      {
        path: "config/framework.yaml",
        ownership: "harness",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
  });

  it("is idempotent after the v0.2 lock is committed", async () => {
    const fs = new MemoryFileSystem(legacyFiles());
    expect((await migrateV01ToV02({ fileSystem: fs, clock: fixedClock })).status).toBe("applied");
    const writesAfterFirstRun = fs.writes.length;

    const second = await migrateV01ToV02({ fileSystem: fs, clock: fixedClock });
    expect(second.status).toBe("already_current");
    expect(second.lock_updated).toBe(false);
    expect(fs.writes).toHaveLength(writesAfterFirstRun);
  });

  it("rolls back every attempted write and returns an actionable failure report", async () => {
    const initial = legacyFiles();
    const fs = new MemoryFileSystem(initial, "config/providers.yaml");
    const report = await migrateV01ToV02({ fileSystem: fs, clock: fixedClock });

    expect(report).toMatchObject({
      status: "failed",
      lock_updated: false,
      rolled_back: true,
      error: { code: "migration_write_failed" },
    });
    expect(report.error?.next_action).toMatch(/original files were restored/i);
    expect(Object.fromEntries(fs.files)).toEqual(initial);
    expect(fs.files.has("harness.lock")).toBe(false);
    expect(report.changes.some((change) => change.status === "rolled_back")).toBe(true);
  });

  it("dry-run reports changes without writing", async () => {
    const initial = legacyFiles();
    const fs = new MemoryFileSystem(initial);
    const report = await migrateV01ToV02({ fileSystem: fs, dryRun: true, clock: fixedClock });

    expect(report.status).toBe("planned");
    expect(report.lock_updated).toBe(false);
    expect(fs.writes).toEqual([]);
    expect(Object.fromEntries(fs.files)).toEqual(initial);
  });

  it("validates the committed migration manifest", () => {
    const manifest = parse(readFileSync("migrations/001-v0-1-to-v0-2.yaml", "utf8"));
    expect(migrationManifestSchema.parse(manifest)).toMatchObject({
      id: "001-v0-1-to-v0-2",
      lock_update_last: true,
    });
  });
});

const CORE_STREAM = { kind: "core" } as const;
const PACK_STREAM = { kind: "pack", packId: "winner-loop" } as const;
const VENTURE_STREAM = {
  kind: "venture",
  organizationId: "company-alpha",
  ventureId: "shared-slug",
} as const;

function migrationDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "vh-durable-migrations-"));
  temporaryDirectories.push(directory);
  return join(directory, "venture.sqlite");
}

function runMigrationProcess(fixture: string, database: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture, database], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`migration worker exited ${String(code)}: ${stderr}`));
    });
  });
}

function priorVersionDefinitions(order: string[]): readonly DurableMigration[] {
  const core: DurableMigration = {
    stream: CORE_STREAM,
    id: "001-core-v0-2",
    checksumMaterial:
      "ALTER TABLE fixture_launches ADD COLUMN launch_mode TEXT NOT NULL DEFAULT 'validate_first'; UPDATE fixture_runtime_meta SET schema_version='0.2.0'",
    recovery: {
      mode: "transaction_rollback",
      note: "SQLite rolls schema and journal changes back in the same transaction.",
    },
    apply(context) {
      order.push("core");
      context.exec(
        "ALTER TABLE fixture_launches ADD COLUMN launch_mode TEXT NOT NULL DEFAULT 'validate_first'",
      );
      context.run("UPDATE fixture_runtime_meta SET schema_version = ?", "0.2.0");
    },
    verify(context) {
      const columns = context.all<{ name: string }>("PRAGMA table_info(fixture_launches)");
      const version = context.get<{ schema_version: string }>(
        "SELECT schema_version FROM fixture_runtime_meta WHERE singleton = 1",
      );
      const passed =
        version?.schema_version === "0.2.0" && columns.some(({ name }) => name === "launch_mode");
      return {
        passed,
        schemaVersion: version?.schema_version ?? "missing",
        evidence: { launch_mode_column: passed },
      };
    },
  };
  const pack: DurableMigration = {
    stream: PACK_STREAM,
    id: "001-winner-evidence",
    dependsOn: [{ stream: CORE_STREAM, id: core.id }],
    checksumMaterial:
      "CREATE TABLE fixture_winner_evidence (evidence_id TEXT PRIMARY KEY, captured_at TEXT NOT NULL) STRICT",
    recovery: {
      mode: "transaction_rollback",
      note: "The additive pack table and its journal row share one transaction.",
    },
    apply(context) {
      order.push("pack");
      context.exec(
        "CREATE TABLE fixture_winner_evidence (evidence_id TEXT PRIMARY KEY, captured_at TEXT NOT NULL) STRICT",
      );
    },
    verify(context) {
      const table = context.get<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'fixture_winner_evidence'",
      );
      return {
        passed: table?.name === "fixture_winner_evidence",
        schemaVersion: "winner-loop@0.2.0",
        evidence: { table: table?.name ?? null },
      };
    },
  };
  const venture: DurableMigration = {
    stream: VENTURE_STREAM,
    id: "001-venture-settings",
    dependsOn: [{ stream: PACK_STREAM, id: pack.id }],
    checksumMaterial:
      "CREATE TABLE fixture_venture_settings (organization_id TEXT, venture_id TEXT, setting TEXT, PRIMARY KEY (organization_id, venture_id)) STRICT; INSERT canonical tenant",
    recovery: {
      mode: "transaction_rollback",
      note: "The tenant row is rolled back with its schema on failure.",
    },
    apply(context) {
      order.push("venture");
      context.exec(`
        CREATE TABLE fixture_venture_settings (
          organization_id TEXT NOT NULL,
          venture_id TEXT NOT NULL,
          setting TEXT NOT NULL,
          PRIMARY KEY (organization_id, venture_id)
        ) STRICT
      `);
      context.run(
        "INSERT INTO fixture_venture_settings (organization_id, venture_id, setting) VALUES (?, ?, ?)",
        VENTURE_STREAM.organizationId,
        VENTURE_STREAM.ventureId,
        "migrated-v0.2",
      );
    },
    verify(context) {
      const row = context.get<{
        organization_id: string;
        venture_id: string;
        setting: string;
      }>(
        "SELECT organization_id, venture_id, setting FROM fixture_venture_settings WHERE organization_id = ? AND venture_id = ?",
        VENTURE_STREAM.organizationId,
        VENTURE_STREAM.ventureId,
      );
      return {
        passed:
          row?.organization_id === VENTURE_STREAM.organizationId &&
          row.venture_id === VENTURE_STREAM.ventureId &&
          row.setting === "migrated-v0.2",
        schemaVersion: "venture@0.2.0",
        evidence: row ?? null,
      };
    },
  };
  return [venture, pack, core];
}

describe("durable stream-aware SQLite migrations", () => {
  it("rejects an in-memory database for the durable runner", () => {
    expect(() => createSqliteMigrationRunner(":memory:")).toThrow(/persistent SQLite file/);
  });

  it("upgrades the v0.1 fixture through ordered Core, pack, and tenant streams", () => {
    const path = migrationDatabase();
    const runner = createSqliteMigrationRunner(path, { now: fixedClock });
    runner.apply([
      {
        stream: CORE_STREAM,
        id: "000-load-v0-1-fixture",
        checksumMaterial: readFileSync("tests/fixtures/migrations/v0-1.sqlite.sql", "utf8"),
        recovery: {
          mode: "transaction_rollback",
          note: "The synthetic prior-version schema is loaded atomically.",
        },
        apply(context) {
          context.exec(readFileSync("tests/fixtures/migrations/v0-1.sqlite.sql", "utf8"));
        },
        verify(context) {
          const row = context.get<{ schema_version: string }>(
            "SELECT schema_version FROM fixture_runtime_meta WHERE singleton = 1",
          );
          return {
            passed: row?.schema_version === "0.1.0",
            schemaVersion: row?.schema_version ?? "missing",
            evidence: { prior_version_loaded: row?.schema_version === "0.1.0" },
          };
        },
      },
    ]);

    const order: string[] = [];
    const definitions = priorVersionDefinitions(order);
    const first = runner.apply(definitions);
    expect(order).toEqual(["core", "pack", "venture"]);
    expect(first.map(({ state }) => state)).toEqual(["applied", "applied", "applied"]);
    expect(
      runner.journal(CORE_STREAM).map(({ migrationId, status }) => [migrationId, status]),
    ).toEqual([
      ["000-load-v0-1-fixture", "applied"],
      ["001-core-v0-2", "applied"],
    ]);
    expect(runner.journal(PACK_STREAM)).toEqual([
      expect.objectContaining({
        stream: PACK_STREAM,
        migrationId: "001-winner-evidence",
        status: "applied",
        schemaVersion: "winner-loop@0.2.0",
      }),
    ]);
    expect(runner.journal(VENTURE_STREAM)).toEqual([
      expect.objectContaining({
        stream: VENTURE_STREAM,
        migrationId: "001-venture-settings",
        status: "applied",
        schemaVersion: "venture@0.2.0",
      }),
    ]);

    const second = runner.apply(definitions);
    expect(second.map(({ state }) => state)).toEqual([
      "already_applied",
      "already_applied",
      "already_applied",
    ]);
    expect(order).toEqual(["core", "pack", "venture"]);
    runner.close();

    const reopened = createSqliteMigrationRunner(path, { now: fixedClock });
    expect(
      reopened
        .apply(priorVersionDefinitions(order))
        .every(({ state }) => state === "already_applied"),
    ).toBe(true);
    expect(order).toEqual(["core", "pack", "venture"]);
    reopened.close();
  });

  it("rolls an interrupted attempt back, journals failure, and resumes exactly once", () => {
    const path = migrationDatabase();
    const runner = createSqliteMigrationRunner(path, { now: fixedClock });
    let interrupt = true;
    let applyCalls = 0;
    const migration: DurableMigration = {
      stream: CORE_STREAM,
      id: "001-interrupted-table",
      checksumMaterial: "CREATE TABLE interruption_proof (id TEXT PRIMARY KEY) STRICT",
      recovery: {
        mode: "transaction_rollback",
        note: "Retry is safe only because both schema and journal roll back atomically.",
      },
      apply(context) {
        applyCalls += 1;
        context.exec("CREATE TABLE interruption_proof (id TEXT PRIMARY KEY) STRICT");
        if (interrupt) {
          interrupt = false;
          throw new Error("synthetic process interruption");
        }
      },
      verify(context) {
        const table = context.get<{ name: string }>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'interruption_proof'",
        );
        return {
          passed: table?.name === "interruption_proof",
          schemaVersion: "interrupt@1",
          evidence: { table: table?.name ?? null },
        };
      },
    };

    expect(() => runner.apply([migration])).toThrow(/synthetic process interruption/);
    expect(runner.journal(CORE_STREAM)).toEqual([
      expect.objectContaining({
        status: "failed",
        attemptCount: 1,
        error: "synthetic process interruption",
      }),
    ]);
    const resumed = runner.apply([migration]);
    expect(resumed).toEqual([
      expect.objectContaining({ state: "applied", attemptCount: 2, schemaVersion: "interrupt@1" }),
    ]);
    expect(applyCalls).toBe(2);
    expect(runner.apply([migration])[0]).toMatchObject({
      state: "already_applied",
      attemptCount: 2,
    });
    expect(applyCalls).toBe(2);
    runner.close();
  });

  it("resumes after an actual process exit without preserving a partial schema or applying twice", () => {
    const path = migrationDatabase();
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/migrations/interrupted-process.ts", path],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(child.status, child.stderr).toBe(73);

    let applyCalls = 0;
    const migration: DurableMigration = {
      stream: CORE_STREAM,
      id: "001-process-crash",
      checksumMaterial: "CREATE TABLE process_crash_proof (id TEXT PRIMARY KEY) STRICT",
      recovery: {
        mode: "transaction_rollback",
        note: "The operating system closes the uncommitted SQLite transaction on process exit.",
      },
      apply(context) {
        applyCalls += 1;
        context.exec("CREATE TABLE process_crash_proof (id TEXT PRIMARY KEY) STRICT");
      },
      verify(context) {
        const table = context.get<{ name: string }>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'process_crash_proof'",
        );
        return {
          passed: table?.name === "process_crash_proof",
          schemaVersion: "process-crash@1",
          evidence: { table: table?.name ?? null },
        };
      },
    };
    const runner = createSqliteMigrationRunner(path, { now: fixedClock });
    expect(runner.journal()).toEqual([]);
    expect(runner.apply([migration])).toEqual([
      expect.objectContaining({ state: "applied", attemptCount: 1 }),
    ]);
    expect(runner.apply([migration])).toEqual([
      expect.objectContaining({ state: "already_applied", attemptCount: 1 }),
    ]);
    expect(applyCalls).toBe(1);
    runner.close();
  });

  it("applies one committed migration at most once across competing processes", async () => {
    const path = migrationDatabase();
    await Promise.all([
      runMigrationProcess("tests/fixtures/migrations/concurrent-process.ts", path),
      runMigrationProcess("tests/fixtures/migrations/concurrent-process.ts", path),
    ]);
    let applyCalls = 0;
    const migration: DurableMigration = {
      stream: CORE_STREAM,
      id: "001-concurrent-apply",
      checksumMaterial:
        "CREATE TABLE IF NOT EXISTS concurrent_apply_proof (invocation_id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT; INSERT one invocation",
      recovery: {
        mode: "transaction_rollback",
        note: "The SQLite write lock serializes competing migration owners.",
      },
      apply(context) {
        applyCalls += 1;
        context.exec(
          "CREATE TABLE IF NOT EXISTS concurrent_apply_proof (invocation_id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT",
        );
        context.run("INSERT INTO concurrent_apply_proof DEFAULT VALUES");
      },
      verify(context) {
        const row = context.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM concurrent_apply_proof",
        );
        return {
          passed: row?.count === 1,
          schemaVersion: "concurrent@1",
          evidence: { invocation_count: row?.count ?? -1 },
        };
      },
    };
    const runner = createSqliteMigrationRunner(path, { now: fixedClock });
    expect(runner.apply([migration])).toEqual([
      expect.objectContaining({
        state: "already_applied",
        attemptCount: 1,
        verification: { invocation_count: 1 },
      }),
    ]);
    expect(applyCalls).toBe(0);
    expect(runner.journal(CORE_STREAM)).toEqual([
      expect.objectContaining({ status: "applied", attemptCount: 1 }),
    ]);
    runner.close();
  });

  it("rejects immutable checksum drift and rolls back failed schema read-back", () => {
    const path = migrationDatabase();
    const runner = createSqliteMigrationRunner(path, { now: fixedClock });
    const original: DurableMigration = {
      stream: PACK_STREAM,
      id: "001-schema-proof",
      checksumMaterial: "CREATE TABLE checksum_proof (id TEXT PRIMARY KEY) STRICT",
      recovery: { mode: "transaction_rollback", note: "Atomic additive schema migration." },
      apply: (context) => context.exec("CREATE TABLE checksum_proof (id TEXT PRIMARY KEY) STRICT"),
      verify(context) {
        const table = context.get<{ name: string }>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'checksum_proof'",
        );
        return {
          passed: table?.name === "checksum_proof",
          schemaVersion: "checksum@1",
          evidence: { table: table?.name ?? null },
        };
      },
    };
    runner.apply([original]);
    expect(() =>
      runner.plan([{ ...original, checksumMaterial: `${original.checksumMaterial}; changed` }]),
    ).toThrow(/checksum mismatch.*immutable/);

    const badReadBack: DurableMigration = {
      stream: { kind: "pack", packId: "bad-readback" },
      id: "001-unverified-schema",
      checksumMaterial: "CREATE TABLE should_rollback (id TEXT PRIMARY KEY) STRICT",
      recovery: { mode: "forward_fix", note: "A new migration is required after failure." },
      apply: (context) => context.exec("CREATE TABLE should_rollback (id TEXT PRIMARY KEY) STRICT"),
      verify: () => ({
        passed: false,
        schemaVersion: "bad@1",
        evidence: { deliberate_failure: true },
      }),
    };
    expect(() => runner.apply([badReadBack])).toThrow(/schema read-back failed/);
    expect(runner.plan([badReadBack])[0]).toMatchObject({ state: "failed_forward_fix" });
    expect(() => runner.apply([badReadBack])).toThrow(/failed_forward_fix/);
    runner.close();
  });

  it("consumes a checksum-bound failed forward fix without reinvoking it and gates successors on repair read-back", () => {
    const path = migrationDatabase();
    const stream = { kind: "pack", packId: "forward-fix-lifecycle" } as const;
    let failedCalls = 0;
    let repairCalls = 0;
    let successorCalls = 0;
    const failed: DurableMigration = {
      stream,
      id: "001-broken-schema",
      checksumMaterial: "CREATE TABLE broken_forward_fix (id TEXT) STRICT; fail",
      recovery: {
        mode: "forward_fix",
        note: "A later checksum-bound migration must repair this terminal attempt.",
      },
      apply(context) {
        failedCalls += 1;
        context.exec("CREATE TABLE broken_forward_fix (id TEXT) STRICT");
        throw new Error("synthetic forward-fix failure");
      },
      verify: () => ({ passed: false, schemaVersion: "broken@1", evidence: null }),
    };
    const first = createSqliteMigrationRunner(path, { now: fixedClock });
    expect(() => first.apply([failed])).toThrow(/synthetic forward-fix failure/);
    expect(failedCalls).toBe(1);
    expect(first.journal(stream)).toEqual([
      expect.objectContaining({
        migrationId: failed.id,
        status: "failed",
        recoveryMode: "forward_fix",
      }),
    ]);
    first.close();

    const failedChecksum = migrationChecksum(failed);
    const repair: DurableMigration = {
      stream,
      id: "002-repair-schema",
      dependsOn: [
        {
          stream,
          id: failed.id,
          acceptFailedForwardFixChecksum: failedChecksum,
        },
      ],
      checksumMaterial: "CREATE TABLE repaired_forward_fix (id TEXT PRIMARY KEY) STRICT",
      recovery: {
        mode: "transaction_rollback",
        note: "The repair and its read-back commit atomically.",
      },
      apply(context) {
        repairCalls += 1;
        context.exec("CREATE TABLE repaired_forward_fix (id TEXT PRIMARY KEY) STRICT");
      },
      verify(context) {
        const table = context.get<{ name: string }>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'repaired_forward_fix'",
        );
        return {
          passed: table?.name === "repaired_forward_fix",
          schemaVersion: "repaired@2",
          evidence: { table: table?.name ?? null },
        };
      },
    };
    const successor: DurableMigration = {
      stream,
      id: "003-after-repair",
      dependsOn: [{ stream, id: repair.id }],
      checksumMaterial: "CREATE TABLE after_forward_fix (id TEXT PRIMARY KEY) STRICT",
      recovery: {
        mode: "transaction_rollback",
        note: "This may run only after repair read-back is durably applied.",
      },
      apply(context) {
        successorCalls += 1;
        context.exec("CREATE TABLE after_forward_fix (id TEXT PRIMARY KEY) STRICT");
      },
      verify(context) {
        const table = context.get<{ name: string }>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'after_forward_fix'",
        );
        return {
          passed: table?.name === "after_forward_fix",
          schemaVersion: "repaired@3",
          evidence: { table: table?.name ?? null },
        };
      },
    };

    const resumed = createSqliteMigrationRunner(path, { now: fixedClock });
    expect(resumed.plan([failed, repair, successor]).map(({ state }) => state)).toEqual([
      "forward_fix_pending",
      "pending",
      "pending",
    ]);
    expect(() =>
      resumed.plan([
        {
          ...repair,
          dependsOn: [
            {
              stream,
              id: failed.id,
              acceptFailedForwardFixChecksum: "0".repeat(64),
            },
          ],
        },
      ]),
    ).toThrow(/forward-fix checksum mismatch/);

    expect(resumed.apply([repair, successor]).map(({ state }) => state)).toEqual([
      "applied",
      "applied",
    ]);
    expect({ failedCalls, repairCalls, successorCalls }).toEqual({
      failedCalls: 1,
      repairCalls: 1,
      successorCalls: 1,
    });
    resumed.close();

    const replayed = createSqliteMigrationRunner(path, { now: fixedClock });
    expect(replayed.plan([failed, repair, successor]).map(({ state }) => state)).toEqual([
      "repaired_by_forward_fix",
      "already_applied",
      "already_applied",
    ]);
    expect(replayed.apply([failed, repair, successor]).map(({ state }) => state)).toEqual([
      "repaired_by_forward_fix",
      "already_applied",
      "already_applied",
    ]);
    expect({ failedCalls, repairCalls, successorCalls }).toEqual({
      failedCalls: 1,
      repairCalls: 1,
      successorCalls: 1,
    });
    replayed.close();
  });

  it("prevents a migration from escaping the runner-owned transaction", () => {
    const path = migrationDatabase();
    const runner = createSqliteMigrationRunner(path, { now: fixedClock });
    const escape: DurableMigration = {
      stream: { kind: "pack", packId: "transaction-escape" },
      id: "001-escape-attempt",
      checksumMaterial: "CREATE TABLE atomic_escape_proof (id TEXT); COMMIT",
      recovery: { mode: "transaction_rollback", note: "The runner owns transaction control." },
      apply: (context) => context.exec("CREATE TABLE atomic_escape_proof (id TEXT) STRICT; COMMIT"),
      verify: () => ({ passed: false, schemaVersion: "escape@1", evidence: null }),
    };
    expect(() => runner.apply([escape])).toThrow(/cannot control transactions/);
    expect(runner.journal(escape.stream)).toEqual([
      expect.objectContaining({ status: "failed", attemptCount: 1 }),
    ]);

    const proof: DurableMigration = {
      stream: { kind: "pack", packId: "transaction-proof" },
      id: "001-create-proof",
      checksumMaterial: "CREATE TABLE atomic_escape_proof (id TEXT) STRICT",
      recovery: { mode: "transaction_rollback", note: "The table is created atomically." },
      apply: (context) => context.exec("CREATE TABLE atomic_escape_proof (id TEXT) STRICT"),
      verify(context) {
        const table = context.get<{ name: string }>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'atomic_escape_proof'",
        );
        return {
          passed: table?.name === "atomic_escape_proof",
          schemaVersion: "escape-proof@1",
          evidence: { table: table?.name ?? null },
        };
      },
    };
    expect(runner.apply([proof])).toEqual([expect.objectContaining({ state: "applied" })]);
    runner.close();
  });
});
