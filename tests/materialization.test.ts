import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVentureRuntime } from "../packages/agent-runtime/src/index";
import type { CommandExecutionContext } from "../packages/core/src/index";
import { parseHarnessLock } from "@/lib/config/harness-lock";
import { CredentialBroker, MemoryCredentialBackend, Redactor } from "@/lib/credentials";
import {
  NodeMaterializationFileSystem,
  PACKS,
  VENTURE_SEEDS,
  assertLaunchEffectAuthorized,
  compileVentureMaterialization,
  createLaunchGrant,
  createMemoryOnePromptLaunchStore,
  emptyPackInstallationState,
  executeLaunchEffects,
  executeOnePromptVentureLaunch,
  installPack,
  materializeVenture,
  parseLaunchGrant,
  revokeLaunchGrant,
  type LaunchEffect,
  type LaunchEffectEvidence,
  type LaunchGrant,
  type LaunchGrantInput,
  type MaterializationFileSystem,
} from "@/lib/materialization";
import {
  ProviderRegistryLaunchEffectExecutor,
  type LaunchModelUsage,
  type LaunchProviderEffectRequest,
  type ProviderLaunchEffectEvidence,
} from "@/lib/materialization/provider-effects";
import {
  MockProviderTransport,
  ProviderRegistry,
  founderDefaultStackProfile,
  genericDnsStackProfile,
  providerRegistry,
  type ProviderAdapter,
  type ProviderOperation,
  type ProviderPlan,
  type ProviderStackProfile,
} from "@/lib/providers";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const SHA = "a".repeat(40);
const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

const effects: LaunchEffect[] = [
  "repository.create",
  "company_stack.provision",
  "source.push",
  "preview.deploy",
  "production.deploy",
  "domain.configure",
  "commerce.configure",
  "loops.schedule",
];

function grantInput(overrides: Partial<LaunchGrantInput> = {}): LaunchGrantInput {
  return {
    ownerOrganizationId: "founder-company",
    ventureName: "Payout Rank",
    ventureSlug: "payout-rank",
    ideaDigest: "b".repeat(64),
    seed: { id: "hybrid-agentic-service", version: "0.2.0" },
    stackProfile: { id: "founder-default", version: "0.2.0" },
    repository: { owner: "founder-company", name: "payout-rank", visibility: "private" },
    providerAccounts: [
      {
        capability: "source.repository.create",
        provider: "github",
        externalAccountId: "github-founder-company",
        ownerOrganizationId: "founder-company",
        stackClass: "company",
        ownership: "company_owned",
      },
      {
        capability: "hosting.web.deploy",
        provider: "vercel",
        externalAccountId: "vercel-founder-team",
        ownerOrganizationId: "founder-company",
        stackClass: "company",
        ownership: "company_owned",
      },
      {
        capability: "database.postgres.provision",
        provider: "neon",
        externalAccountId: "neon-founder-org",
        ownerOrganizationId: "founder-company",
        stackClass: "company",
        ownership: "company_owned",
      },
      {
        capability: "commerce.web_subscription",
        provider: "stripe",
        externalAccountId: "stripe-founder-account",
        ownerOrganizationId: "founder-company",
        stackClass: "company",
        ownership: "company_owned",
      },
      {
        capability: "domain.configure",
        provider: "mijndomein",
        externalAccountId: "registrar-founder-account",
        ownerOrganizationId: "founder-company",
        stackClass: "company",
        ownership: "company_owned",
      },
    ],
    autonomyProfile: "owner_live_launch",
    allowedExternalEffects: effects,
    modelBudget: { maxTokens: 100_000, maxMinorUnits: 2_000, currency: "EUR" },
    externalResourceBudget: { maxResources: 12, maxMinorUnits: 10_000, currency: "EUR" },
    permissions: {
      productionDeployment: true,
      domainConfiguration: true,
      liveCommerceConfiguration: true,
    },
    createdAt: new Date("2026-08-09T11:00:00.000Z").toISOString(),
    expiresAt: new Date("2026-08-10T12:00:00.000Z").toISOString(),
    grantedBy: { actorId: "founder-user", actorType: "founder" },
    approvalRef: "approval:synthetic-launch",
    revokedAt: null,
    ...overrides,
  };
}

function plan(
  overrides: Partial<LaunchGrantInput> = {},
  selectedEffects?: readonly LaunchEffect[],
) {
  return compileVentureMaterialization({
    grant: createLaunchGrant(grantInput(overrides)),
    at: NOW,
    coreVersion: "0.2.0",
    workflowRefSha: SHA,
    workflowRepository: "venture-harness/venture-harness",
    effects: selectedEffects,
  });
}

interface FixtureExecutorOptions {
  grant: LaunchGrant;
  directory?: string;
  stackProfile?: ProviderStackProfile;
  ledgerPath?: string;
  crashAfterWriteOnce?: boolean;
  readBackMatches?: boolean;
  estimate?: (operation: ProviderOperation) => ProviderOperation["estimatedCost"];
  transformPlan?: (plan: ProviderPlan) => ProviderPlan;
  modelUsage?: LaunchModelUsage;
}

function registryWithEstimates(
  estimate: (operation: ProviderOperation) => ProviderOperation["estimatedCost"],
  transformPlan: (plan: ProviderPlan) => ProviderPlan,
): ProviderRegistry {
  return new ProviderRegistry(
    providerRegistry.list().map((adapter): ProviderAdapter => ({
      descriptor: adapter.descriptor,
      doctor: (request, context) => adapter.doctor(request, context),
      plan: (request) => {
        const providerPlan = transformPlan(adapter.plan(request));
        return {
          ...providerPlan,
          operations: providerPlan.operations.map((operation) => ({
            ...operation,
            estimatedCost: estimate(operation),
          })),
        };
      },
      apply: (providerPlan, context) => adapter.apply(providerPlan, context),
      readBack: (report, context) => adapter.readBack(report, context),
      verify: (report, readBack) => adapter.verify(report, readBack),
    })),
  );
}

async function createFixtureProviderExecutor(input: FixtureExecutorOptions) {
  const directory = input.directory ?? mkdtempSync(join(tmpdir(), "vh-provider-effects-"));
  if (!input.directory) directories.push(directory);
  const ledgerPath = input.ledgerPath ?? join(directory, "provider-idempotency.json");
  const redactor = new Redactor();
  const credentials = new CredentialBroker([new MemoryCredentialBackend()], redactor);
  const credentialRefs: Record<string, string> = {};
  const credentialKinds = {
    github: "cli_session",
    vercel: "cli_session",
    neon: "api_key",
    stripe: "restricted_api_key",
    revenuecat: "restricted_api_key",
    eas: "cli_session",
  } as const;
  for (const account of input.grant.providerAccounts) {
    const kind = credentialKinds[account.provider as keyof typeof credentialKinds];
    if (!kind || credentialRefs[account.provider]) continue;
    const ref = `cred://${account.provider}/materialization-fixture`;
    await credentials.store({
      ref,
      provider: account.provider,
      kind,
      backend: "memory",
      accountId: account.externalAccountId,
      scopes: ["*"],
      value: `fixture-${account.provider}-secret-never-persist`,
    });
    credentialRefs[account.provider] = ref;
  }

  const externalWrites: ProviderOperation[] = [];
  const state = new Map<string, Record<string, unknown>>();
  let crashPending = input.crashAfterWriteOnce === true;
  const execute = async (operation: ProviderOperation) => {
    if (operation.action.endsWith(".search_before_create")) {
      return {
        status: "succeeded" as const,
        message: "Fixture provider found no existing deterministic resource",
        output: { data: [], has_more: false },
        verified: true,
        effectOutcome: "confirmed_no_write" as const,
      };
    }
    externalWrites.push(operation);
    const output = {
      fixture: true,
      id: `fixture-${operation.provider}-${operation.id}`,
      provider: operation.provider,
      operationId: operation.id,
    };
    state.set(operation.idempotencyKey, output);
    if (crashPending) {
      crashPending = false;
      throw new Error("fixture crash after provider write");
    }
    return {
      status: "succeeded" as const,
      message: "Fixture provider accepted the request; read-back is required",
      output,
      verified: false,
      effectOutcome: "confirmed_write" as const,
    };
  };
  const readBack = async (operation: ProviderOperation) => {
    const evidence = state.get(operation.idempotencyKey);
    return input.readBackMatches === false || !evidence
      ? {
          operationId: operation.id,
          status: "mismatched" as const,
          message: "Fixture provider state did not match",
        }
      : {
          operationId: operation.id,
          status: "matched" as const,
          message: "Fixture provider state matched the request-bound operation",
          evidence,
        };
  };
  const cli = new MockProviderTransport("cli", execute, readBack);
  const http = new MockProviderTransport("http", execute, readBack);
  const manual = new MockProviderTransport("manual", execute, readBack);
  const githubRequest: LaunchProviderEffectRequest = {
    environment: "production",
    credentialRef: credentialRefs.github,
    inputs: {
      repository: `${input.grant.repository.owner}/${input.grant.repository.name}`,
      visibility: input.grant.repository.visibility,
      sourceDirectory: directory,
    },
  };
  const requests: Partial<Record<LaunchEffect, LaunchProviderEffectRequest>> = {
    "repository.create": githubRequest,
    "source.push": githubRequest,
    "loops.schedule": githubRequest,
    "company_stack.provision": {
      environment: "production",
      credentialRef: credentialRefs.neon,
      inputs: {
        organizationId: input.grant.providerAccounts.find(
          (account) =>
            account.provider === "neon" && account.capability === "database.postgres.provision",
        )?.externalAccountId,
        projectName: input.grant.ventureSlug,
        regionId: "aws-eu-central-1",
      },
    },
    "preview.deploy": {
      environment: "preview",
      credentialRef: credentialRefs.vercel,
      inputs: { project: input.grant.ventureSlug },
    },
    "production.deploy": {
      environment: "production",
      credentialRef: credentialRefs.vercel,
      inputs: { project: input.grant.ventureSlug },
    },
    "domain.configure": {
      environment: "production",
      inputs: {
        zone: "payout-rank.example.test",
        recordType: "CNAME",
        recordName: "www",
        recordValue: "fixture-target.example.test",
        ttl: 300,
      },
    },
    "commerce.configure": {
      environment: "production",
      credentialRef: credentialRefs.stripe,
      inputs: {
        ventureSlug: input.grant.ventureSlug,
        stripeAccountId: "acct_payout_rank_live",
        stripeMode: "live",
        productName: input.grant.ventureName,
      },
    },
  };
  const executorOptions = {
    stackProfile: input.stackProfile ?? founderDefaultStackProfile,
    requests,
    ledgerPath,
    context: {
      authorization: "approved" as const,
      transports: { cli, http, manual },
      credentials,
      redactor,
    },
    fixture: true,
    registry: registryWithEstimates(
      input.estimate ??
        (() => ({ amount: 0, currency: input.grant.externalResourceBudget!.currency })),
      input.transformPlan ?? ((providerPlan) => providerPlan),
    ),
    modelUsage: input.modelUsage,
    now: () => NOW,
  };
  return {
    executor: new ProviderRegistryLaunchEffectExecutor(executorOptions),
    newExecutor: () => new ProviderRegistryLaunchEffectExecutor(executorOptions),
    externalWrites,
    transports: { cli, http, manual },
    directory,
    ledgerPath,
  };
}

describe("Launch Grants", () => {
  it("creates an immutable, content-bound grant and detects tampering", () => {
    const grant = createLaunchGrant(grantInput());
    expect(grant.grantId).toMatch(/^lg_[a-f0-9]{26}$/);
    expect(Object.isFrozen(grant)).toBe(true);
    expect(Object.isFrozen(grant.repository)).toBe(true);
    expect(() => parseLaunchGrant({ ...grant, ventureName: "Tampered" })).toThrow(/immutable ID/);
  });

  it("never permits advertising spend and requires exact high-risk launch permissions", () => {
    expect(() =>
      createLaunchGrant(
        grantInput({
          allowedExternalEffects: [...effects, "ads.campaign.create" as LaunchEffect],
        }),
      ),
    ).toThrow();
    expect(() =>
      createLaunchGrant(
        grantInput({
          permissions: {
            productionDeployment: false,
            domainConfiguration: true,
            liveCommerceConfiguration: true,
          },
        }),
      ),
    ).toThrow(/production\.deploy/);
  });

  it("fails closed after expiry or revocation", () => {
    const grant = createLaunchGrant(grantInput());
    expect(() =>
      assertLaunchEffectAuthorized(grant, "repository.create", new Date(grant.expiresAt)),
    ).toThrow(/expired/);
    const revoked = revokeLaunchGrant(grant, NOW);
    expect(() => assertLaunchEffectAuthorized(revoked, "repository.create", NOW)).toThrow(
      /revoked/,
    );
  });

  it("rejects a provider destination not owned by the granting company", () => {
    const input = grantInput();
    expect(() =>
      createLaunchGrant({
        ...input,
        providerAccounts: [
          { ...input.providerAccounts[0]!, ownerOrganizationId: "venture-harness" },
        ],
      }),
    ).toThrow(/owned by the grant owner/);
  });
});

describe("venture seeds and materialization", () => {
  it("ships all three versioned seeds and compiles a complete v2 harness lock", () => {
    expect(Object.keys(VENTURE_SEEDS).sort()).toEqual([
      "agentic-ios-subscription",
      "agentic-web-saas",
      "hybrid-agentic-service",
    ]);
    const compiled = plan();
    expect(compiled.lock).toMatchObject({
      lock_version: 2,
      harness_version: "0.2.0",
      core_version: "0.2.0",
      seed: { id: "hybrid-agentic-service", version: "0.2.0" },
      update_channel: "stable",
      workflow_ref_sha: SHA,
      last_verified_upgrade: null,
    });
    expect(new Set(compiled.lock.managed_files.map((file) => file.ownership))).toEqual(
      new Set(["core_owned", "merge_managed", "venture_owned"]),
    );
    expect(
      parseHarnessLock(compiled.files.find((file) => file.path === "harness.lock")!.content),
    ).toEqual(compiled.lock);
    const runtimeBootstrap = compiled.files.find(
      (file) => file.path === "runtime/bootstrap.ts",
    )!.content;
    expect(runtimeBootstrap).toContain(
      'Omit<VentureRuntimeOptions, "memberships" | "recursiveCommands" | "recursiveReconcileCommands">',
    );
    expect(runtimeBootstrap).toContain('id: "payout-rank.execute"');
    expect(runtimeBootstrap).toContain('id: "payout-rank.reconcile"');
    expect(runtimeBootstrap).toContain(
      "recursiveReconcileCommands: [PRIMARY_SERVICE_RECONCILE_COMMAND]",
    );
    expect(runtimeBootstrap).not.toContain("createVentureRuntime({ memberships })");
    expect(
      JSON.parse(
        compiled.files.find((file) => file.path === "service-blueprints/primary.json")!.content,
      ),
    ).toMatchObject({ id: "payout-rank.primary", commandId: "payout-rank.execute" });
    expect(compiled.seed.runtimePackages).toMatchObject({
      "@venture-harness/agent-gateway": "0.2.0",
      "@venture-harness/api-generator": "0.2.0",
      "@venture-harness/cli-generator": "0.2.0",
      "@venture-harness/mcp-generator": "0.2.0",
      "@venture-harness/sdk-generator": "0.2.0",
      "@venture-harness/ui": "0.2.0",
    });
  });

  it("creates venture-specific identity and Agent Surface names without persisting account IDs", () => {
    const first = plan();
    const second = plan({
      ventureName: "Ship To Users",
      ventureSlug: "ship-to-users",
      repository: { owner: "founder-company", name: "ship-to-users", visibility: "private" },
      ideaDigest: "c".repeat(64),
    });
    expect(first.manifest.agentSurface).toMatchObject({
      cli: "payout-rank",
      mcpPrefix: "payout_rank",
      sdkPackage: "@payout-rank/sdk",
    });
    expect(second.manifest.agentSurface).toMatchObject({
      cli: "ship-to-users",
      mcpPrefix: "ship_to_users",
      sdkPackage: "@ship-to-users/sdk",
    });
    expect(first.planDigest).not.toBe(second.planDigest);
    const trackedOutput = first.files.map((file) => file.content).join("\n");
    expect(trackedOutput).not.toContain("github-founder-company");
    expect(trackedOutput).not.toContain("stripe-founder-account");
    expect(trackedOutput).not.toContain("founder-user");
  });

  it("writes only into an empty isolated workspace and fails closed for escaping paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-materialize-"));
    directories.push(root);
    const fileSystem = new NodeMaterializationFileSystem(root);
    const compiled = plan();
    const report = await materializeVenture(compiled, fileSystem, NOW);
    expect(report.status).toBe("materialized");
    expect(readFileSync(join(root, "venture.manifest.json"), "utf8")).toContain("Payout Rank");
    await expect(fileSystem.writeExclusive("../escape", "unsafe")).rejects.toThrow(/Unsafe/);

    const occupied = mkdtempSync(join(tmpdir(), "vh-materialize-occupied-"));
    directories.push(occupied);
    writeFileSync(join(occupied, "existing.txt"), "founder file\n");
    await expect(
      materializeVenture(compiled, new NodeMaterializationFileSystem(occupied), NOW),
    ).rejects.toThrow(/must be empty/);
    expect(readFileSync(join(occupied, "existing.txt"), "utf8")).toBe("founder file\n");
  });

  it("rolls back only files created by a failed local materialization", async () => {
    const created = new Map<string, string>();
    const removed: string[] = [];
    let writes = 0;
    const fileSystem: MaterializationFileSystem = {
      prepareEmpty: () => Promise.resolve(),
      writeExclusive: (path, content) => {
        writes += 1;
        if (writes === 4) return Promise.reject(new Error("synthetic disk failure"));
        created.set(path, content);
        return Promise.resolve();
      },
      removeCreated: (path) => {
        removed.push(path);
        created.delete(path);
        return Promise.resolve();
      },
    };
    await expect(materializeVenture(plan(), fileSystem, NOW)).rejects.toThrow(/disk failure/);
    expect(created.size).toBe(0);
    expect(removed).toHaveLength(3);
  });
});

describe("Launch Grant budget materialization", () => {
  it("keeps canonical founder policies out of the legacy hard-metered effect executor", async () => {
    const canonical = plan({
      modelBudget: undefined,
      externalResourceBudget: undefined,
      modelExecutionPolicy: {
        mode: "fixture_no_model_execution",
        maxBuildAgentTasks: 1,
        attestation: "fixture_build_host",
        usageAccounting: "none",
      },
      providerOperationBudget: {
        maxOperations: 6,
        maxDirectChargeMinorUnits: 0,
        currency: "EUR",
        estimateBasis: "reviewed_known_zero_direct_charge",
        ongoingAccountPlanUsageCovered: false,
      },
    });
    const providers = await createFixtureProviderExecutor({ grant: canonical.grant });

    expect(() => providers.executor.prepare(canonical)).toThrow(
      /canonical founder.*not the legacy hard-metered materialization-effect executor/i,
    );
    expect(providers.externalWrites).toHaveLength(0);
  });

  it("preflights the complete provider graph and deduplicates shared provider requests", async () => {
    const compiled = plan();
    const providers = await createFixtureProviderExecutor({ grant: compiled.grant });
    expect(providers.executor.prepare(compiled)).toEqual({
      model: {
        known: true,
        tokens: 0,
        costMinorUnits: 0,
        currency: "EUR",
        source: "deterministic_no_model_execution",
      },
      external: {
        resourceCount: 6,
        costMinorUnits: 0,
        currency: "EUR",
        uniqueProviderRequests: 6,
      },
    });
    expect(providers.externalWrites).toHaveLength(0);
  });

  it("rejects aggregate multi-operation resource and monetary overages before apply", async () => {
    const resourcePlan = plan({
      externalResourceBudget: { maxResources: 5, maxMinorUnits: 10_000, currency: "EUR" },
    });
    const resourceProviders = await createFixtureProviderExecutor({ grant: resourcePlan.grant });
    expect(() => resourceProviders.executor.prepare(resourcePlan)).toThrow(/6 operations/);
    expect(resourceProviders.externalWrites).toHaveLength(0);

    const monetaryPlan = plan({
      externalResourceBudget: { maxResources: 12, maxMinorUnits: 1_000, currency: "EUR" },
    });
    const monetaryProviders = await createFixtureProviderExecutor({
      grant: monetaryPlan.grant,
      estimate: () => ({ amount: 2, currency: "EUR" }),
    });
    expect(() => monetaryProviders.executor.prepare(monetaryPlan)).toThrow(/exceeding.*1000/i);
    expect(monetaryProviders.externalWrites).toHaveLength(0);
  });

  it("rejects unknown, currency-mismatched, and non-convertible provider estimates", async () => {
    const compiled = plan();
    const unknown = await createFixtureProviderExecutor({
      grant: compiled.grant,
      estimate: () => undefined,
    });
    expect(() => unknown.executor.prepare(compiled)).toThrow(/unknown cost/);

    const mismatched = await createFixtureProviderExecutor({
      grant: compiled.grant,
      estimate: () => ({ amount: 0, currency: "USD" }),
    });
    expect(() => mismatched.executor.prepare(compiled)).toThrow(/conversion is not authorized/);

    const nonConvertible = await createFixtureProviderExecutor({
      grant: compiled.grant,
      estimate: () => ({ amount: 0.001, currency: "EUR" }),
    });
    expect(() => nonConvertible.executor.prepare(compiled)).toThrow(/converted exactly/);
    expect(unknown.externalWrites).toHaveLength(0);
    expect(mismatched.externalWrites).toHaveLength(0);
    expect(nonConvertible.externalWrites).toHaveLength(0);
  });

  it("rejects duplicate provider operation IDs before any write", async () => {
    const compiled = plan({}, ["repository.create", "preview.deploy"]);
    const providers = await createFixtureProviderExecutor({
      grant: compiled.grant,
      transformPlan: (providerPlan) => ({
        ...providerPlan,
        operations: providerPlan.operations.map((operation) => ({
          ...operation,
          id: "duplicate-operation",
        })),
      }),
    });
    expect(() => providers.executor.prepare(compiled)).toThrow(/duplicate operation ID/);
    expect(providers.externalWrites).toHaveLength(0);
  });

  it("hard-stops unknown, token, monetary, and currency-mismatched model usage", async () => {
    const compiled = plan({
      modelBudget: { maxTokens: 10, maxMinorUnits: 100, currency: "EUR" },
    });
    for (const modelUsage of [
      {
        known: false,
        tokens: 0,
        costMinorUnits: 0,
        currency: "EUR",
        source: "metered" as const,
      },
      {
        known: true,
        tokens: 11,
        costMinorUnits: 0,
        currency: "EUR",
        source: "metered" as const,
      },
      {
        known: true,
        tokens: 0,
        costMinorUnits: 101,
        currency: "EUR",
        source: "metered" as const,
      },
      {
        known: true,
        tokens: 0,
        costMinorUnits: 0,
        currency: "USD",
        source: "metered" as const,
      },
    ]) {
      const providers = await createFixtureProviderExecutor({ grant: compiled.grant, modelUsage });
      expect(() => providers.executor.prepare(compiled)).toThrow();
      expect(providers.externalWrites).toHaveLength(0);
    }
  });
});

describe("synthetic launch effects and pack runtime", () => {
  it("runs the canonical one-prompt path through request-bound provider plans and read-back", async () => {
    const selectedGrant = createLaunchGrant(grantInput());
    const providers = await createFixtureProviderExecutor({ grant: selectedGrant });
    const runtime = createVentureRuntime({
      commandExecutionMode: "fixture",
      memberships: [
        {
          organizationId: "founder-company",
          actorId: "founder-user",
          role: "owner",
          active: true,
        },
      ],
      now: () => NOW,
    });
    const context: CommandExecutionContext = {
      identity: { actorId: "founder-user", kind: "user" },
      tenant: { organizationId: "founder-company", ventureId: "payout-rank" },
      subscription: { subscriptionId: "subscription-owner", status: "active", plan: "owner" },
      entitlements: ["launch.execute"],
      grants: [
        {
          grantId: selectedGrant.grantId,
          commandIds: ["launch.execute"],
          scopes: ["launch:execute"],
          expiresAt: selectedGrant.expiresAt,
        },
      ],
      scopes: ["launch:execute"],
    };
    const written = new Map<string, string>();
    let prepared = 0;
    const fileSystem: MaterializationFileSystem = {
      prepareEmpty: () => {
        prepared += 1;
        return Promise.resolve();
      },
      writeExclusive: (path, content) => {
        if (written.has(path)) return Promise.reject(new Error("duplicate write"));
        written.set(path, content);
        return Promise.resolve();
      },
      removeCreated: (path) => {
        written.delete(path);
        return Promise.resolve();
      },
    };
    const store = createMemoryOnePromptLaunchStore();
    const result = await executeOnePromptVentureLaunch({
      runtime,
      commandContext: context,
      commandIdempotencyKey: "one-prompt",
      grant: selectedGrant,
      at: NOW,
      coreVersion: "0.2.0",
      workflowRefSha: SHA,
      workflowRepository: "venture-harness/venture-harness",
      fileSystem,
      providerEffectExecutor: providers.executor,
      store,
    });

    expect(result.command).toMatchObject({
      commandId: "launch.execute",
      ventureId: "payout-rank",
      status: "accepted",
    });
    expect(result.advertisingSpendAuthorized).toBe(false);
    expect(written.has("harness.lock")).toBe(true);
    expect(result.evidence).toHaveLength(effects.length);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schemaVersion: 2,
          verificationSource: "provider_adapter_read_back",
          verificationState: "verified",
          grantId: selectedGrant.grantId,
          requestAccepted: true,
          readBackVerified: true,
          fixture: true,
          proof: expect.objectContaining({ algorithm: "hmac-sha256" }),
        }),
      ]),
    );
    expect(
      (result.evidence as readonly ProviderLaunchEffectEvidence[]).every(
        (item) =>
          item.launchBudget.external.resourceCount === 6 &&
          item.launchBudget.external.costMinorUnits === 0 &&
          item.launchBudget.model.source === "deterministic_no_model_execution",
      ),
    ).toBe(true);
    expect(providers.externalWrites).toHaveLength(6);

    const replay = await executeOnePromptVentureLaunch({
      runtime,
      commandContext: context,
      commandIdempotencyKey: "one-prompt",
      grant: selectedGrant,
      at: NOW,
      coreVersion: "0.2.0",
      workflowRefSha: SHA,
      workflowRepository: "venture-harness/venture-harness",
      fileSystem: {
        prepareEmpty: () => Promise.reject(new Error("replay must not rematerialize")),
        writeExclusive: () => Promise.reject(new Error("replay must not write")),
        removeCreated: () => Promise.resolve(),
      },
      providerEffectExecutor: providers.newExecutor(),
      store,
    });
    expect(replay).toEqual(result);
    expect(prepared).toBe(1);
    expect(providers.externalWrites).toHaveLength(6);
  });

  it("resumes the canonical launch after a crash without rematerializing or duplicating the write", async () => {
    const selectedGrant = createLaunchGrant(grantInput());
    const providers = await createFixtureProviderExecutor({
      grant: selectedGrant,
      crashAfterWriteOnce: true,
    });
    const runtime = createVentureRuntime({
      commandExecutionMode: "fixture",
      memberships: [
        {
          organizationId: "founder-company",
          actorId: "founder-user",
          role: "owner",
          active: true,
        },
      ],
      now: () => NOW,
    });
    const commandContext: CommandExecutionContext = {
      identity: { actorId: "founder-user", kind: "user" },
      tenant: { organizationId: "founder-company", ventureId: "payout-rank" },
      subscription: { subscriptionId: "subscription-owner", status: "active", plan: "owner" },
      entitlements: ["launch.execute"],
      grants: [
        {
          grantId: selectedGrant.grantId,
          commandIds: ["launch.execute"],
          scopes: ["launch:execute"],
          expiresAt: selectedGrant.expiresAt,
        },
      ],
      scopes: ["launch:execute"],
    };
    const written = new Set<string>();
    let preparations = 0;
    const store = createMemoryOnePromptLaunchStore();
    const input = {
      runtime,
      commandContext,
      commandIdempotencyKey: "crash-resume",
      grant: selectedGrant,
      at: NOW,
      coreVersion: "0.2.0",
      workflowRefSha: SHA,
      workflowRepository: "venture-harness/venture-harness",
      store,
    } as const;

    await expect(
      executeOnePromptVentureLaunch({
        ...input,
        fileSystem: {
          prepareEmpty: () => {
            preparations += 1;
            return Promise.resolve();
          },
          writeExclusive: (path) => {
            written.add(path);
            return Promise.resolve();
          },
          removeCreated: (path) => {
            written.delete(path);
            return Promise.resolve();
          },
        },
        providerEffectExecutor: providers.executor,
      }),
    ).rejects.toMatchObject({ code: "provider_apply_unverified" });
    expect(written.has("harness.lock")).toBe(true);
    expect(preparations).toBe(1);
    expect(providers.externalWrites).toHaveLength(1);

    const resumed = await executeOnePromptVentureLaunch({
      ...input,
      fileSystem: {
        prepareEmpty: () => Promise.reject(new Error("resume must not rematerialize")),
        writeExclusive: () => Promise.reject(new Error("resume must not write files")),
        removeCreated: () => Promise.resolve(),
      },
      providerEffectExecutor: providers.newExecutor(),
    });
    expect(resumed.evidence).toHaveLength(effects.length);
    expect(resumed.evidence.every((item) => item.readBackVerified)).toBe(true);
    expect(preparations).toBe(1);
    expect(providers.externalWrites).toHaveLength(6);
  });

  it("does not prepare a workspace or call a provider when command authorization fails", async () => {
    const selectedGrant = createLaunchGrant(grantInput());
    const providers = await createFixtureProviderExecutor({ grant: selectedGrant });
    const runtime = createVentureRuntime({
      commandExecutionMode: "fixture",
      memberships: [
        {
          organizationId: "founder-company",
          actorId: "founder-user",
          role: "owner",
          active: true,
        },
      ],
      now: () => NOW,
    });
    let prepared = false;
    await expect(
      executeOnePromptVentureLaunch({
        runtime,
        commandContext: {
          identity: { actorId: "founder-user", kind: "user" },
          tenant: { organizationId: "founder-company", ventureId: "payout-rank" },
          subscription: {
            subscriptionId: "subscription-owner",
            status: "active",
            plan: "owner",
          },
          entitlements: [],
          grants: [],
          scopes: [],
        },
        commandIdempotencyKey: "denied",
        grant: selectedGrant,
        at: NOW,
        coreVersion: "0.2.0",
        workflowRefSha: SHA,
        workflowRepository: "venture-harness/venture-harness",
        fileSystem: {
          prepareEmpty: () => {
            prepared = true;
            return Promise.resolve();
          },
          writeExclusive: () => Promise.resolve(),
          removeCreated: () => Promise.resolve(),
        },
        providerEffectExecutor: providers.executor,
        store: createMemoryOnePromptLaunchStore(),
      }),
    ).rejects.toThrow(/missing entitlements/);
    expect(prepared).toBe(false);
    expect(providers.externalWrites).toHaveLength(0);
  });

  it("resumes only cryptographically verified evidence bound to the same grant and profile", async () => {
    const compiled = plan();
    const providers = await createFixtureProviderExecutor({ grant: compiled.grant });
    const evidence = await executeLaunchEffects({
      plan: compiled,
      executor: providers.executor,
      at: NOW,
    });
    expect(evidence).toHaveLength(effects.length);
    expect(evidence.every((item) => item.fixture && item.readBackVerified)).toBe(true);
    expect(providers.externalWrites).toHaveLength(6);

    const resumed = await executeLaunchEffects({
      plan: compiled,
      executor: providers.newExecutor(),
      at: NOW,
      priorEvidence: evidence,
    });
    expect(resumed).toEqual(evidence);
    expect(providers.externalWrites).toHaveLength(6);

    const changedModelBudget = await createFixtureProviderExecutor({
      grant: compiled.grant,
      directory: providers.directory,
      ledgerPath: providers.ledgerPath,
      modelUsage: {
        known: true,
        tokens: 1,
        costMinorUnits: 0,
        currency: "EUR",
        source: "metered",
      },
    });
    await expect(
      executeLaunchEffects({
        plan: compiled,
        executor: changedModelBudget.executor,
        at: NOW,
        priorEvidence: evidence,
      }),
    ).rejects.toMatchObject({ code: "evidence_invalid" });
    expect(changedModelBudget.externalWrites).toHaveLength(0);
  });

  it("rejects self-authored boolean evidence before any provider invocation", async () => {
    const compiled = plan({}, ["repository.create"]);
    const providers = await createFixtureProviderExecutor({ grant: compiled.grant });
    const forged: LaunchEffectEvidence = {
      effect: "repository.create",
      provider: "github",
      externalAccountId: "github-founder-company",
      externalResourceId: "self-authored",
      ownership: "company_owned",
      requestAccepted: true,
      readBackVerified: true,
      fixture: true,
      observedAt: NOW.toISOString(),
    };

    await expect(
      executeLaunchEffects({
        plan: compiled,
        executor: providers.executor,
        at: NOW,
        priorEvidence: [forged],
      }),
    ).rejects.toMatchObject({ code: "evidence_invalid" });
    expect(providers.externalWrites).toHaveLength(0);
  });

  it("rejects legitimate evidence from another Launch Grant and Stack Profile", async () => {
    const founder = plan({}, ["domain.configure"]);
    const founderProviders = await createFixtureProviderExecutor({ grant: founder.grant });
    const founderEvidence = await executeLaunchEffects({
      plan: founder,
      executor: founderProviders.executor,
      at: NOW,
    });
    const alternativeAccounts = grantInput().providerAccounts.map((account) =>
      account.capability === "domain.configure"
        ? {
            ...account,
            capability: "dns.record",
            provider: "dns",
            externalAccountId: "generic-dns-founder-account",
          }
        : account,
    );
    const alternative = plan(
      {
        ideaDigest: "d".repeat(64),
        stackProfile: { id: genericDnsStackProfile.profileId, version: "0.2.0" },
        providerAccounts: alternativeAccounts,
      },
      ["domain.configure"],
    );
    const alternativeProviders = await createFixtureProviderExecutor({
      grant: alternative.grant,
      stackProfile: genericDnsStackProfile,
    });

    await expect(
      executeLaunchEffects({
        plan: alternative,
        executor: alternativeProviders.executor,
        at: NOW,
        priorEvidence: founderEvidence,
      }),
    ).rejects.toMatchObject({ code: "evidence_invalid" });
    expect(alternativeProviders.externalWrites).toHaveLength(0);
  });

  it("fails the whole preflight for an unsupported profile capability before invocation", async () => {
    const compiled = plan({}, ["domain.configure"]);
    const unsupportedProfile = {
      ...founderDefaultStackProfile,
      bindings: {
        ...founderDefaultStackProfile.bindings,
        "dns.record": {
          providerId: "github",
          capability: "record",
          rationale: "Invalid test binding",
        },
      },
    } as unknown as ProviderStackProfile;
    const providers = await createFixtureProviderExecutor({
      grant: compiled.grant,
      stackProfile: unsupportedProfile,
    });

    await expect(
      executeLaunchEffects({ plan: compiled, executor: providers.executor, at: NOW }),
    ).rejects.toThrow(/does not implement record/);
    expect(providers.externalWrites).toHaveLength(0);
  });

  it("stops when provider acceptance lacks matched adapter read-back", async () => {
    const compiled = plan({}, ["commerce.configure"]);
    const providers = await createFixtureProviderExecutor({
      grant: compiled.grant,
      readBackMatches: false,
    });

    await expect(
      executeLaunchEffects({ plan: compiled, executor: providers.executor, at: NOW }),
    ).rejects.toMatchObject({ code: "provider_apply_unverified" });
    expect(providers.externalWrites).toHaveLength(1);
  });

  it("reconciles a crash after a fixture write without issuing a duplicate write", async () => {
    const compiled = plan({}, ["commerce.configure"]);
    const providers = await createFixtureProviderExecutor({
      grant: compiled.grant,
      crashAfterWriteOnce: true,
    });

    await expect(
      executeLaunchEffects({ plan: compiled, executor: providers.executor, at: NOW }),
    ).rejects.toMatchObject({ code: "provider_apply_unverified" });
    expect(providers.externalWrites).toHaveLength(1);

    const reconciled = await executeLaunchEffects({
      plan: compiled,
      executor: providers.newExecutor(),
      at: NOW,
    });
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({
      effect: "commerce.configure",
      verificationState: "verified",
      readBackVerified: true,
    });
    expect(providers.externalWrites).toHaveLength(1);
  });

  it("returns exact signed evidence on durable replay without another fixture write", async () => {
    const compiled = plan({}, ["commerce.configure"]);
    const providers = await createFixtureProviderExecutor({ grant: compiled.grant });
    const first = await executeLaunchEffects({
      plan: compiled,
      executor: providers.executor,
      at: NOW,
    });
    const replay = await executeLaunchEffects({
      plan: compiled,
      executor: providers.newExecutor(),
      at: NOW,
    });

    expect(replay).toEqual(first);
    expect(providers.externalWrites).toHaveLength(1);
  });

  it("installs Winner Loop twice without duplicating commands, events, migrations or loops", () => {
    const first = installPack(emptyPackInstallationState(), PACKS["winner-loop"], "0.2.0");
    const second = installPack(first.state, PACKS["winner-loop"], "0.2.0");
    expect(first.status).toBe("installed");
    expect(second.status).toBe("already_installed");
    expect(second.state).toBe(first.state);
    for (const values of [
      second.state.commands,
      second.state.events,
      second.state.migrations,
      second.state.loops,
    ]) {
      expect(new Set(values).size).toBe(values.length);
    }
  });
});
