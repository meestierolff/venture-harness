import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandHandlerContext } from "@venture-harness/command-bus";
import { createHarnessLock } from "@/lib/config/harness-lock";
import {
  CredentialBroker,
  MemoryCredentialBackend,
  type CredentialTester,
} from "@/lib/credentials";
import {
  createAuthCommandRuntime,
  createFleetCommandRuntime,
  createUpgradeCommandRuntime,
} from "@/lib/cli/platform-command-runtime";
import { createDefaultCliServices } from "@/lib/cli/default-services";
import {
  createCoreReleaseManifest,
  createFleetController,
  createMemoryFleetStateStore,
  type FleetVenture,
} from "@/lib/fleet";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const handlerContext: CommandHandlerContext = {
  commandId: "fixture.command",
  occurredAt: "2026-08-09T10:00:00.000Z",
  idempotencyKey: "fixture-key",
  context: {
    identity: { actorId: "operator", kind: "user" },
    tenant: { organizationId: "company-fixture", ventureId: "control-plane" },
    subscription: { subscriptionId: "operator", status: "active", plan: "operator" },
    entitlements: [],
    scopes: [],
    grants: [],
  },
};

describe("root platform command adapters", () => {
  it("routes auth through the existing broker/catalog service without exposing values", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-platform-auth-"));
    directories.push(root);
    mkdirSync(join(root, ".venture"), { recursive: true });
    const backend = new MemoryCredentialBackend();
    const broker = new CredentialBroker([backend]);
    await broker.store({
      ref: "cred://github/default",
      provider: "github",
      kind: "api_key",
      backend: "memory",
      scopes: ["repo.read"],
      value: "fixture-secret-never-return",
    });
    const tester: CredentialTester = async (secret) => ({
      ok: secret === "fixture-secret-never-return",
      accountId: "fixture-account",
      scopes: ["repo.read"],
    });
    const services = createDefaultCliServices({
      rootDir: root,
      credentialCatalogPath: join(root, ".venture", "credentials.json"),
      credentialBroker: broker,
      credentialTesters: { github: tester },
      now: () => new Date("2026-08-09T10:00:00.000Z"),
    });
    const runtime = createAuthCommandRuntime(services);
    const login = await runtime.execute(
      "login",
      {
        providerId: "github",
        credentialRef: "cred://github/default",
        backend: "memory",
        kind: "api_key",
        scopes: ["repo.read"],
      },
      handlerContext,
    );
    const tested = await runtime.execute(
      "test",
      { providerId: "github", credentialRef: "cred://github/default" },
      handlerContext,
    );
    const status = await runtime.execute("status", { providerId: "github" }, handlerContext);

    expect(login).toMatchObject({ status: "authenticated", effect: "applied" });
    expect(tested).toMatchObject({ status: "test_completed", effect: "applied" });
    expect(status).toMatchObject({ status: "available", effect: "none" });
    expect(JSON.stringify({ login, tested, status })).not.toContain("fixture-secret-never-return");
    expect(tested.data).toMatchObject({
      tested: [{ ref: "cred://github/default", mode: "remote_tester", result: { ok: true } }],
      valuesExposed: false,
    });
  });

  it("uses the trusted local upgrade service and reports lock status without fetching", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-platform-upgrade-"));
    directories.push(root);
    const calls: { dryRun: boolean; releasePath?: string }[] = [];
    const runtime = createUpgradeCommandRuntime({
      rootDir: root,
      services: {
        upgrade(options) {
          calls.push(options);
          return {
            status: options.dryRun ? "planned" : "applied",
            dryRun: options.dryRun,
            fromVersion: "0.2.0",
            toVersion: "0.3.0",
            lockUpdated: !options.dryRun,
          };
        },
      },
    });
    const plan = await runtime.execute(
      "plan",
      { releaseLocator: "../trusted-release" },
      handlerContext,
    );
    const apply = await runtime.execute(
      "apply",
      { releaseLocator: "../trusted-release" },
      handlerContext,
    );
    const status = await runtime.execute("status", {}, handlerContext);

    expect(calls).toEqual([
      { dryRun: true, releasePath: "../trusted-release" },
      { dryRun: false, releasePath: "../trusted-release" },
    ]);
    expect(plan).toMatchObject({ status: "planned", effect: "none" });
    expect(apply).toMatchObject({ status: "applied", effect: "applied" });
    expect(status).toMatchObject({ status: "unlocked", effect: "none" });
  });

  it("binds Fleet selection to the command organization and reaches the durable controller", async () => {
    const store = createMemoryFleetStateStore();
    const controller = createFleetController({
      store,
      now: () => new Date("2026-08-09T10:00:00.000Z"),
      controllerId: "fixture-controller",
    });
    const release = createCoreReleaseManifest({
      schemaVersion: 1,
      version: "0.3.0",
      sourceRef: "v0.3.0",
      workflowRefSha: "a".repeat(40),
      changedPackages: {},
      affectedCapabilities: ["not-enabled"],
      migrations: [],
      compatibility: { minimumCoreVersion: "0.2.0", seedIds: ["web-saas"] },
      requiredChecks: ["fixture-check"],
      rolloutRisk: "low",
      rollback: { mode: "forward_fix", version: null },
      files: [{ path: "core.txt", ownership: "core_owned", content: "core 0.3\n" }],
    });
    const hooks = new Proxy(
      {},
      {
        get() {
          return async () => {
            throw new Error("unaffected Fleet fixture must not invoke hooks");
          };
        },
      },
    ) as FleetVenture["hooks"];
    const venture = (organizationId: string): FleetVenture => ({
      organizationId,
      ventureId: "same-slug",
      repository: `${organizationId}/same-slug`,
      designFingerprint: `design-${organizationId}`,
      serviceBlueprintFingerprint: `blueprint-${organizationId}`,
      capabilities: ["different-capability"],
      providers: [],
      currentLock: createHarnessLock(),
      fileSystem: {
        readText: async () => null,
        writeAtomic: async () => undefined,
        remove: async () => undefined,
      },
      canary: true,
      policy: { automaticMerge: false, productionDeployment: false },
      hooks,
      deployedHealth: async () => ({ healthy: true, version: "0.2.0" }),
    });
    let resolved = [venture("company-fixture")];
    const runtime = createFleetCommandRuntime({
      store,
      controller,
      resolveRelease: (releaseId) => (releaseId === "release-fixture" ? release : null),
      resolveVentures: () => resolved,
    });
    const input = {
      runId: "fleet-command-run",
      releaseId: "release-fixture",
      ventureIds: ["same-slug"],
      batchSize: 1,
    };
    const plan = await runtime.execute("plan", input, handlerContext);
    const rollout = await runtime.execute("rollout", input, handlerContext);
    const status = await runtime.execute("status", { runId: "fleet-command-run" }, handlerContext);
    expect(plan).toMatchObject({
      status: "planned",
      effect: "none",
      data: { hooksInvoked: false },
    });
    expect(rollout).toMatchObject({ status: "completed", effect: "applied" });
    expect(status).toMatchObject({ status: "completed", effect: "none" });

    resolved = [venture("other-company")];
    const crossOrganization = await runtime.execute(
      "plan",
      { ...input, runId: "fleet-cross-organization" },
      handlerContext,
    );
    expect(crossOrganization).toMatchObject({
      status: "blocked",
      effect: "none",
      data: { diagnostic: { code: "fleet_target_scope_mismatch" } },
    });
    expect(store.get("fleet-cross-organization")).toBeNull();
    store.close();
  });
});
