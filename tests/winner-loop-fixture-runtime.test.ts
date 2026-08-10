import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { parseGrowthContract } from "@/lib/config/growth-contract-schema";
import {
  FileFixtureAssetVault,
  FileFixtureCommandIdempotencyStore,
  WINNER_FIXTURE_CAPABILITY_BY_FEATURE,
  createWinnerFixtureCapabilityRuntime,
} from "@/lib/winner-integrations/capability-bridge";
import {
  FIXTURE_D_STEPS,
  createSqliteCreativeLedgerStore,
  runFixtureDThroughProductionBoundaries,
  type FixtureDProviderFeature,
} from "@/lib/winner-loop";

const temporaryDirectories: string[] = [];

interface FixtureStoreWorkerResult {
  exitCode: number | null;
  output: { status: "success" | "error"; size?: number; outcomes?: string[]; message?: string };
  stderr: string;
}

function fixtureStoreWorker(
  mode: "provider" | "command" | "asset",
  databasePath: string,
  startPath: string,
  prefix: string,
  count: number,
  requestTag = "same",
): Promise<FixtureStoreWorkerResult> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "tests/fixtures/provider/fixture-d-store-worker.ts",
      mode,
      databasePath,
      startPath,
      prefix,
      String(count),
      requestTag,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => {
      const lastLine = stdout.trim().split("\n").at(-1);
      if (!lastLine) return reject(new Error(`fixture store worker emitted no output: ${stderr}`));
      resolve({
        exitCode,
        output: JSON.parse(lastLine) as FixtureStoreWorkerResult["output"],
        stderr,
      });
    });
  });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Fixture D production-boundary runtime", () => {
  it("proves the synthetic loop through authorized, durable, fixture-only boundaries", async () => {
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "vh-fixture-d-runtime-"));
    temporaryDirectories.push(workspaceDirectory);
    const tracePath = join(workspaceDirectory, "winner-loop-creative-trace.json");
    const contract = parseGrowthContract(parse(readFileSync("config/growth.yaml", "utf8")));

    const result = await runFixtureDThroughProductionBoundaries({
      contract,
      workspaceDirectory,
      tracePath,
      runId: "fixture-d-production-test",
    });

    expect(result.state).toBe("succeeded");
    expect(result.commandAuditRecords).toBe(70);
    expect(result.commandEvents).toBe(35);
    expect(result.eventPackEvents).toBe(19);
    expect(result.providerOperations).toHaveLength(6);
    expect(
      result.providerOperations.every(
        (operation) =>
          operation.providerInvoked === false &&
          operation.externalEffectOccurred === false &&
          operation.spendAllowed === false &&
          operation.packageSdk === "@venture-harness/provider-sdk" &&
          operation.registryResolved === true &&
          operation.stackProfileId === "winner-loop-fixture-v1" &&
          operation.verify === "verified_fixture" &&
          operation.reconcile === "matched",
      ),
    ).toBe(true);
    expect(result.distributionProposalId).toBe("fixture-distribution-pr-1");
    expect(existsSync(result.auditPath)).toBe(true);
    expect(existsSync(result.workflowDirectory)).toBe(true);
    expect(existsSync(result.tracePath)).toBe(true);

    const traceText = readFileSync(tracePath, "utf8");
    const trace = JSON.parse(traceText) as {
      label: string;
      providerObjects: Array<{ objectKind: string; externalId: string }>;
      productionBoundarySteps: Array<{
        step: number;
        name: string;
        details: Record<string, string | number | boolean | null>;
      }>;
      productionBoundaries: {
        audit: { path: string; chainVerified: boolean };
        assets: { readBackMatched: boolean };
        persistence: Record<string, boolean>;
        providers: {
          fixtureOnly: boolean;
          liveVerified: boolean;
          packageSdk: string;
          registry: string;
          stackProfileId: string;
          durableStore: string;
          operations: Array<{
            capability: string;
            packageSdk: string;
            registryResolved: boolean;
            stackProfileId: string;
          }>;
        };
        eventPack: { installed: boolean; enabled: boolean; eventsRecorded: number };
      };
    };
    expect(trace.label).toMatch(/SYNTHETIC_FIXTURE/);
    expect(trace.productionBoundarySteps.map(({ step }) => step)).toEqual(
      Array.from({ length: FIXTURE_D_STEPS.length }, (_, index) => index + 1),
    );
    expect(trace.productionBoundarySteps.map(({ name }) => name)).toEqual(FIXTURE_D_STEPS);
    expect(trace.productionBoundarySteps[0]?.details).toMatchObject({
      materialized: true,
      materializedFiles: expect.any(Number),
      materializationPlanDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(trace.productionBoundarySteps[1]?.details).toMatchObject({
      installed: true,
      packStatus: "installed",
      packVersion: "0.2.0",
    });
    expect(Number(trace.productionBoundarySteps[0]?.details.materializedFiles)).toBeGreaterThan(0);
    expect(trace.productionBoundaries.audit).toEqual({
      path: "fixture-workspace/audit/command-chain.json",
      records: 70,
      chainVerified: true,
    });
    expect(trace.productionBoundaries.assets.readBackMatched).toBe(true);
    expect(Object.values(trace.productionBoundaries.persistence)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(trace.productionBoundaries.providers).toMatchObject({
      fixtureOnly: true,
      liveVerified: false,
      packageSdk: "@venture-harness/provider-sdk",
      registry: "@venture-harness/provider-registry",
      stackProfileId: "winner-loop-fixture-v1",
      durableStore: "file",
    });
    expect(
      trace.productionBoundaries.providers.operations.map(({ capability }) => capability),
    ).toEqual([
      "creative.video.generate",
      "distribution.content.draft",
      "distribution.content.publish",
      "ads.organic-post.boost",
      "subscription.lifecycle.read",
      "attribution.campaign.read",
    ]);
    expect(
      trace.productionBoundaries.providers.operations.every(
        ({ packageSdk, registryResolved, stackProfileId }) =>
          packageSdk === "@venture-harness/provider-sdk" &&
          registryResolved &&
          stackProfileId === "winner-loop-fixture-v1",
      ),
    ).toBe(true);
    expect(trace.productionBoundaries.eventPack).toMatchObject({
      installed: true,
      enabled: true,
      eventsRecorded: 19,
    });
    expect(trace.providerObjects).toHaveLength(3);
    expect(
      trace.providerObjects.find(({ objectKind }) => objectKind === "render_job")?.externalId,
    ).toMatch(/^fixture-render-/u);
    expect(
      trace.providerObjects.find(({ objectKind }) => objectKind === "organic_post")?.externalId,
    ).toMatch(/^fixture-publication-/u);
    expect(
      trace.providerObjects.find(({ objectKind }) => objectKind === "spark_ad")?.externalId,
    ).toMatch(/^fixture-spark-/u);
    const creativeStore = createSqliteCreativeLedgerStore(
      join(workspaceDirectory, "database", "creative-ledger.db"),
    );
    try {
      const scope = {
        organizationId: "fixture-organization",
        ventureId: contract.venture_id,
      };
      const variants = creativeStore.listVariants(scope);
      expect(variants).toHaveLength(1);
      expect(creativeStore.listProviderObjects(scope, variants[0]!.creativeId)).toHaveLength(3);
    } finally {
      creativeStore.close();
    }
    expect(traceText).not.toMatch(/cred:\/\//);
    expect(traceText).not.toMatch(/bearer|api[_-]?key|client[_-]?secret/i);
  });

  const providerFeatures = Object.keys(
    WINNER_FIXTURE_CAPABILITY_BY_FEATURE,
  ) as FixtureDProviderFeature[];

  it.each(
    providerFeatures.flatMap((feature) =>
      (["apply", "readBack"] as const).map((phase) => ({ feature, phase })),
    ),
  )("fails the domain run when package SDK $feature $phase fails", async ({ feature, phase }) => {
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "vh-fixture-d-fault-"));
    temporaryDirectories.push(workspaceDirectory);
    const tracePath = join(workspaceDirectory, "winner-loop-creative-trace.json");
    const contract = parseGrowthContract(parse(readFileSync("config/growth.yaml", "utf8")));

    await expect(
      runFixtureDThroughProductionBoundaries({
        contract,
        workspaceDirectory,
        tracePath,
        runId: `fixture-d-fault-${feature}-${phase}`,
        fixtureFault: { feature, phase },
      }),
    ).rejects.toThrow(/Fixture D workflow ended waiting: Node "fixture-run".*reconciler/u);
    expect(existsSync(tracePath)).toBe(false);

    if (feature === "paid_promote_existing_post_contract") {
      const database = new DatabaseSync(join(workspaceDirectory, "database", "spend.db"));
      try {
        const rows = database.prepare("SELECT status FROM spend_reservations").all() as Array<{
          status: string;
        }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe("pending_reconciliation");
      } finally {
        database.close();
      }
    }
  });

  it("replays a package-SDK operation from durable state after a runtime restart", async () => {
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "vh-fixture-sdk-restart-"));
    temporaryDirectories.push(workspaceDirectory);
    const storePath = join(workspaceDirectory, "provider-operations.json");
    const tenant = { organizationId: "fixture-organization", ventureId: "fixture-venture" };
    const context = {
      fixtureExecution: true,
      reviewApprovals: ["organic.direct_publish", "paid.spark_contract"] as const,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    };
    const request = {
      capability: WINNER_FIXTURE_CAPABILITY_BY_FEATURE.creative_render,
      tenant,
      environment: "fixture",
      input: { operation_id: "restart-render", payload: { creative_id: "fixture-creative" } },
      idempotencyKey: "restart-render-key",
    };

    const firstRuntime = createWinnerFixtureCapabilityRuntime({ storePath, context });
    const firstAdapter = firstRuntime.registry.resolve(request.capability, firstRuntime.profile);
    const firstPlan = await firstAdapter.plan(request);
    const firstApply = await firstAdapter.apply(request, firstPlan);
    expect(firstApply.state).toBe("applied");
    expect(firstApply.evidence?.reused).toBe(false);

    const restartedRuntime = createWinnerFixtureCapabilityRuntime({ storePath, context });
    const restartedAdapter = restartedRuntime.registry.resolve(
      request.capability,
      restartedRuntime.profile,
    );
    const restartedPlan = await restartedAdapter.plan(request);
    const replay = await restartedAdapter.apply(request, restartedPlan);
    const reconciliation = await restartedAdapter.reconcile(request);
    expect(replay.state).toBe("applied");
    expect(replay.evidence?.reused).toBe(true);
    expect(reconciliation).toMatchObject({
      state: "verified",
      evidence: { reapplied: false, fixtureOnly: true },
    });
    expect(restartedRuntime.providerStore.size()).toBe(1);
  });

  it("isolates same-key fixture provider state for two organizations across restart", async () => {
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "vh-fixture-sdk-tenants-"));
    temporaryDirectories.push(workspaceDirectory);
    const storePath = join(workspaceDirectory, "provider-operations.json");
    const context = {
      fixtureExecution: true,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    };
    const base = {
      capability: WINNER_FIXTURE_CAPABILITY_BY_FEATURE.creative_render,
      environment: "fixture" as const,
      input: { operation_id: "shared-render", payload: { creative_id: "shared-creative" } },
      idempotencyKey: "shared-render-key",
    };
    const alpha = {
      ...base,
      tenant: { organizationId: "org-alpha", ventureId: "shared-venture" },
    };
    const bravo = {
      ...base,
      tenant: { organizationId: "org-bravo", ventureId: "shared-venture" },
    };

    const runtime = createWinnerFixtureCapabilityRuntime({ storePath, context });
    const adapter = runtime.registry.resolve(base.capability, runtime.profile);
    const alphaPlan = await adapter.plan(alpha);
    const bravoPlan = await adapter.plan(bravo);
    expect((alphaPlan as { requestHash: string }).requestHash).not.toBe(
      (bravoPlan as { requestHash: string }).requestHash,
    );
    expect(await adapter.apply(alpha, alphaPlan)).toMatchObject({
      state: "applied",
      evidence: { reused: false },
    });
    expect(await adapter.apply(bravo, bravoPlan)).toMatchObject({
      state: "applied",
      evidence: { reused: false },
    });
    expect(runtime.providerStore.size()).toBe(2);

    const restarted = createWinnerFixtureCapabilityRuntime({ storePath, context });
    const restartedAdapter = restarted.registry.resolve(base.capability, restarted.profile);
    expect(await restartedAdapter.apply(alpha, await restartedAdapter.plan(alpha))).toMatchObject({
      state: "applied",
      evidence: { reused: true },
    });
    expect(await restartedAdapter.apply(bravo, await restartedAdapter.plan(bravo))).toMatchObject({
      state: "applied",
      evidence: { reused: true },
    });
    expect(restarted.providerStore.size()).toBe(2);
  });

  it("rejects credential-shaped Fixture-D requests before a durable provider row exists", async () => {
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "vh-fixture-sdk-credential-"));
    temporaryDirectories.push(workspaceDirectory);
    const storePath = join(workspaceDirectory, "provider-operations.sqlite");
    const runtime = createWinnerFixtureCapabilityRuntime({
      storePath,
      context: { fixtureExecution: true },
    });
    const request = {
      capability: WINNER_FIXTURE_CAPABILITY_BY_FEATURE.creative_render,
      tenant: { organizationId: "fixture-organization", ventureId: "fixture-venture" },
      environment: "fixture",
      input: {
        operation_id: "credential-shaped-render",
        payload: { creative_id: "whsec_SYNTHETICNOTAREALsecondaryrotation" },
      },
      idempotencyKey: "credential-shaped-render",
    };
    const adapter = runtime.registry.resolve(request.capability, runtime.profile);
    await expect(adapter.plan(request)).rejects.toMatchObject({
      code: "unsafe_fixture_payload",
    });
    expect(runtime.providerStore.size()).toBe(0);
    expect(
      readFileSync(storePath).includes(Buffer.from("whsec_SYNTHETICNOTAREALsecondaryrotation")),
    ).toBe(false);
  });

  it("serializes provider, command, and asset writes across synchronized processes", async () => {
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "vh-fixture-sdk-processes-"));
    temporaryDirectories.push(workspaceDirectory);
    const providerPath = join(workspaceDirectory, "provider.sqlite");
    const commandPath = join(workspaceDirectory, "commands.sqlite");
    const assetPath = join(workspaceDirectory, "assets.sqlite");
    const startPath = join(workspaceDirectory, "start");
    const workers = [
      fixtureStoreWorker("provider", providerPath, startPath, "provider-a", 12),
      fixtureStoreWorker("provider", providerPath, startPath, "provider-b", 12),
      fixtureStoreWorker("command", commandPath, startPath, "command-a", 12),
      fixtureStoreWorker("command", commandPath, startPath, "command-b", 12),
      fixtureStoreWorker("asset", assetPath, startPath, "asset-a", 24),
      fixtureStoreWorker("asset", assetPath, startPath, "asset-b", 24),
    ];
    writeFileSync(startPath, "go", "utf8");
    const results = await Promise.all(workers);
    expect(results.map(({ exitCode }) => exitCode)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(results.every(({ output }) => output.status === "success")).toBe(true);

    const providerStore = createWinnerFixtureCapabilityRuntime({
      storePath: providerPath,
      context: { fixtureExecution: true },
    }).providerStore;
    expect(providerStore.size()).toBe(24);

    const commandStore = new FileFixtureCommandIdempotencyStore(commandPath);
    try {
      for (const prefix of ["command-a", "command-b"]) {
        for (let index = 0; index < 12; index += 1) {
          const key = `${prefix}-${index}`;
          const requestHash = `sha256:${createHash("sha256").update(`${key}:same`).digest("hex")}`;
          expect(
            commandStore.claim(key, {
              requestHash,
              ownerToken: "restart-reader",
              now: "2026-08-09T12:01:00.000Z",
            }),
          ).toMatchObject({ kind: "replay", record: { output: { accepted: true, key } } });
        }
      }
    } finally {
      commandStore.close();
    }

    const assetStore = new FileFixtureAssetVault(assetPath);
    const tenant = { organizationId: "fixture-worker-org", ventureId: "fixture-worker-venture" };
    for (const prefix of ["asset-a", "asset-b"]) {
      for (let index = 0; index < 24; index += 1) {
        const key = `${prefix}-${index}`;
        expect(new TextDecoder().decode(assetStore.get(tenant, key)?.bytes)).toBe(
          `fixture-${key}-same`,
        );
      }
    }
  }, 30_000);

  it("binds synchronized same keys to one provider request and one asset payload", async () => {
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "vh-fixture-sdk-conflict-"));
    temporaryDirectories.push(workspaceDirectory);
    const providerPath = join(workspaceDirectory, "provider.sqlite");
    const commandPath = join(workspaceDirectory, "commands.sqlite");
    const commandConflictPath = join(workspaceDirectory, "command-conflict.sqlite");
    const assetPath = join(workspaceDirectory, "assets.sqlite");
    const providerStart = join(workspaceDirectory, "provider-start");
    const sameProvider = [
      fixtureStoreWorker("provider", providerPath, providerStart, "shared-provider", 1, "same"),
      fixtureStoreWorker("provider", providerPath, providerStart, "shared-provider", 1, "same"),
    ];
    writeFileSync(providerStart, "go", "utf8");
    expect((await Promise.all(sameProvider)).map(({ exitCode }) => exitCode)).toEqual([0, 0]);

    const conflictStart = join(workspaceDirectory, "conflict-start");
    const conflictingProvider = [
      fixtureStoreWorker("provider", providerPath, conflictStart, "conflicting-provider", 1, "a"),
      fixtureStoreWorker("provider", providerPath, conflictStart, "conflicting-provider", 1, "b"),
    ];
    writeFileSync(conflictStart, "go", "utf8");
    const providerConflictResults = await Promise.all(conflictingProvider);
    expect(providerConflictResults.filter(({ exitCode }) => exitCode === 0)).toHaveLength(1);
    expect(providerConflictResults.find(({ exitCode }) => exitCode !== 0)?.output.message).toMatch(
      /bound to different input/,
    );

    const commandStart = join(workspaceDirectory, "command-start");
    const sameCommand = [
      fixtureStoreWorker("command", commandPath, commandStart, "shared-command", 1, "same"),
      fixtureStoreWorker("command", commandPath, commandStart, "shared-command", 1, "same"),
    ];
    writeFileSync(commandStart, "go", "utf8");
    const sameCommandResults = await Promise.all(sameCommand);
    expect(sameCommandResults.map(({ exitCode }) => exitCode)).toEqual([0, 0]);
    expect(
      sameCommandResults
        .flatMap(({ output }) => output.outcomes ?? [])
        .filter((kind) => kind === "owner"),
    ).toHaveLength(1);
    const restartedCommand = new FileFixtureCommandIdempotencyStore(commandPath);
    try {
      const key = "shared-command-0";
      const requestHash = `sha256:${createHash("sha256").update(`${key}:same`).digest("hex")}`;
      expect(
        restartedCommand.claim(key, {
          requestHash,
          ownerToken: "restart-owner",
          now: "2026-08-09T12:01:00.000Z",
        }),
      ).toMatchObject({ kind: "replay" });
    } finally {
      restartedCommand.close();
    }

    const commandConflictStart = join(workspaceDirectory, "command-conflict-start");
    const conflictingCommands = [
      fixtureStoreWorker(
        "command",
        commandConflictPath,
        commandConflictStart,
        "conflicting-command",
        1,
        "a",
      ),
      fixtureStoreWorker(
        "command",
        commandConflictPath,
        commandConflictStart,
        "conflicting-command",
        1,
        "b",
      ),
    ];
    writeFileSync(commandConflictStart, "go", "utf8");
    const commandConflictResults = await Promise.all(conflictingCommands);
    expect(commandConflictResults.map(({ exitCode }) => exitCode)).toEqual([0, 0]);
    expect(commandConflictResults.flatMap(({ output }) => output.outcomes ?? []).sort()).toEqual([
      "conflict",
      "owner",
    ]);

    const assetStart = join(workspaceDirectory, "asset-start");
    const conflictingAssets = [
      fixtureStoreWorker("asset", assetPath, assetStart, "shared-asset", 1, "a"),
      fixtureStoreWorker("asset", assetPath, assetStart, "shared-asset", 1, "b"),
    ];
    writeFileSync(assetStart, "go", "utf8");
    const assetConflictResults = await Promise.all(conflictingAssets);
    expect(assetConflictResults.filter(({ exitCode }) => exitCode === 0)).toHaveLength(1);
    expect(assetConflictResults.find(({ exitCode }) => exitCode !== 0)?.output.message).toMatch(
      /bound to different content/,
    );
  }, 30_000);

  it("rejects a legacy fixture provider file with no organization scope", () => {
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "vh-fixture-sdk-legacy-"));
    temporaryDirectories.push(workspaceDirectory);
    const storePath = join(workspaceDirectory, "provider-operations.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        records: [
          {
            adapterId: "fixture_local_renderer",
            ventureId: "shared-venture",
            operationId: "legacy-operation",
            idempotencyKey: "legacy-key",
            requestHash: "0".repeat(64),
          },
        ],
      }),
    );

    const runtime = createWinnerFixtureCapabilityRuntime({
      storePath,
      context: { fixtureExecution: true },
    });
    expect(() => runtime.providerStore.size()).toThrow(/rejected legacy unsafe non-SQLite data/);

    writeFileSync(
      storePath,
      JSON.stringify({
        version: 2,
        records: [
          {
            adapterId: "fixture_local_renderer",
            tenant: {
              organizationId: "__legacy_unscoped__",
              ventureId: "shared-venture",
            },
            operationId: "legacy-operation",
            idempotencyKey: "legacy-key",
            requestHash: "0".repeat(64),
            feature: "creative_render",
            output: {},
            appliedAt: "2026-08-09T08:00:00.000Z",
            fixtureLabel: "SYNTHETIC_FIXTURE — no provider was contacted",
          },
        ],
      }),
    );
    expect(() => runtime.providerStore.size()).toThrow(/rejected legacy unsafe non-SQLite data/i);
  });

  it("persists command idempotency and fixture assets across process-local restarts", () => {
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "vh-fixture-local-stores-"));
    temporaryDirectories.push(workspaceDirectory);
    const commandPath = join(workspaceDirectory, "commands.json");
    const assetPath = join(workspaceDirectory, "assets.json");
    const tenant = { organizationId: "fixture-organization", ventureId: "fixture-venture" };

    const firstCommandStore = new FileFixtureCommandIdempotencyStore(commandPath);
    expect(
      firstCommandStore.claim("scoped-command-key", {
        requestHash: "sha256:fixture",
        ownerToken: "fixture-owner",
        now: "2026-08-09T12:00:00.000Z",
      }),
    ).toMatchObject({ kind: "owner", ownerToken: "fixture-owner" });
    firstCommandStore.complete("scoped-command-key", {
      requestHash: "sha256:fixture",
      ownerToken: "fixture-owner",
      output: { accepted: true },
      occurredAt: "2026-08-09T12:00:00.000Z",
      completedAt: "2026-08-09T12:00:01.000Z",
      actorId: "fixture-operator",
      artifactsEmittedAt: "2026-08-09T12:00:02.000Z",
    });
    expect(
      new FileFixtureCommandIdempotencyStore(commandPath).claim("scoped-command-key", {
        requestHash: "sha256:fixture",
        ownerToken: "restart-owner",
        now: "2026-08-09T12:00:03.000Z",
      }),
    ).toMatchObject({
      kind: "replay",
      record: { requestHash: "sha256:fixture", output: { accepted: true } },
    });

    new FileFixtureAssetVault(assetPath).put(
      tenant,
      "fixture-asset",
      "text/plain",
      new TextEncoder().encode("fixture bytes"),
    );
    const restartedAsset = new FileFixtureAssetVault(assetPath).get(tenant, "fixture-asset");
    expect(restartedAsset?.mediaType).toBe("text/plain");
    expect(new TextDecoder().decode(restartedAsset?.bytes)).toBe("fixture bytes");
  });

  it("rejects legacy command/asset JSON and credential-like command output before persistence", () => {
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "vh-fixture-local-unsafe-"));
    temporaryDirectories.push(workspaceDirectory);
    const legacyCommandPath = join(workspaceDirectory, "legacy-commands.json");
    const legacyAssetPath = join(workspaceDirectory, "legacy-assets.json");
    writeFileSync(legacyCommandPath, JSON.stringify({ version: 2, entries: {} }));
    writeFileSync(legacyAssetPath, JSON.stringify({ version: 1, assets: [] }));
    expect(() => new FileFixtureCommandIdempotencyStore(legacyCommandPath)).toThrow(
      /rejected legacy unsafe non-SQLite data/,
    );
    expect(() => new FileFixtureAssetVault(legacyAssetPath)).toThrow(
      /rejected legacy unsafe non-SQLite data/,
    );

    const commandPath = join(workspaceDirectory, "commands.sqlite");
    const store = new FileFixtureCommandIdempotencyStore(commandPath);
    try {
      expect(
        store.claim("unsafe-command", {
          requestHash: "sha256:unsafe-command",
          ownerToken: "unsafe-owner",
          now: "2026-08-09T12:00:00.000Z",
        }),
      ).toMatchObject({ kind: "owner" });
      expect(() =>
        store.complete("unsafe-command", {
          requestHash: "sha256:unsafe-command",
          ownerToken: "unsafe-owner",
          output: { receiptHint: "whsec_SYNTHETICNOTAREALsecondaryrotation" },
          occurredAt: "2026-08-09T12:00:00.000Z",
          completedAt: "2026-08-09T12:00:01.000Z",
          actorId: "fixture-operator",
          artifactsEmittedAt: null,
        }),
      ).toThrow("unsafe fixture command output rejected");
    } finally {
      store.close();
    }
    expect(
      readFileSync(commandPath).includes(Buffer.from("whsec_SYNTHETICNOTAREALsecondaryrotation")),
    ).toBe(false);
    const database = new DatabaseSync(commandPath);
    try {
      expect(
        database
          .prepare("SELECT state, output_json FROM command_idempotency WHERE ledger_key = ?")
          .get("unsafe-command"),
      ).toEqual({ state: "pending", output_json: null });
    } finally {
      database.close();
    }
  });
});
