import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryAuditChain } from "../packages/audit/src/index";
import { InMemoryAssetVault } from "../packages/assets/src/index";
import { assertActiveSubscription } from "../packages/billing/src/index";
import { defineRuntimeSchema } from "../packages/config/src/index";
import { activeConnection, selectCommandGrant } from "../packages/connections/src/index";
import { tenantKey, type CommandExecutionContext } from "../packages/core/src/index";
import { assertCredentialAccess } from "../packages/credentials/src/index";
import { assertEntitlements } from "../packages/entitlements/src/index";
import { evaluateMinimum } from "../packages/evaluations/src/index";
import { InMemoryEventLog } from "../packages/events/src/index";
import { runBoundedLoop } from "../packages/loops/src/index";
import { runMigrations } from "../packages/migrations/src/index";
import { assertOrganizationMembership } from "../packages/organizations/src/index";
import { InMemoryPackRegistry, definePack } from "../packages/pack-runtime/src/index";
import { decideScopes } from "../packages/policy/src/index";
import { ProviderCapabilityRegistry } from "../packages/provider-registry/src/index";
import {
  defineCapability,
  type ProviderCapabilityAdapter,
} from "../packages/provider-sdk/src/index";
import { planSeedMaterialization, recordSeedManifest } from "../packages/seed-runtime/src/index";
import { InMemoryMeteringSink } from "../packages/telemetry/src/index";
import { planOwnedFileUpgrade } from "../packages/upgrades/src/index";
import { LocalWorkflowBackend } from "../packages/workflow-backend-local/src/index";
import { createVentureRuntime, ventureCommandContracts } from "../packages/agent-runtime/src/index";
import { createAgentGateway } from "../packages/agent-gateway/src/index";
import { createApiApplication } from "../apps/api/src/index";
import { createControlPlaneModel } from "../apps/control-plane/src/index";
import { createCommandDocumentation } from "../apps/docs/src/index";
import { createFleetCanaryPlan } from "../apps/fleet-controller/src/index";
import { createWorker } from "../apps/worker/src/index";

const context: CommandExecutionContext = {
  identity: { actorId: "actor-1", kind: "user" },
  tenant: { organizationId: "org-1", ventureId: "venture-1" },
  subscription: { subscriptionId: "sub-1", status: "active", plan: "pro" },
  entitlements: ["campaigns.launch", "launch.execute"],
  scopes: ["campaigns:write", "launch:execute"],
  grants: [
    {
      grantId: "grant-1",
      commandIds: ["campaigns.launch", "launch.execute"],
      scopes: ["campaigns:write", "launch:execute"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  ],
};

function runtime() {
  return createVentureRuntime({
    commandExecutionMode: "fixture",
    memberships: [{ organizationId: "org-1", actorId: "actor-1", role: "owner", active: true }],
  });
}

describe("workspace packages expose executable boundaries", () => {
  it("executes the low-level tenant, policy, evidence, asset, and credential contracts", () => {
    expect(tenantKey(context.tenant)).toBe("org-1:venture-1");
    expect(() => tenantKey({ organizationId: "org:alpha", ventureId: "venture" })).toThrow(
      "organizationId must be a canonical tenant identifier",
    );
    expect(() => tenantKey({ organizationId: "org", ventureId: "alpha:venture" })).toThrow(
      "ventureId must be a canonical tenant identifier",
    );
    expect(() => tenantKey({ organizationId: "../org", ventureId: "../../venture" })).toThrow(
      "organizationId must be a canonical tenant identifier",
    );
    expect(() => tenantKey({ organizationId: " org-1 ", ventureId: "venture-1" })).toThrow(
      "organizationId must not contain leading or trailing whitespace",
    );
    const schema = defineRuntimeSchema({
      name: "String",
      jsonSchema: { type: "string" },
      parse: String,
    });
    expect(schema.parse(42)).toBe("42");
    expect(
      assertOrganizationMembership(context.identity, context.tenant, [
        { organizationId: "org-1", actorId: "actor-1", role: "owner", active: true },
      ]),
    ).toMatchObject({ role: "owner" });
    expect(assertActiveSubscription(context.subscription).plan).toBe("pro");
    expect(assertEntitlements(context.entitlements, ["campaigns.launch"])).toBe(
      context.entitlements,
    );
    expect(decideScopes(context, ["campaigns:write"]).allowed).toBe(true);
    expect(
      selectCommandGrant(context.grants, "campaigns.launch", ["campaigns:write"]).grantId,
    ).toBe("grant-1");
    expect(
      activeConnection({
        connectionId: "connection-1",
        organizationId: "org-1",
        ventureId: "venture-1",
        provider: "fixture",
        credentialRef: "cred://fixture/tenant",
        status: "active",
      }).connectionId,
    ).toBe("connection-1");
    expect(
      assertCredentialAccess(
        {
          ref: "cred://fixture/tenant",
          tenant: context.tenant,
          provider: "fixture",
          scopes: ["write"],
        },
        context.tenant,
        ["write"],
      ).provider,
    ).toBe("fixture");

    const events = new InMemoryEventLog();
    events.append({
      eventId: "event-1",
      tenant: context.tenant,
      type: "fixture",
      occurredAt: new Date().toISOString(),
      payload: {},
    });
    expect(events.read(context.tenant)).toHaveLength(1);
    const audit = new InMemoryAuditChain();
    audit.append({
      tenant: context.tenant,
      actorId: "actor-1",
      action: "fixture",
      outcome: "succeeded",
      occurredAt: new Date().toISOString(),
      details: {},
    });
    expect(audit.verify(context.tenant)).toBe(true);
    const assets = new InMemoryAssetVault();
    expect(
      assets.put(context.tenant, "asset-1", "text/plain", new TextEncoder().encode("safe")).sha256,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(assets.get(context.tenant, "asset-1")?.mediaType).toBe("text/plain");
    const meter = new InMemoryMeteringSink();
    meter.record({
      tenant: context.tenant,
      commandId: "fixture.run",
      meter: "runs",
      quantity: 1,
      occurredAt: new Date().toISOString(),
    });
    expect(meter.read(context.tenant)).toHaveLength(1);
  });

  it("resolves provider capabilities, persists workflow checkpoints, and executes an orchestrated command", async () => {
    const capability = defineCapability({
      id: "campaign.delivery.publish",
      schemaVersion: 1,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      environments: ["fixture"],
      requiredScopes: ["publish"],
      rateClass: "standard",
      concurrencyGroup: "publishing",
      timeoutMs: 1_000,
      redactionPaths: [],
      unknownOutcome: "read_back_then_retry",
    });
    const adapter: ProviderCapabilityAdapter = {
      providerId: "fixture-provider",
      capabilities: [capability],
      discover: async () => ({}),
      estimate: async () => ({ amount: 0, currency: "EUR", known: true }),
      plan: async () => ({}),
      apply: async () => ({ state: "applied", retryable: false }),
      readBack: async () => ({ state: "verified", retryable: false }),
      reconcile: async () => ({ state: "verified", retryable: false }),
      compensate: async () => ({ state: "compensated", retryable: false }),
    };
    const providers = new ProviderCapabilityRegistry();
    providers.register(adapter);
    expect(
      providers.resolve(capability.id, {
        profileId: "fixture-stack",
        providersByCapability: { [capability.id]: [adapter.providerId] },
      }).providerId,
    ).toBe("fixture-provider");

    const backend = new LocalWorkflowBackend(mkdtempSync(join(tmpdir(), "vh-workspace-backend-")));
    const worker = createWorker(runtime());
    const result = await worker.execute({
      plan: {
        runId: "run-1",
        steps: [
          {
            id: "campaign",
            commandId: "campaigns.launch",
            input: { campaignId: "c1", channel: "organic", objective: "proof" },
          },
        ],
      },
      invocation: { context, idempotencyKey: "orchestrator-1" },
      backend,
    });
    expect(result).toMatchObject({ runId: "run-1", status: "succeeded" });
    expect(await backend.load(context.tenant, "run-1")).toMatchObject({ sequence: 1 });
  });

  it("runs pack, seed, migration, upgrade, loop, and evaluation primitives", async () => {
    const packs = new InMemoryPackRegistry();
    const pack = definePack({
      id: "campaign-launch",
      version: "1.0.0",
      commands: [ventureCommandContracts[0]],
      migrations: ["001"],
      contributions: { ui: true },
    });
    expect(packs.install(pack)).toBe("installed");
    expect(packs.install(pack)).toBe("already_installed");
    expect(packs.uninstall(pack.id)).toBe(true);

    const seed = {
      id: "web",
      version: "1.0.0",
      rail: "web" as const,
      files: [
        { path: "app/page.tsx", content: "export default 1", ownership: "venture-owned" as const },
      ],
    };
    expect(planSeedMaterialization(seed)).toHaveLength(1);
    expect(recordSeedManifest(new InMemoryAssetVault(), context.tenant, seed).mediaType).toBe(
      "application/json",
    );

    expect(
      runMigrations({ value: 1 }, 1, 2, [
        { id: "001", fromVersion: 1, toVersion: 2, migrate: (state) => ({ ...state, value: 2 }) },
      ]),
    ).toEqual({ value: 2 });
    expect(
      planOwnedFileUpgrade({
        path: "config.txt",
        ownership: "merge-managed",
        base: "a\nb",
        current: "a-local\nb",
        next: "a\nb-next",
      }),
    ).toMatchObject({ action: "merge", result: "a-local\nb-next" });
    expect(
      await runBoundedLoop({
        initial: { count: 0 },
        maximumIterations: 3,
        step: (state) => ({ count: Number(state.count) + 1 }),
        stop: (state) => state.count === 2,
      }),
    ).toMatchObject({ state: { count: 2 }, iterations: 2, stopReason: "condition" });
    expect(evaluateMinimum("activation", null, 10).outcome).toBe("insufficient_evidence");
  });

  it("builds all five app views from package consumers", () => {
    const ventureRuntime = runtime();
    const controlPlane = createControlPlaneModel(ventureRuntime);
    expect(controlPlane.app).toBe("control-plane");
    expect(controlPlane.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ actionId: "campaigns.launch" })]),
    );
    expect(createApiApplication(ventureRuntime).app).toBe("api");
    expect(createCommandDocumentation(ventureRuntime)).toMatchObject({
      app: "docs",
      title: "Venture command reference",
    });
    expect(
      createFleetCanaryPlan({
        release: "0.3.0",
        ventures: ["canary", "v2", "v3"],
        batchSize: 1,
        files: [],
      }),
    ).toMatchObject({ canaryVentureId: "canary", batches: [["v2"], ["v3"]] });
    expect(createAgentGateway(ventureRuntime).sdk.commands.campaigns).toHaveProperty("launch");
  });
});
