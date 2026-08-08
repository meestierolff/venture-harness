import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "@/lib/cli";
import { createHarnessLock, parseHarnessLock } from "@/lib/config/harness-lock";
import type { CommandInvocation, CommandResult, CommandRunner } from "@/lib/credentials";
import {
  MigrationRegistry,
  type MigrationFileSystem,
  type RegisteredMigration,
} from "@/lib/migrations";
import {
  applyOperationalUpgrade,
  locateLocalHarnessRelease,
  OPERATIONAL_UPGRADE_STEPS,
  type HarnessRelease,
} from "@/lib/upgrade";
import { FileWorkflowStore } from "@/lib/workflow";

const temporaryDirectories: string[] = [];
const fixedClock = () => new Date("2026-08-04T12:00:00.000Z");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

class MemoryFileSystem implements MigrationFileSystem {
  readonly files: Map<string, string>;
  readonly writes: string[] = [];

  constructor(initial: Record<string, string>) {
    this.files = new Map(Object.entries(initial));
  }

  async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    this.writes.push(path);
    this.files.set(path, content);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

class FakeRunner implements CommandRunner {
  readonly invocations: CommandInvocation[] = [];

  constructor(
    private readonly resultFor: (
      invocation: CommandInvocation,
      index: number,
    ) => Promise<CommandResult> | CommandResult = () => ({ exitCode: 0, stdout: "", stderr: "" }),
  ) {}

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    this.invocations.push(invocation);
    return this.resultFor(invocation, this.invocations.length - 1);
  }
}

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
    "project.txt": "founder-owned\n",
  };
}

function release(): HarnessRelease {
  return {
    version: "0.2.0",
    configContractVersion: 2,
    source: { kind: "release", ref: "v0.2.0" },
    files: [
      { path: "managed.txt", ownership: "harness", content: "managed v0.2\n" },
      { path: "project.txt", ownership: "project", content: "template suggestion\n" },
    ],
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("trusted local release locator", () => {
  it("reads a hash-verified local checkout and rejects tampering", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-release-"));
    temporaryDirectories.push(root);
    const content = "managed release content\n";
    writeFileSync(join(root, "managed.txt"), content);
    writeFileSync(
      join(root, "harness.lock"),
      stringify(
        createHarnessLock({
          source: { kind: "release", ref: "v0.2.0" },
          managed_files: [{ path: "managed.txt", ownership: "harness", sha256: hash(content) }],
        }),
      ),
    );

    await expect(locateLocalHarnessRelease({ locator: root })).resolves.toMatchObject({
      version: "0.2.0",
      files: [{ path: "managed.txt", content }],
    });

    writeFileSync(join(root, "managed.txt"), "tampered\n");
    await expect(locateLocalHarnessRelease({ locator: root })).rejects.toThrow(
      /hash mismatch: managed\.txt/,
    );
  });

  it("rejects remote locators without attempting a fetch", async () => {
    await expect(
      locateLocalHarnessRelease({ locator: "https://example.com/v0.2.0" }),
    ).rejects.toThrow(/local filesystem paths/);
  });
});

describe("migration registry", () => {
  it("resolves the registered v0.1 to v0.2 step and remains chain-extensible", () => {
    const noopPlan = (definition: Omit<RegisteredMigration, "plan">): RegisteredMigration => ({
      ...definition,
      plan: async () => ({
        id: definition.id,
        fromVersion: definition.fromVersion,
        toVersion: definition.toVersion,
        warnings: [],
        changes: [{ path: "harness.lock", content: "candidate\n" }],
      }),
    });
    const registry = new MigrationRegistry([
      noopPlan({ id: "001-v0-1-to-v0-2", fromVersion: "0.1.0", toVersion: "0.2.0" }),
      noopPlan({ id: "002-v0-2-to-v0-3", fromVersion: "0.2.0", toVersion: "0.3.0" }),
    ]);

    expect(registry.resolveChain("0.1.0", "0.3.0").map((migration) => migration.id)).toEqual([
      "001-v0-1-to-v0-2",
      "002-v0-2-to-v0-3",
    ]);
  });
});

describe("operational child upgrade", () => {
  it("plans and applies v0.1 migration plus managed release, verifies, and writes lock last", async () => {
    const fileSystem = new MemoryFileSystem(legacyFiles());
    const runner = new FakeRunner();
    const dryRun = await applyOperationalUpgrade({
      fileSystem,
      release: release(),
      commandRunner: runner,
      rootDir: "/child",
      dryRun: true,
      clock: fixedClock,
    });

    expect(dryRun).toMatchObject({
      status: "planned",
      dryRun: true,
      migrations: [{ id: "001-v0-1-to-v0-2" }],
      lockUpdated: false,
    });
    expect(dryRun.files.find((file) => file.path === "project.txt")?.action).toBe("preserve");
    expect(dryRun.verification.every((step) => step.status === "planned")).toBe(true);
    expect(fileSystem.writes).toEqual([]);
    expect(runner.invocations).toEqual([]);

    const applied = await applyOperationalUpgrade({
      fileSystem,
      release: release(),
      commandRunner: runner,
      rootDir: "/child",
      clock: fixedClock,
    });

    expect(applied).toMatchObject({
      status: "applied",
      fromVersion: "0.1.0",
      toVersion: "0.2.0",
      lockUpdated: true,
      rolledBack: false,
    });
    expect(runner.invocations.map(({ command, args }) => [command, args])).toEqual(
      OPERATIONAL_UPGRADE_STEPS.map(({ command, args }) => [command, args]),
    );
    expect(fileSystem.files.get("project.txt")).toBe("founder-owned\n");
    expect(fileSystem.files.get("managed.txt")).toBe("managed v0.2\n");
    expect(fileSystem.writes.at(-1)).toBe("harness.lock");
    const lock = parseHarnessLock(fileSystem.files.get("harness.lock")!);
    expect(lock).toMatchObject({
      harness_version: "0.2.0",
      source: { kind: "release", ref: "v0.2.0" },
      applied_migrations: [{ id: "001-v0-1-to-v0-2" }],
    });
    expect(lock.managed_files).toEqual(
      expect.arrayContaining([
        { path: "managed.txt", ownership: "harness", sha256: hash("managed v0.2\n") },
        { path: "project.txt", ownership: "project", sha256: hash("founder-owned\n") },
        {
          path: "config/framework.yaml",
          ownership: "harness",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ]),
    );
  });

  it("uses the staged migration baseline for known harness files and fails closed for unknown ones", async () => {
    const centralFramework = "central framework v0.2\n";
    const knownRelease: HarnessRelease = {
      version: "0.2.0",
      configContractVersion: 2,
      source: { kind: "release", ref: "v0.2.0" },
      files: [
        {
          path: "config/framework.yaml",
          ownership: "harness",
          content: centralFramework,
        },
      ],
    };
    const known = await applyOperationalUpgrade({
      fileSystem: new MemoryFileSystem(legacyFiles()),
      release: knownRelease,
      commandRunner: new FakeRunner(),
      rootDir: "/child",
      dryRun: true,
      clock: fixedClock,
    });

    expect(known.status).toBe("planned");
    expect(known.conflicts).toEqual([]);
    expect(known.files).toContainEqual(
      expect.objectContaining({ path: "config/framework.yaml", action: "update" }),
    );

    const customFiles = { ...legacyFiles(), "custom-managed.txt": "founder edit\n" };
    const unknown = await applyOperationalUpgrade({
      fileSystem: new MemoryFileSystem(customFiles),
      release: {
        ...knownRelease,
        files: [
          ...knownRelease.files,
          {
            path: "custom-managed.txt",
            ownership: "harness",
            content: "central content\n",
          },
        ],
      },
      commandRunner: new FakeRunner(),
      rootDir: "/child",
      dryRun: true,
      clock: fixedClock,
    });

    expect(unknown.status).toBe("blocked");
    expect(unknown.conflicts).toContainEqual(
      expect.objectContaining({
        path: "custom-managed.txt",
        action: "conflict",
        reason: "the lock has no trusted baseline hash for this existing file",
      }),
    );
  });

  it("restores migration and managed files when a pre-lock verification step fails", async () => {
    const initial = legacyFiles();
    const fileSystem = new MemoryFileSystem(initial);
    const runner = new FakeRunner(async (_invocation, index) => {
      if (index === 0) await fileSystem.writeAtomic("managed.txt", "sync mutation\n");
      return index === 1
        ? { exitCode: 1, stdout: "", stderr: "synthetic parity failure" }
        : { exitCode: 0, stdout: "", stderr: "" };
    });

    const report = await applyOperationalUpgrade({
      fileSystem,
      release: release(),
      commandRunner: runner,
      rootDir: "/child",
      clock: fixedClock,
    });

    expect(report).toMatchObject({
      status: "failed",
      lockUpdated: false,
      rolledBack: true,
      error: { code: "upgrade_validation_failed" },
      verification: [
        { id: "agent_adapter_sync", status: "passed" },
        { id: "agent_adapter_parity", status: "failed" },
        { id: "typecheck", status: "not_run" },
        { id: "migration_tests", status: "not_run" },
      ],
    });
    expect(Object.fromEntries(fileSystem.files)).toEqual(initial);
    expect(fileSystem.files.has("harness.lock")).toBe(false);
  });

  it("passes the explicit local release option through the CLI and exits nonzero on blocks", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-upgrade-cli-"));
    temporaryDirectories.push(root);
    const ioLines = { stdout: [] as string[], stderr: [] as string[] };
    const io: CliIo = {
      stdout: (line) => ioLines.stdout.push(line),
      stderr: (line) => ioLines.stderr.push(line),
    };
    const store = new FileWorkflowStore({ rootDir: join(root, "runs") });
    let request: { dryRun: boolean; releasePath?: string } | undefined;

    const result = await runCli(
      ["upgrade", "--release", "../trusted-v0.2", "--dry-run", "--json"],
      {
        io,
        store,
        services: {
          upgrade: (value) => {
            request = value;
            return { status: "blocked", conflicts: [{ path: "managed.txt" }] };
          },
        },
      },
    );

    expect(request).toEqual({ dryRun: true, releasePath: "../trusted-v0.2" });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(ioLines.stdout[0]).status).toBe("blocked");
  });
});
