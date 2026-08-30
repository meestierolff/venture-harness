import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileFounderLaunchPreparation,
  founderStackRoleDefinitions,
  loadFounderIdeaFile,
  materializeFounderVenture,
  parseFounderStackConnection,
  renderFounderIdea,
  launchContractDigest,
  type FounderStackConnection,
  type FounderStackDoctorResult,
  type FounderStackRole,
} from "@/lib/founder-launch";
import { launchReceiptContract } from "./fixtures/launch-receipt-contract";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const WORKFLOW_SHA = "a".repeat(40);
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "vh-founder-launch-"));
  temporaryDirectories.push(path);
  return path;
}

function stack(): FounderStackConnection {
  return parseFounderStackConnection(
    JSON.parse(readFileSync("fixtures/founder-stack/founder-default.json", "utf8")),
  );
}

function readyDoctor(connection: FounderStackConnection): FounderStackDoctorResult {
  const roles = (Object.keys(founderStackRoleDefinitions) as FounderStackRole[]).map((role) => {
    const selected = connection.roles[role];
    const manual = role === "dns.records";
    return {
      role,
      providerId: founderStackRoleDefinitions[role].providerId,
      status: manual ? ("manual_only" as const) : ("ready" as const),
      credentialRef: selected.credentialRef ?? null,
      accountId: selected.accountId ?? null,
      teamId: selected.teamId ?? null,
      organizationId: selected.organizationId ?? null,
      scopes: [...selected.scopes],
      expiresAt: selected.expiresAt ?? null,
      declaredVerification: selected.verification,
      providerDoctorStatus: manual ? "manual_required" : "ready",
      issueCodes: [],
      missingLaunchDefaults: [],
      nextCommand: "vh launch --dry-run",
      liveProviderState: "not_checked" as const,
      blocksLaunch: false,
    };
  });
  return {
    schemaVersion: 1,
    profileId: "founder-default",
    ownerOrganizationId: connection.ownerOrganizationId,
    status: "ready",
    roles,
    writableCredentialTargets: {
      status: "ready",
      fixtureOnly: true,
      targets: [],
      nextCommand: "vh launch --dry-run",
    },
    externalEffects: false,
    launchGrantRequired: false,
    verificationScope: "credential_and_transport_readiness_only",
    liveProviderState: "not_checked",
    launchReady: true,
    unresolvedActions: [],
  };
}

function prepare(overrides: Partial<Parameters<typeof compileFounderLaunchPreparation>[0]> = {}) {
  const baseDir = overrides.baseDir ?? temporaryDirectory();
  const connection = overrides.stack ?? stack();
  return compileFounderLaunchPreparation({
    ideaSource: readFileSync("fixtures/ideas/synthetic-founder-web.md", "utf8"),
    ideaPath: "fixtures/ideas/synthetic-founder-web.md",
    stack: connection,
    stackDoctor: readyDoctor(connection),
    baseDir,
    workflowRefSha: WORKFLOW_SHA,
    workflowRepository: "venture-harness/venture-harness",
    executionMode: "dry-run",
    production: true,
    nonInteractive: true,
    at: NOW,
    allowFixtureStack: true,
    ...overrides,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("one-prompt founder launch preparation", () => {
  it("reads the idea through a descriptor-bound workspace boundary", () => {
    const baseDir = temporaryDirectory();
    const ideaPath = join(baseDir, "idea.md");
    const aliasPath = join(baseDir, "idea-alias.md");
    writeFileSync(ideaPath, "# Descriptor-bound idea\n", { mode: 0o600 });
    symlinkSync("idea.md", aliasPath);

    expect(loadFounderIdeaFile("idea.md", baseDir)).toBe("# Descriptor-bound idea\n");
    expect(() => loadFounderIdeaFile("idea-alias.md", baseDir)).toThrow(
      "Founder launch --idea must be a regular non-symlink file",
    );
    expect(existsSync(join(baseDir, ".founder-launch-idea.lock"))).toBe(false);
  });

  it("places the default child directly under the configured ventures root", () => {
    const baseDir = temporaryDirectory();
    const result = prepare({ baseDir });

    expect(result.repository.localDirectory).toBe(join(realpathSync(baseDir), "exception-desk"));
  });

  it("rejects a new output whose existing parent is a symlink outside the ventures root", () => {
    const baseDir = temporaryDirectory();
    const outside = temporaryDirectory();
    symlinkSync(outside, join(baseDir, "linked"));

    expect(() => prepare({ baseDir, output: "linked/exception-desk" })).toThrow(
      /must not traverse a symbolic link/,
    );
    expect(existsSync(join(outside, "exception-desk"))).toBe(false);
  });

  it("rejects an existing child that is a symlink outside the ventures root", () => {
    const baseDir = temporaryDirectory();
    const outside = temporaryDirectory();
    mkdirSync(join(outside, "existing"));
    symlinkSync(join(outside, "existing"), join(baseDir, "exception-desk"));

    expect(() => prepare({ baseDir })).toThrow(/must not traverse a symbolic link/);
  });

  it("rejects a dangling child symlink without creating its outside target", () => {
    const baseDir = temporaryDirectory();
    const outside = temporaryDirectory();
    const outsideTarget = join(outside, "not-created");
    symlinkSync(outsideTarget, join(baseDir, "exception-desk"));

    expect(() => prepare({ baseDir })).toThrow(/must not traverse a symbolic link/);
    expect(existsSync(outsideTarget)).toBe(false);
  });

  it("renders a complete effect-free production dry-run with exact targets and command", () => {
    const result = prepare();

    expect(result).toMatchObject({
      status: "ready",
      executionMode: "dry-run",
      grantDisposition: "proposed_not_issued",
      selectedVentureType: {
        rail: "web",
        seed: { id: "agentic-web-saas", version: "0.2.0" },
        commerce: "stripe",
      },
      repository: {
        owner: "fixture-github-account",
        name: "exception-desk",
        visibility: "private",
      },
      domain: {
        requested: "exception-desk.example.test",
        mode: "manual_consolidated_action",
        canonicalOrigin: "provider_production_url",
      },
      setup: {
        analytics: "google_analytics",
        search: "google_search_console_and_bing",
        email: "brevo_transactional",
        commerce: "stripe_test_mode",
      },
      blockers: [],
      exactFinalCommand:
        "vh launch --idea fixtures/ideas/synthetic-founder-web.md --stack founder-default --production --apply --non-interactive",
    });
    expect(result.environmentVariables.map(({ name }) => name)).toEqual([
      "DATABASE_URL",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ]);
    // The ordinary web seed has no universal evidence database. A migration is
    // selected only when the reviewed journey needs persistence.
    expect(result.migrations).toEqual([]);
    expect(result.materialization.effects).toEqual([]);
    expect(result.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "vercel",
          estimatedCost: 0,
          directChargeBasis: "reviewed_known_zero_direct_charge",
          ongoingAccountPlanUsageCovered: false,
        }),
      ]),
    );
    expect(result.launchGrant).toMatchObject({
      modelExecutionPolicy: {
        mode: "fixture_no_model_execution",
        maxBuildAgentTasks: 2,
        usageAccounting: "none",
      },
      providerOperationBudget: {
        maxDirectChargeMinorUnits: 0,
        currency: "EUR",
        estimateBasis: "reviewed_known_zero_direct_charge",
        ongoingAccountPlanUsageCovered: false,
      },
      permissions: { domainConfiguration: false },
    });
    expect(result.launchGrant).not.toHaveProperty("modelBudget");
    expect(result.launchGrant).not.toHaveProperty("externalResourceBudget");
    const receipt = JSON.parse(
      result.materialization.files.find(
        ({ path }) => path === ".venture/launch-grant.receipt.json",
      )!.content,
    ) as Record<string, unknown>;
    expect(receipt).not.toHaveProperty("modelBudget");
    expect(receipt).not.toHaveProperty("externalResourceBudget");
    expect(receipt).not.toHaveProperty("spendCeiling");
    expect(JSON.stringify(receipt)).not.toMatch(/maxTokens|total(?:Provider)?Spend/iu);
    expect(receipt).toMatchObject({
      modelExecutionPolicy: result.launchGrant.modelExecutionPolicy,
      providerOperationBudget: result.launchGrant.providerOperationBudget,
    });
    expect(result.launchGrant.providerAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "github",
          externalAccountId: "fixture-github-account",
        }),
        expect.objectContaining({
          provider: "vercel",
          externalAccountId: "fixture-vercel-team",
        }),
        expect.objectContaining({ provider: "neon", externalAccountId: "fixture-neon-org" }),
        expect.objectContaining({
          provider: "stripe",
          externalAccountId: "fixture-stripe-account",
        }),
      ]),
    );
    expect(result.launchGrant.providerAccounts.map(({ provider }) => provider)).not.toContain(
      "dns",
    );
    expect(result.launchGaps).toContainEqual(
      expect.objectContaining({
        code: "custom_domain_deferred",
        role: "dns.records",
        state: "waiting_for_external_action",
        blocksLaunch: false,
      }),
    );
    expect(result.graphDryRun.graph.nodes.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining(["dns-records", "verify-custom-domain", "stripe-domain-callbacks"]),
    );
  });

  it("withholds the Launch Grant when price or doctor evidence is missing", async () => {
    const ideaSource = [
      "# Unpriced SaaS",
      "Audience: small teams",
      "Problem: reviews scatter",
      "Outcome: one decision record",
      "Commerce: subscription",
    ].join("\n");
    const blocked = prepare({ ideaSource, stackDoctor: undefined, executionMode: "apply" });

    expect(blocked.status).toBe("blocked");
    expect(blocked.grantDisposition).toBe("withheld_blocked");
    expect(blocked.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "exact_price_missing", provider: "stripe" }),
        expect.objectContaining({ code: "stack_role_not_ready", provider: "github" }),
      ]),
    );
    await expect(materializeFounderVenture(blocked)).rejects.toThrow(/blocked founder launch/);
    expect(existsSync(blocked.repository.localDirectory)).toBe(false);
  });

  it("uses a bounded non-metered ChatGPT policy for a non-synthetic founder launch", () => {
    const ideaSource = readFileSync("fixtures/ideas/synthetic-founder-web.md", "utf8").replace(
      /^synthetic: true\n/mu,
      "",
    );
    const result = prepare({ ideaSource });

    expect(result.launchGrant.modelExecutionPolicy).toMatchObject({
      mode: "chatgpt_subscription_non_metered",
      maxBuildAgentTasks: 2,
      attestation: "codex_login_status_chatgpt_subscription",
      usageAccounting: "observational",
    });
    expect(result.launchGrant).not.toHaveProperty("modelBudget");
    expect(result.launchGrant).not.toHaveProperty("externalResourceBudget");
  });

  it("selects the optional service seed without activating a mobile rail", () => {
    const contract = launchReceiptContract();
    const result = prepare({
      ideaSource: renderFounderIdea({
        ...contract,
        agentNative: {
          customerAgentSurfaceRequired: true,
          serviceBlueprintRequired: true,
          outcomeCommands: ["publish_verified_receipt"],
        },
        capabilities: {
          ...contract.capabilities,
          agentSurface: "REQUIRED",
        },
      }),
    });

    expect(result.selectedVentureType).toMatchObject({
      rail: "web",
      seed: { id: "hybrid-agentic-service" },
    });
    expect(result.launchGrant.ideaDigest).toBe(
      launchContractDigest({
        ...contract,
        agentNative: {
          customerAgentSurfaceRequired: true,
          serviceBlueprintRequired: true,
          outcomeCommands: ["publish_verified_receipt"],
        },
        capabilities: {
          ...contract.capabilities,
          agentSurface: "REQUIRED",
        },
      }),
    );
    expect(result.graphDryRun.decision.capabilities).not.toContain("app_store_connect");
  });

  it("ships a domainless venture on the provider production URL instead of blocking it", () => {
    const domainless = prepare({
      ideaSource: [
        "# Domainless SaaS",
        "Audience: small teams",
        "Problem: reviews scatter",
        "Outcome: one decision record",
        "Commerce: subscription",
        "Monthly price: 24.50",
        "Currency: EUR",
        "Transactional email: yes",
        "Analytics: yes",
        "Search: yes",
      ].join("\n"),
      executionMode: "apply",
    });

    // Commerce can bind to the stable provider production URL. Optional email,
    // analytics and discovery remain explicit deferred actions rather than
    // stopping the first app from going live.
    expect(domainless.status).toBe("ready");
    expect(domainless.grantDisposition).not.toBe("withheld_blocked");
    expect(domainless.blockers.map((blocker) => blocker.code)).not.toContain("domain_missing");
    expect(domainless.domain).toMatchObject({
      requested: null,
      mode: "none",
      canonicalOrigin: "provider_production_url",
      pendingAction: null,
    });
  });

  it("keeps deferred custom DNS independent of optional Stack setup", async () => {
    const base = JSON.parse(readFileSync("fixtures/founder-stack/founder-default.json", "utf8"));
    const missingAdapter = parseFounderStackConnection({
      ...base,
      launchDefaults: {
        ...base.launchDefaults,
        dns: { ...base.launchDefaults.dns, adapter: null },
      },
    });
    const missingDestinationInput = structuredClone(base);
    delete missingDestinationInput.roles["dns.records"].organizationId;
    const missingDestination = parseFounderStackConnection(missingDestinationInput);
    const adapterBlocked = prepare({ stack: missingAdapter, executionMode: "apply" });
    const destinationBlocked = prepare({ stack: missingDestination, executionMode: "apply" });

    for (const result of [adapterBlocked, destinationBlocked]) {
      expect(result.launchGaps).toContainEqual(
        expect.objectContaining({
          code: "custom_domain_deferred",
          role: "dns.records",
          provider: "dns",
          state: "waiting_for_external_action",
          blocksLaunch: false,
        }),
      );
      expect(result.selectedProviders.map(({ role }) => role)).not.toContain("dns.records");
      expect(result.launchGrant.providerAccounts.map(({ provider }) => provider)).not.toContain(
        "dns",
      );
    }
    expect(adapterBlocked).toMatchObject({ status: "ready", grantDisposition: "issued_for_apply" });
    expect(destinationBlocked).toMatchObject({
      status: "ready",
      grantDisposition: "issued_for_apply",
    });
    await expect(materializeFounderVenture(adapterBlocked)).resolves.toMatchObject({
      status: "materialized",
    });
    await expect(materializeFounderVenture(destinationBlocked)).resolves.toMatchObject({
      status: "materialized",
    });
  });

  it("grants a domainless core launch when Brevo, Google, and Bing auth are absent", () => {
    const base = JSON.parse(readFileSync("fixtures/founder-stack/founder-default.json", "utf8"));
    for (const role of ["email.transactional", "growth.google", "search.bing"] as const) {
      delete base.roles[role].credentialRef;
      delete base.roles[role].accountId;
      delete base.roles[role].organizationId;
      delete base.roles[role].teamId;
    }
    const connection = parseFounderStackConnection(base);
    const result = prepare({
      stack: connection,
      executionMode: "apply",
      ideaSource: [
        "# Domainless optional integrations",
        "Audience: small teams",
        "Problem: reviews scatter",
        "Outcome: one decision record",
        "Commerce: subscription",
        "Monthly price: 24.50",
        "Currency: EUR",
        "Transactional email: yes",
        "Analytics: yes",
        "Search: yes",
      ].join("\n"),
    });

    expect(result).toMatchObject({ status: "ready", grantDisposition: "issued_for_apply" });
    expect(result.blockers).toEqual([]);
    expect(result.launchGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "optional_integration_deferred",
          role: "email.transactional",
          state: "waiting_for_external_action",
        }),
        expect.objectContaining({
          code: "optional_integration_deferred",
          role: "growth.google",
          state: "waiting_for_external_action",
        }),
        expect.objectContaining({
          code: "optional_integration_deferred",
          role: "search.bing",
          state: "waiting_for_external_action",
        }),
      ]),
    );
    expect(result.launchGrant.providerAccounts.map(({ provider }) => provider)).toEqual(
      expect.arrayContaining(["github", "vercel", "stripe"]),
    );
    expect(result.launchGrant.providerAccounts.map(({ provider }) => provider)).not.toContain(
      "brevo",
    );
    expect(result.launchGrant.providerAccounts.map(({ provider }) => provider)).not.toContain(
      "bing",
    );
    expect(result.launchGrant.providerAccounts.map(({ provider }) => provider)).not.toContain(
      "google",
    );
    const graph = result.graphDryRun.graph;
    const ancestors = (nodeId: string, seen = new Set<string>()): Set<string> => {
      const node = graph.nodes.find(({ id }) => id === nodeId);
      for (const dependency of node?.dependencies ?? []) {
        if (!seen.has(dependency)) {
          seen.add(dependency);
          ancestors(dependency, seen);
        }
      }
      return seen;
    };
    expect([...ancestors("production-deploy")]).not.toEqual(
      expect.arrayContaining([
        "brevo-email",
        "google-analytics-property",
        "google-analytics-stream",
        "google-search-console",
        "bing-discovery",
      ]),
    );
    expect(graph.nodes.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining([
        "brevo-email",
        "google-analytics-property",
        "google-analytics-stream",
        "google-search-console",
        "bing-discovery",
      ]),
    );
    expect(graph.nodes.find(({ id }) => id === "verify-production")?.dependencies).toEqual([
      "production-deploy",
    ]);
  });

  it("still withholds the Grant when required Neon and Stripe destinations are absent", () => {
    const base = JSON.parse(readFileSync("fixtures/founder-stack/founder-default.json", "utf8"));
    for (const role of ["database.postgres", "commerce.web"] as const) {
      delete base.roles[role].accountId;
      delete base.roles[role].organizationId;
      delete base.roles[role].teamId;
    }
    const connection = parseFounderStackConnection(base);
    const result = prepare({ stack: connection, executionMode: "apply" });

    expect(result).toMatchObject({ status: "blocked", grantDisposition: "withheld_blocked" });
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "database.postgres", provider: "neon" }),
        expect.objectContaining({ role: "commerce.web", provider: "stripe" }),
      ]),
    );
  });

  it("keeps a valid no-domain launch independent of DNS Stack configuration", () => {
    const base = JSON.parse(readFileSync("fixtures/founder-stack/founder-default.json", "utf8"));
    const domainlessStackInput = structuredClone(base);
    delete domainlessStackInput.roles["dns.records"].organizationId;
    domainlessStackInput.launchDefaults.dns.adapter = null;
    const connection = parseFounderStackConnection(domainlessStackInput);
    const result = prepare({
      stack: connection,
      ideaSource: [
        "# Domainless utility",
        "Audience: small teams",
        "Problem: decisions scatter",
        "Outcome: one review record",
        "Commerce: none",
        "Transactional email: no",
        "Analytics: no",
        "Search: no",
      ].join("\n"),
    });

    expect(result.status).toBe("ready");
    expect(result.domain).toEqual({
      requested: null,
      mode: "none",
      expectedRecords: [],
      canonicalOrigin: "provider_production_url",
      pendingAction: null,
    });
    expect(result.selectedProviders.map(({ role }) => role)).not.toContain("dns.records");
    expect(result.launchGrant.providerAccounts.map(({ provider }) => provider)).not.toContain(
      "dns",
    );
    expect(result.graphDryRun.graph.nodes.map(({ id }) => id)).not.toContain("dns-records");
  });

  it("materializes the isolated child only for an explicit ready apply", async () => {
    const result = prepare({ executionMode: "apply" });
    const materialized = await materializeFounderVenture(result);

    expect(result.grantDisposition).toBe("issued_for_apply");
    expect(materialized.status).toBe("materialized");
    expect(materialized.files).toEqual(
      expect.arrayContaining([
        "app/page.tsx",
        "harness.lock",
        "venture.manifest.json",
        "config/providers.yaml",
      ]),
    );
    expect(existsSync(join(result.repository.localDirectory, ".git"))).toBe(false);
  });

  it("rejects output traversal and incomplete apply flags before any write", () => {
    expect(() => prepare({ output: "../escape" })).toThrow(/output escapes/);
    expect(() => prepare({ executionMode: "apply", nonInteractive: false })).toThrow(
      /--production and --non-interactive/,
    );
  });
});
