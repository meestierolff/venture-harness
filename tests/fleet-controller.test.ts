import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createVentureHarnessLock, parseHarnessLock } from "@/lib/config/harness-lock";
import {
  createCoreReleaseManifest,
  createFleetController,
  createMemoryFleetStateStore,
  createSqliteFleetStateStore,
  fleetTargetKey,
  type FleetStateStore,
  type FleetVenture,
  type FleetVentureHooks,
} from "@/lib/fleet";
import type { MigrationFileSystem } from "@/lib/migrations";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const WORKFLOW_SHA = "d".repeat(40);
const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const BASE_MERGE = "header\naccent=default\ncore=old\n";
const NEXT_MERGE = "header\naccent=default\ncore=new\n";

class MemoryFileSystem implements MigrationFileSystem {
  readonly files: Map<string, string>;
  readonly writes: string[] = [];

  constructor(initial: Record<string, string>) {
    this.files = new Map(Object.entries(initial));
  }

  readText(path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }

  writeAtomic(path: string, content: string): Promise<void> {
    this.writes.push(path);
    this.files.set(path, content);
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
}

function release(overrides: Record<string, unknown> = {}) {
  return createCoreReleaseManifest({
    schemaVersion: 1,
    version: "0.3.0",
    sourceRef: "v0.3.0",
    workflowRefSha: WORKFLOW_SHA,
    changedPackages: {
      "@venture-harness/core": { from: "0.2.0", to: "0.3.0" },
    },
    affectedCapabilities: ["runtime.core"],
    migrations: ["002-core-v0-3"],
    compatibility: {
      minimumCoreVersion: "0.2.0",
      seedIds: ["agentic-web-saas", "hybrid-agentic-service"],
    },
    requiredChecks: ["typecheck", "test", "primary-journey"],
    rolloutRisk: "low",
    rollback: { mode: "previous_release", version: "0.2.0" },
    files: [
      { path: "core.txt", ownership: "core_owned", content: "core 0.3\n" },
      {
        path: "merge.txt",
        ownership: "merge_managed",
        baseContent: BASE_MERGE,
        content: NEXT_MERGE,
      },
      { path: "design.txt", ownership: "venture_owned", content: "central design\n" },
      {
        path: "service-blueprint.json",
        ownership: "venture_owned",
        content: '{"central":true}\n',
      },
    ],
    ...overrides,
  });
}

type HookPhase =
  "branch" | "migration" | "checks" | "preview" | "merge" | "production" | "smoke" | "compensate";

function hooks(failAt?: HookPhase) {
  const calls: HookPhase[] = [];
  const keys: string[] = [];
  const reconciledKeys: string[] = [];
  const targets: string[] = [];
  const compensationRequests: Array<{
    failedRelease: string;
    rollbackVersion: string | null;
  }> = [];
  const completed = new Map<string, { passed: boolean; evidence: readonly string[] }>();
  const passed = (phase: HookPhase) => {
    calls.push(phase);
    return failAt !== phase;
  };
  const finish = (phase: HookPhase, idempotencyKey: string, evidence: readonly string[]) => {
    keys.push(idempotencyKey);
    const result = { passed: passed(phase), evidence };
    completed.set(idempotencyKey, result);
    return result;
  };
  const implementation: FleetVentureHooks = {
    openUpgradeBranch: async ({ organizationId, ventureId, branch, idempotencyKey }) => {
      targets.push(`${organizationId}:${ventureId}`);
      const result = finish("branch", idempotencyKey, [`fixture:branch:${branch}`]);
      return {
        passed: result.passed,
        fixture: true,
        reference: `fixture:branch:${branch}:${result.passed ? "opened" : "failed"}`,
      };
    },
    runMigrations: async ({ organizationId, ventureId, migrations, idempotencyKey }) => {
      targets.push(`${organizationId}:${ventureId}`);
      return finish(
        "migration",
        idempotencyKey,
        migrations.map((item) => `fixture:migration:${item}`),
      );
    },
    runChecks: async ({ organizationId, ventureId, checks, idempotencyKey }) => {
      targets.push(`${organizationId}:${ventureId}`);
      return finish(
        "checks",
        idempotencyKey,
        checks.map((item) => `fixture:check:${item}`),
      );
    },
    deployPreview: async ({ organizationId, ventureId, idempotencyKey }) => {
      targets.push(`${organizationId}:${ventureId}`);
      const result = finish("preview", idempotencyKey, ["fixture:preview"]);
      return { passed: result.passed, fixture: true, reference: "fixture:preview" };
    },
    merge: async ({ organizationId, ventureId, idempotencyKey }) => {
      targets.push(`${organizationId}:${ventureId}`);
      const result = finish("merge", idempotencyKey, ["fixture:merge"]);
      return { passed: result.passed, fixture: true, reference: "fixture:merge" };
    },
    deployProduction: async ({ organizationId, ventureId, idempotencyKey }) => {
      targets.push(`${organizationId}:${ventureId}`);
      const result = finish("production", idempotencyKey, ["fixture:production"]);
      return { passed: result.passed, fixture: true, reference: "fixture:production" };
    },
    smokeProduction: async ({ organizationId, ventureId, idempotencyKey }) => {
      targets.push(`${organizationId}:${ventureId}`);
      const result = finish("smoke", idempotencyKey, ["fixture:smoke"]);
      return { passed: result.passed, fixture: true, reference: "fixture:smoke" };
    },
    compensate: async ({
      organizationId,
      ventureId,
      failedRelease,
      rollbackVersion,
      idempotencyKey,
    }) => {
      targets.push(`${organizationId}:${ventureId}`);
      compensationRequests.push({ failedRelease, rollbackVersion });
      const result = finish("compensate", idempotencyKey, ["fixture:compensation"]);
      return { passed: result.passed, fixture: true, reference: "fixture:compensation" };
    },
    reconcilePhase: async ({ organizationId, ventureId, idempotencyKey }) => {
      targets.push(`${organizationId}:${ventureId}`);
      reconciledKeys.push(idempotencyKey);
      const result = completed.get(idempotencyKey);
      return result
        ? { state: "completed" as const, ...result }
        : {
            state: "not_applied" as const,
            passed: false,
            evidence: [],
          };
    },
  };
  return { implementation, calls, keys, reconciledKeys, targets, compensationRequests };
}

function venture(options: {
  id: string;
  organizationId?: string;
  seed?: "agentic-web-saas" | "hybrid-agentic-service";
  provider: string;
  accent: string;
  canary: boolean;
  capability?: string;
  failAt?: HookPhase;
  mergeContent?: string;
  automaticMerge?: boolean;
  productionHealth?: { healthy: boolean; version: string };
  compensationHealth?: { healthy: boolean; version: string };
}) {
  const organizationId = options.organizationId ?? "company-fixture";
  const mergeContent = options.mergeContent ?? BASE_MERGE.replace("default", options.accent);
  const design = `design:${options.accent}\n`;
  const blueprint = `{"organization":"${organizationId}","venture":"${options.id}"}\n`;
  const lock = createVentureHarnessLock({
    harness_version: "0.2.0",
    core_version: "0.2.0",
    config_contract_version: 2,
    source: { kind: "seed", ref: `${options.seed ?? "agentic-web-saas"}@0.2.0` },
    seed: { id: options.seed ?? "agentic-web-saas", version: "0.2.0" },
    runtime_packages: { "@venture-harness/core": "0.2.0" },
    provider_adapters: { [options.provider]: "0.2.0" },
    generators: { api: "0.2.0" },
    managed_files: [
      { path: "core.txt", ownership: "core_owned", sha256: hash("core 0.2\n") },
      {
        path: "merge.txt",
        ownership: "merge_managed",
        sha256: hash(BASE_MERGE),
        base_sha256: hash(BASE_MERGE),
      },
      { path: "design.txt", ownership: "venture_owned", sha256: hash(design) },
      {
        path: "service-blueprint.json",
        ownership: "venture_owned",
        sha256: hash(blueprint),
      },
    ],
    applied_migrations: [],
    migration_state: [],
    update_channel: "stable",
    workflow_ref_sha: "c".repeat(40),
    last_verified_upgrade: null,
    extensions: {},
  });
  const fileSystem = new MemoryFileSystem({
    "core.txt": "core 0.2\n",
    "merge.txt": mergeContent,
    "design.txt": design,
    "service-blueprint.json": blueprint,
    "harness.lock": stringify(lock),
  });
  const configuredHooks = hooks(options.failAt);
  let deployedVersion = "0.2.0";
  const healthChecks: Array<{
    phase: "production" | "compensation";
    expectedVersion: string;
    observed: { healthy: boolean; version: string };
  }> = [];
  const deploy = configuredHooks.implementation.deployProduction;
  configuredHooks.implementation.deployProduction = async (input) => {
    const result = await deploy(input);
    if (result.passed) deployedVersion = input.release;
    return result;
  };
  const compensate = configuredHooks.implementation.compensate;
  configuredHooks.implementation.compensate = async (input) => {
    const result = await compensate(input);
    if (result.passed && input.rollbackVersion) deployedVersion = input.rollbackVersion;
    return result;
  };
  const result: FleetVenture = {
    organizationId,
    ventureId: options.id,
    repository: `fixture://${organizationId}/${options.id}`,
    designFingerprint: hash(design),
    serviceBlueprintFingerprint: hash(blueprint),
    capabilities: [options.capability ?? "runtime.core"],
    providers: [options.provider],
    currentLock: lock,
    fileSystem,
    canary: options.canary,
    policy: {
      automaticMerge: options.automaticMerge ?? true,
      productionDeployment: true,
    },
    hooks: configuredHooks.implementation,
    deployedHealth: (input) => {
      const observed =
        input.phase === "production"
          ? (options.productionHealth ?? { healthy: true, version: deployedVersion })
          : (options.compensationHealth ?? { healthy: true, version: deployedVersion });
      healthChecks.push({
        phase: input.phase,
        expectedVersion: input.expectedVersion,
        observed,
      });
      return Promise.resolve(observed);
    },
  };
  return {
    venture: result,
    fileSystem,
    calls: configuredHooks.calls,
    keys: configuredHooks.keys,
    reconciledKeys: configuredHooks.reconciledKeys,
    targets: configuredHooks.targets,
    compensationRequests: configuredHooks.compensationRequests,
    healthChecks,
    design,
    blueprint,
  };
}

describe("Fleet Controller", () => {
  it("keeps the explicit memory fixture store separate from the durable SQLite store", () => {
    expect(() => createSqliteFleetStateStore(":memory:")).toThrow(/persistent SQLite file/);
    expect(createMemoryFleetStateStore().get("missing-run")).toBeNull();
  });

  it("upgrades two independent ventures through canary and batch while preserving unique files", async () => {
    const payout = venture({
      id: "payout-rank",
      provider: "stripe",
      accent: "amber",
      canary: true,
    });
    const shipping = venture({
      id: "ship-to-users",
      provider: "paddle",
      accent: "blue",
      canary: false,
      seed: "hybrid-agentic-service",
    });
    const store = createMemoryFleetStateStore();
    const controller = createFleetController({ store, now: () => NOW });
    const report = await controller.rollout({
      runId: "fleet-success",
      release: release(),
      ventures: [shipping.venture, payout.venture],
      batchSize: 1,
    });

    expect(report.status).toBe("completed");
    expect(report.canaryTarget).toEqual({
      organizationId: "company-fixture",
      ventureId: "payout-rank",
    });
    expect(report.batches).toEqual([
      [{ organizationId: "company-fixture", ventureId: "ship-to-users" }],
    ]);
    expect(report.results.map(({ ventureId, status }) => [ventureId, status]).sort()).toEqual([
      ["payout-rank", "verified"],
      ["ship-to-users", "verified"],
    ]);
    for (const fixture of [payout, shipping]) {
      expect(fixture.fileSystem.files.get("core.txt")).toBe("core 0.3\n");
      expect(fixture.fileSystem.files.get("design.txt")).toBe(fixture.design);
      expect(fixture.fileSystem.files.get("service-blueprint.json")).toBe(fixture.blueprint);
      expect(fixture.fileSystem.files.get("merge.txt")).toContain(
        `accent=${fixture.venture.ventureId === "payout-rank" ? "amber" : "blue"}`,
      );
      expect(fixture.fileSystem.files.get("merge.txt")).toContain("core=new");
      const upgraded = parseHarnessLock(fixture.fileSystem.files.get("harness.lock")!);
      expect(upgraded).toMatchObject({
        lock_version: 2,
        core_version: "0.3.0",
        harness_version: "0.3.0",
        last_verified_upgrade: NOW.toISOString(),
        runtime_packages: { "@venture-harness/core": "0.3.0" },
        migration_state: ["002-core-v0-3"],
      });
    }
    expect(payout.venture.providers).not.toEqual(shipping.venture.providers);
    expect(payout.venture.designFingerprint).not.toBe(shipping.venture.designFingerprint);
    expect(payout.venture.serviceBlueprintFingerprint).not.toBe(
      shipping.venture.serviceBlueprintFingerprint,
    );

    const callsBeforeReplay = payout.calls.length + shipping.calls.length;
    const replay = await controller.rollout({
      runId: "fleet-success",
      release: release(),
      ventures: [payout.venture, shipping.venture],
      batchSize: 1,
    });
    expect(replay).toEqual(report);
    expect(payout.calls.length + shipping.calls.length).toBe(callsBeforeReplay);

    store.close();
    await expect(
      payout.venture.deployedHealth({
        organizationId: payout.venture.organizationId,
        ventureId: payout.venture.ventureId,
        phase: "production",
        expectedVersion: "0.3.0",
      }),
    ).resolves.toEqual({
      healthy: true,
      version: "0.3.0",
    });
    await expect(
      shipping.venture.deployedHealth({
        organizationId: shipping.venture.organizationId,
        ventureId: shipping.venture.ventureId,
        phase: "production",
        expectedVersion: "0.3.0",
      }),
    ).resolves.toEqual({
      healthy: true,
      version: "0.3.0",
    });
  });

  it("isolates two company organizations that use the same venture slug across durable state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-fleet-two-organizations-"));
    directories.push(directory);
    const path = join(directory, "fleet.sqlite");
    const alpha = venture({
      id: "shared-product",
      organizationId: "company-alpha",
      provider: "stripe",
      accent: "amber",
      canary: true,
    });
    const bravo = venture({
      id: "shared-product",
      organizationId: "company-bravo",
      provider: "paddle",
      accent: "blue",
      canary: false,
    });
    const firstStore = createSqliteFleetStateStore(path);
    const leaseTargets: Array<readonly { organizationId: string; ventureId: string }[]> = [];
    const observingStore: FleetStateStore = {
      get: (runId) => firstStore.get(runId),
      put: (record, ownerId) => firstStore.put(record, ownerId),
      acquireLease(input) {
        leaseTargets.push(input.targets);
        return firstStore.acquireLease(input);
      },
      close: () => undefined,
    };
    const report = await createFleetController({ store: observingStore, now: () => NOW }).rollout({
      runId: "fleet-same-slug-two-organizations",
      release: release(),
      ventures: [bravo.venture, alpha.venture],
      batchSize: 1,
    });

    expect(report.status).toBe("completed");
    expect(report.canaryTarget).toEqual({
      organizationId: "company-alpha",
      ventureId: "shared-product",
    });
    expect(report.batches).toEqual([
      [{ organizationId: "company-bravo", ventureId: "shared-product" }],
    ]);
    expect(
      report.results
        .map(({ organizationId, ventureId, status }) => [organizationId, ventureId, status])
        .sort(),
    ).toEqual([
      ["company-alpha", "shared-product", "verified"],
      ["company-bravo", "shared-product", "verified"],
    ]);
    expect(Object.keys(report.checkpoints).sort()).toEqual([
      fleetTargetKey(alpha.venture),
      fleetTargetKey(bravo.venture),
    ]);
    expect(alpha.keys.every((key) => !bravo.keys.includes(key))).toBe(true);
    expect(alpha.targets.every((target) => target === "company-alpha:shared-product")).toBe(true);
    expect(bravo.targets.every((target) => target === "company-bravo:shared-product")).toBe(true);
    expect(leaseTargets.length).toBeGreaterThan(0);
    expect(
      leaseTargets.every(
        (targets) =>
          targets.map(fleetTargetKey).sort().join("|") ===
          [fleetTargetKey(alpha.venture), fleetTargetKey(bravo.venture)].sort().join("|"),
      ),
    ).toBe(true);
    firstStore.close();

    const callsBeforeReplay = alpha.calls.length + bravo.calls.length;
    const reopened = createSqliteFleetStateStore(path);
    const replay = await createFleetController({ store: reopened, now: () => NOW }).rollout({
      runId: "fleet-same-slug-two-organizations",
      release: release(),
      ventures: [alpha.venture, bravo.venture],
      batchSize: 1,
    });
    expect(replay).toEqual(report);
    expect(alpha.calls.length + bravo.calls.length).toBe(callsBeforeReplay);
    reopened.close();
  });

  it("never reuses a completed run or checkpoint for a same-ID replacement target", async () => {
    const original = venture({
      id: "bound-target",
      provider: "stripe",
      accent: "amber",
      canary: true,
    });
    const foreign = venture({
      id: "foreign-target",
      provider: "paddle",
      accent: "blue",
      canary: true,
    });
    const store = createMemoryFleetStateStore();
    const controller = createFleetController({ store, now: () => NOW });
    await controller.rollout({
      runId: "fleet-target-binding",
      release: release(),
      ventures: [original.venture],
      batchSize: 1,
    });
    const callsBefore = original.calls.length;
    const replacements: FleetVenture[] = [
      { ...original.venture, organizationId: "company-other" },
      { ...original.venture, repository: "fixture://replacement-repository" },
      { ...original.venture, designFingerprint: "f".repeat(64) },
      { ...original.venture, serviceBlueprintFingerprint: "e".repeat(64) },
      { ...original.venture, currentLock: foreign.venture.currentLock },
    ];

    for (const replacement of replacements) {
      await expect(
        controller.rollout({
          runId: "fleet-target-binding",
          release: release(),
          ventures: [replacement],
          batchSize: 1,
        }),
      ).rejects.toThrow(/selection|checkpoint target changed/);
    }
    expect(original.calls).toHaveLength(callsBefore);
    store.close();
  });

  it("pauses the fleet and restores the canary when its checks fail", async () => {
    const canary = venture({
      id: "canary",
      provider: "stripe",
      accent: "red",
      canary: true,
      failAt: "checks",
    });
    const batch = venture({
      id: "batch",
      provider: "paddle",
      accent: "green",
      canary: false,
    });
    const controller = createFleetController({
      store: createMemoryFleetStateStore(),
      now: () => NOW,
    });
    const report = await controller.rollout({
      runId: "fleet-fail",
      release: release(),
      ventures: [canary.venture, batch.venture],
      batchSize: 1,
    });

    expect(report.status).toBe("paused");
    expect(report.results).toContainEqual(
      expect.objectContaining({ ventureId: "canary", status: "rolled_back" }),
    );
    expect(canary.fileSystem.files.get("core.txt")).toBe("core 0.2\n");
    expect(parseHarnessLock(canary.fileSystem.files.get("harness.lock")!).harness_version).toBe(
      "0.2.0",
    );
    expect(batch.calls).toEqual([]);
  });

  it("does not verify a lying smoke acknowledgement when production health read-back disagrees", async () => {
    const target = venture({
      id: "lying-smoke",
      provider: "stripe",
      accent: "red",
      canary: true,
      productionHealth: { healthy: false, version: "0.3.0" },
    });
    const report = await createFleetController({
      store: createMemoryFleetStateStore(),
      now: () => NOW,
    }).rollout({
      runId: "lying-smoke-readback",
      release: release(),
      ventures: [target.venture],
      batchSize: 1,
    });

    expect(report.status).toBe("paused");
    expect(report.results).toEqual([
      expect.objectContaining({
        organizationId: target.venture.organizationId,
        ventureId: target.venture.ventureId,
        status: "rolled_back",
        error: expect.stringMatching(/health\/version read-back did not match/),
      }),
    ]);
    expect(target.calls).toContain("smoke");
    expect(target.calls).toContain("compensate");
    expect(target.compensationRequests).toEqual([
      { failedRelease: "0.3.0", rollbackVersion: "0.2.0" },
    ]);
    expect(target.healthChecks.map(({ phase }) => phase)).toEqual(["production", "compensation"]);
    expect(parseHarnessLock(target.fileSystem.files.get("harness.lock")!).harness_version).toBe(
      "0.2.0",
    );
  });

  it("requires exact previous-version health read-back before claiming compensation", async () => {
    const target = venture({
      id: "wrong-compensation-version",
      provider: "stripe",
      accent: "crimson",
      canary: true,
      failAt: "smoke",
      compensationHealth: { healthy: true, version: "0.1.0" },
    });
    const report = await createFleetController({
      store: createMemoryFleetStateStore(),
      now: () => NOW,
    }).rollout({
      runId: "wrong-compensation-readback",
      release: release(),
      ventures: [target.venture],
      batchSize: 1,
    });

    expect(report.status).toBe("paused");
    expect(report.results).toEqual([
      expect.objectContaining({
        organizationId: target.venture.organizationId,
        ventureId: target.venture.ventureId,
        status: "forward_fix_required",
        error: expect.stringMatching(/compensation health\/version read-back did not match/),
      }),
    ]);
    expect(target.healthChecks).toEqual([
      {
        phase: "compensation",
        expectedVersion: "0.2.0",
        observed: { healthy: true, version: "0.1.0" },
      },
    ]);
    expect(parseHarnessLock(target.fileSystem.files.get("harness.lock")!).harness_version).toBe(
      "0.3.0",
    );
  });

  it("skips unaffected ventures and blocks overlapping merge-managed edits safely", async () => {
    const unaffected = venture({
      id: "ios-only",
      provider: "revenuecat",
      accent: "violet",
      canary: false,
      capability: "mobile.ios",
    });
    const affected = venture({
      id: "web",
      provider: "stripe",
      accent: "orange",
      canary: true,
      mergeContent: "header\naccent=orange\ncore=local-conflict\n",
    });
    const capabilityOnlyRelease = release({
      changedPackages: { "@venture-harness/not-installed": { from: "0.2.0", to: "0.3.0" } },
    });
    const controller = createFleetController({
      store: createMemoryFleetStateStore(),
      now: () => NOW,
    });
    const report = await controller.rollout({
      runId: "fleet-conflict",
      release: capabilityOnlyRelease,
      ventures: [unaffected.venture, affected.venture],
      batchSize: 1,
    });

    expect(report.status).toBe("paused");
    expect(report.results).toContainEqual(
      expect.objectContaining({ ventureId: "ios-only", status: "unaffected" }),
    );
    expect(report.results).toContainEqual(
      expect.objectContaining({ ventureId: "web", status: "rolled_back" }),
    );
    expect(unaffected.calls).toEqual([]);
    expect(affected.fileSystem.files.get("merge.txt")).toContain("local-conflict");
    expect(parseHarnessLock(affected.fileSystem.files.get("harness.lock")!).harness_version).toBe(
      "0.2.0",
    );
  });

  it("persists paused rollout state and binds a run ID to one release digest", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-fleet-store-"));
    directories.push(directory);
    const path = join(directory, "fleet.sqlite");
    const canary = venture({
      id: "durable-canary",
      provider: "stripe",
      accent: "cyan",
      canary: true,
      failAt: "preview",
    });
    const store = createSqliteFleetStateStore(path);
    const controller = createFleetController({ store, now: () => NOW });
    const report = await controller.rollout({
      runId: "durable-run",
      release: release(),
      ventures: [canary.venture],
      batchSize: 1,
    });
    expect(report.status).toBe("paused");
    store.close();

    const reopened = createSqliteFleetStateStore(path);
    expect(reopened.get("durable-run")).toEqual(report);
    const resumed = createFleetController({ store: reopened, now: () => NOW });
    await expect(
      resumed.rollout({
        runId: "durable-run",
        release: release({ version: "0.3.1", sourceRef: "v0.3.1" }),
        ventures: [canary.venture],
        batchSize: 1,
      }),
    ).rejects.toThrow(/another release/);
    reopened.close();
  });

  it("atomically creates and leases a new run when two stores both observed it missing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-fleet-create-race-"));
    directories.push(directory);
    const path = join(directory, "fleet.sqlite");
    const target = venture({
      id: "creation-race-canary",
      provider: "stripe",
      accent: "indigo",
      canary: true,
    });
    const firstBase = createSqliteFleetStateStore(path);
    const secondBase = createSqliteFleetStateStore(path);
    const staleFirstRead = (base: FleetStateStore): FleetStateStore => {
      let stale = true;
      return {
        get(runId) {
          if (stale) {
            stale = false;
            return null;
          }
          return base.get(runId);
        },
        put: (record, ownerId) => base.put(record, ownerId),
        acquireLease: (input) => base.acquireLease(input),
        close: () => undefined,
      };
    };
    const first = createFleetController({
      store: staleFirstRead(firstBase),
      now: () => NOW,
      controllerId: "creation-race-first",
      leaseDurationMs: 10_000,
    });
    const second = createFleetController({
      store: staleFirstRead(secondBase),
      now: () => NOW,
      controllerId: "creation-race-second",
      leaseDurationMs: 10_000,
    });
    const input = {
      runId: "creation-race-run",
      release: release(),
      ventures: [target.venture],
      batchSize: 1,
    } as const;
    const attempts = await Promise.allSettled([first.rollout(input), second.rollout(input)]);
    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof first.rollout>>> =>
        attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value.status).toBe("completed");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/leased by another/) }),
    );
    expect(target.calls.filter((phase) => phase === "branch")).toHaveLength(1);
    expect(target.calls.filter((phase) => phase === "merge")).toHaveLength(1);
    expect(target.calls.filter((phase) => phase === "production")).toHaveLength(1);
    expect(firstBase.get(input.runId)).toMatchObject({ status: "completed", lease: null });
    firstBase.close();
    secondBase.close();
  });

  it("does not let a stale unleased memory-store creator erase an acquired lease", async () => {
    const target = venture({
      id: "memory-create-race",
      provider: "stripe",
      accent: "plum",
      canary: true,
    });
    const store = createMemoryFleetStateStore();
    await expect(
      createFleetController({
        store,
        now: () => NOW,
        controllerId: "memory-lease-owner",
        leaseDurationMs: 10_000,
        afterHook: ({ phase }) => {
          if (phase === "branch") throw new Error("simulated memory-store process stop");
        },
      }).rollout({
        runId: "memory-create-race-run",
        release: release(),
        ventures: [target.venture],
        batchSize: 1,
      }),
    ).rejects.toThrow(/simulated memory-store process stop/);
    const leased = store.get("memory-create-race-run")!;
    expect(leased.lease?.ownerId).toBe("memory-lease-owner");

    store.put({ ...leased, checkpoints: {}, results: [], lease: null });
    expect(store.get("memory-create-race-run")).toMatchObject({
      lease: { ownerId: "memory-lease-owner" },
      checkpoints: {
        [fleetTargetKey(target.venture)]: { phases: { branch: { state: "prepared" } } },
      },
    });
    await expect(
      createFleetController({
        store,
        now: () => NOW,
        controllerId: "memory-stale-creator",
        leaseDurationMs: 10_000,
      }).rollout({
        runId: "memory-create-race-run",
        release: release(),
        ventures: [target.venture],
        batchSize: 1,
      }),
    ).rejects.toThrow(/leased by another active controller/);
    expect(target.calls.filter((phase) => phase === "branch")).toHaveLength(1);
    store.close();
  });

  for (const crashPhase of ["branch", "merge", "production"] as const) {
    it(`reconciles a completed ${crashPhase} effect after lease expiry without invoking it again`, async () => {
      const directory = mkdtempSync(join(tmpdir(), `vh-fleet-${crashPhase}-crash-`));
      directories.push(directory);
      const path = join(directory, "fleet.sqlite");
      const target = venture({
        id: `${crashPhase}-resume`,
        provider: "stripe",
        accent: "teal",
        canary: true,
      });
      let current = new Date(NOW);
      let crashed = false;
      const firstStore = createSqliteFleetStateStore(path);
      const first = createFleetController({
        store: firstStore,
        now: () => current,
        controllerId: "controller-before-crash",
        leaseDurationMs: 1_000,
        afterHook: ({ phase }) => {
          if (!crashed && phase === crashPhase) {
            crashed = true;
            throw new Error(`simulated process stop after ${phase}`);
          }
        },
      });
      await expect(
        first.rollout({
          runId: `${crashPhase}-crash-run`,
          release: release(),
          ventures: [target.venture],
          batchSize: 1,
        }),
      ).rejects.toThrow(`simulated process stop after ${crashPhase}`);
      expect(target.calls.filter((phase) => phase === crashPhase)).toHaveLength(1);
      firstStore.close();

      const activeLeaseStore = createSqliteFleetStateStore(path);
      await expect(
        createFleetController({
          store: activeLeaseStore,
          now: () => current,
          controllerId: "controller-too-early",
          leaseDurationMs: 1_000,
        }).rollout({
          runId: `${crashPhase}-crash-run`,
          release: release(),
          ventures: [target.venture],
          batchSize: 1,
        }),
      ).rejects.toThrow(/leased by another active controller/);
      activeLeaseStore.close();

      current = new Date(NOW.getTime() + 1_001);
      const resumedStore = createSqliteFleetStateStore(path);
      const resumed = await createFleetController({
        store: resumedStore,
        now: () => current,
        controllerId: "controller-after-crash",
        leaseDurationMs: 1_000,
      }).rollout({
        runId: `${crashPhase}-crash-run`,
        release: release(),
        ventures: [target.venture],
        batchSize: 1,
      });
      expect(resumed.status).toBe("completed");
      expect(target.calls.filter((phase) => phase === crashPhase)).toHaveLength(1);
      const originalKey = target.keys.find((_, index) => target.calls[index] === crashPhase);
      expect(originalKey).toBeDefined();
      expect(target.reconciledKeys).toContain(originalKey);
      resumedStore.close();
    });
  }

  it("keeps an ambiguous prepared phase paused without blindly replaying its hook", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-fleet-unknown-crash-"));
    directories.push(directory);
    const path = join(directory, "fleet.sqlite");
    const target = venture({
      id: "unknown-branch-resume",
      provider: "stripe",
      accent: "navy",
      canary: true,
    });
    let current = new Date(NOW);
    const firstStore = createSqliteFleetStateStore(path);
    await expect(
      createFleetController({
        store: firstStore,
        now: () => current,
        controllerId: "unknown-controller-before-crash",
        leaseDurationMs: 1_000,
        afterHook: ({ phase }) => {
          if (phase === "branch") throw new Error("simulated unknown branch outcome");
        },
      }).rollout({
        runId: "unknown-crash-run",
        release: release(),
        ventures: [target.venture],
        batchSize: 1,
      }),
    ).rejects.toThrow(/simulated unknown branch outcome/);
    firstStore.close();
    target.venture.hooks.reconcilePhase = async () => ({
      state: "unknown",
      passed: false,
      evidence: [],
    });

    current = new Date(NOW.getTime() + 1_001);
    const resumedStore = createSqliteFleetStateStore(path);
    await expect(
      createFleetController({
        store: resumedStore,
        now: () => current,
        controllerId: "unknown-controller-after-crash",
        leaseDurationMs: 1_000,
      }).rollout({
        runId: "unknown-crash-run",
        release: release(),
        ventures: [target.venture],
        batchSize: 1,
      }),
    ).rejects.toThrow(/outcome is unknown/);
    expect(target.calls.filter((phase) => phase === "branch")).toHaveLength(1);
    expect(
      resumedStore.get("unknown-crash-run")?.checkpoints[fleetTargetKey(target.venture)]?.phases,
    ).toMatchObject({ branch: { state: "prepared" } });
    resumedStore.close();
  });

  it("retains a verified canary result when a later batch venture crashes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-fleet-batch-crash-"));
    directories.push(directory);
    const path = join(directory, "fleet.sqlite");
    const canary = venture({
      id: "durable-canary-result",
      provider: "stripe",
      accent: "cyan",
      canary: true,
    });
    const batch = venture({
      id: "durable-batch-crash",
      provider: "paddle",
      accent: "green",
      canary: false,
    });
    let current = new Date(NOW);
    let crashed = false;
    const firstStore = createSqliteFleetStateStore(path);
    await expect(
      createFleetController({
        store: firstStore,
        now: () => current,
        controllerId: "batch-controller-before-crash",
        leaseDurationMs: 1_000,
        afterHook: ({ ventureId, phase }) => {
          if (!crashed && ventureId === batch.venture.ventureId && phase === "branch") {
            crashed = true;
            throw new Error("simulated batch process stop");
          }
        },
      }).rollout({
        runId: "batch-crash-run",
        release: release(),
        ventures: [batch.venture, canary.venture],
        batchSize: 1,
      }),
    ).rejects.toThrow(/simulated batch process stop/);
    const canaryCalls = [...canary.calls];
    expect(firstStore.get("batch-crash-run")?.results).toContainEqual(
      expect.objectContaining({ ventureId: canary.venture.ventureId, status: "verified" }),
    );
    firstStore.close();

    current = new Date(NOW.getTime() + 1_001);
    const resumedStore = createSqliteFleetStateStore(path);
    const result = await createFleetController({
      store: resumedStore,
      now: () => current,
      controllerId: "batch-controller-after-crash",
      leaseDurationMs: 1_000,
    }).rollout({
      runId: "batch-crash-run",
      release: release(),
      ventures: [batch.venture, canary.venture],
      batchSize: 1,
    });
    expect(result.status).toBe("completed");
    expect(canary.calls).toEqual(canaryCalls);
    resumedStore.close();
  });

  it("requires human approval for high-risk releases even when automatic merge is configured", async () => {
    const canary = venture({
      id: "high-risk",
      provider: "stripe",
      accent: "gold",
      canary: true,
    });
    const controller = createFleetController({
      store: createMemoryFleetStateStore(),
      now: () => NOW,
    });
    const report = await controller.rollout({
      runId: "high-risk-run",
      release: release({ rolloutRisk: "high" }),
      ventures: [canary.venture],
      batchSize: 1,
    });
    expect(report.status).toBe("paused");
    expect(report.results).toContainEqual(
      expect.objectContaining({ status: "waiting_for_merge_approval", phase: "merge" }),
    );
    expect(canary.calls).not.toContain("merge");
    expect(canary.fileSystem.files.get("core.txt")).toBe("core 0.2\n");
  });

  it("rejects mutable workflow refs and version-tag mismatches", () => {
    expect(() => release({ workflowRefSha: "main" })).toThrow();
    expect(() => release({ sourceRef: "v0.4.0" })).toThrow(/exact version tag/);
    expect(() => release({ rollback: { mode: "previous_release", version: null } })).toThrow(
      /requires an exact prior version/,
    );
    expect(() => release({ rollback: { mode: "previous_release", version: "0.3.0" } })).toThrow(
      /must be older/,
    );
    expect(() => release({ rollback: { mode: "forward_fix", version: "0.2.0" } })).toThrow(
      /cannot declare a replacement version/,
    );
  });

  it("rejects a rollback version that is not the venture's exact prior version", async () => {
    const target = venture({
      id: "wrong-manifest-rollback",
      provider: "stripe",
      accent: "gray",
      canary: true,
    });
    await expect(
      createFleetController({
        store: createMemoryFleetStateStore(),
        now: () => NOW,
      }).rollout({
        runId: "wrong-manifest-rollback",
        release: release({ rollback: { mode: "previous_release", version: "0.1.0" } }),
        ventures: [target.venture],
        batchSize: 1,
      }),
    ).rejects.toThrow(/does not match prior venture version/);
    expect(target.calls).toEqual([]);
  });
});
