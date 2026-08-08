import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  migrateV01ToV02,
  migrationManifestSchema,
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
import { readFileSync } from "node:fs";

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
