import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileFounderLaunchPreparation,
  founderStackRoleDefinitions,
  materializeFounderVenture,
  parseFounderStackConnection,
  type FounderStackConnection,
  type FounderStackDoctorResult,
  type FounderStackRole,
} from "@/lib/founder-launch";

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
      "BREVO_API_KEY",
      "NEXT_PUBLIC_GA_MEASUREMENT_ID",
    ]);
    expect(result.migrations).toEqual(["migrations/sql/001_core_evidence.up.sql"]);
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
        maxBuildAgentTasks: 4,
        usageAccounting: "none",
      },
      providerOperationBudget: {
        maxDirectChargeMinorUnits: 0,
        currency: "EUR",
        estimateBasis: "reviewed_known_zero_direct_charge",
        ongoingAccountPlanUsageCovered: false,
      },
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
        expect.objectContaining({
          provider: "dns",
          externalAccountId: "fixture-dns-zone-owner",
          ownership: "company_owned",
        }),
      ]),
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
      /^Synthetic: yes\n/mu,
      "",
    );
    const result = prepare({ ideaSource });

    expect(result.launchGrant.modelExecutionPolicy).toMatchObject({
      mode: "chatgpt_subscription_non_metered",
      maxBuildAgentTasks: 4,
      attestation: "codex_login_status_chatgpt_subscription",
      usageAccounting: "observational",
    });
    expect(result.launchGrant).not.toHaveProperty("modelBudget");
    expect(result.launchGrant).not.toHaveProperty("externalResourceBudget");
  });

  it("withholds the Launch Grant when selected provider capabilities have no public domain", () => {
    const blocked = prepare({
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

    expect(blocked.status).toBe("blocked");
    expect(blocked.grantDisposition).toBe("withheld_blocked");
    expect(blocked.blockers).toContainEqual(
      expect.objectContaining({
        code: "domain_missing",
        nextAction: expect.stringContaining("Domain:"),
      }),
    );
  });

  it("withholds the Launch Grant until a domain has one exact manual DNS binding", async () => {
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

    expect(adapterBlocked.blockers).toContainEqual(
      expect.objectContaining({
        code: "stack_role_not_ready",
        role: "dns.records",
        message: expect.stringContaining("manual DNS adapter"),
      }),
    );
    expect(destinationBlocked.blockers).toContainEqual(
      expect.objectContaining({
        code: "provider_account_missing",
        role: "dns.records",
        provider: "dns",
      }),
    );
    await expect(materializeFounderVenture(adapterBlocked)).rejects.toThrow(
      /blocked founder launch/,
    );
    await expect(materializeFounderVenture(destinationBlocked)).rejects.toThrow(
      /blocked founder launch/,
    );
    expect(existsSync(adapterBlocked.repository.localDirectory)).toBe(false);
    expect(existsSync(destinationBlocked.repository.localDirectory)).toBe(false);
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
    expect(result.domain).toEqual({ requested: null, mode: "none", expectedRecords: [] });
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
