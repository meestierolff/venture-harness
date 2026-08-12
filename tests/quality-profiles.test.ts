import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import {
  evaluateProviderReadbackEvidence,
  mergeVerifiedProviderLifecycleStates,
  qualityProfileExitCode,
  redactQualityOutput,
  resolveProfileChecks,
  unresolvedProviderReadbackGap,
  validateDeterministicAnalyticsReadiness,
  type QualityReport,
  type QualityContract,
  type QualityProfileId,
} from "@/scripts/run-quality-profile";
import { hasServerRenderedCoreContent } from "@/scripts/verify-raw-html";
import { qualitySchema } from "@/lib/config/schemas";

const contract = parse(readFileSync("config/quality.yaml", "utf8")) as QualityContract & {
  required_commands: { always: string[] };
};

describe("capability-aware quality profiles", () => {
  it("gives MVP and release disjoint ownership of the expensive core and distribution tiers", () => {
    expect(Object.keys(contract.profiles)).toEqual(["fast", "mvp", "release", "live", "stable"]);
    expect(contract.required_commands.always).toContain("pnpm test");
    expect(contract.profiles.mvp.checks).toEqual(
      expect.arrayContaining([
        "compatibility_verify",
        "workspace_build",
        "workspace_contract",
        "typecheck",
        "unit_integration",
      ]),
    );
    expect(contract.profiles.release.checks).toEqual(
      expect.arrayContaining([
        "public_release_safety",
        "workspace_pack_consumer",
        "synthetic_launch_golden_path",
        "seed_dependency_closure",
        "analytics_readiness",
      ]),
    );
    expect(contract.profiles.mvp.checks).not.toContain("workspace_packages_build");
    for (const mvpOwnedCheck of [
      "workspace_packages_build",
      "workspace_build",
      "compatibility_verify",
      "typecheck",
      "unit_integration",
      "migration_tests",
      "provider_contract_tests",
      "synthetic_fixture_tests",
      "analytics_pack_tests",
      "provider_dry_run",
      "migration_rollback_tests",
      "graph_resume_idempotency",
    ]) {
      expect(contract.profiles.release.checks, mvpOwnedCheck).not.toContain(mvpOwnedCheck);
    }
    expect(contract.checks.workspace_build.command).toEqual(["pnpm", "workspace:build"]);
    expect(contract.checks.workspace_contract.command).toEqual(["pnpm", "workspace:check"]);
    expect(contract.checks.workspace_pack_consumer.command).toEqual(["pnpm", "test:workspace"]);
    expect(contract.checks.synthetic_launch_golden_path.command).toEqual([
      "pnpm",
      "fixture:venture-launch",
      "--",
      "--json",
    ]);
    expect(contract.checks.seed_dependency_closure.command).toEqual([
      "pnpm",
      "verify:seed-closure",
    ]);
    expect(contract.checks.seed_dependency_closure.phase).toBeGreaterThan(
      contract.checks.synthetic_launch_golden_path.phase,
    );
    expect(contract.checks.workspace_build.phase).toBeLessThan(
      contract.checks.unit_integration.phase,
    );
    expect(contract.checks.workspace_pack_consumer.phase).toBeLessThan(
      contract.checks.synthetic_launch_golden_path.phase,
    );
    expect(contract.checks.provider_contract_tests.command).toEqual(["pnpm", "test:providers"]);
  });

  it("proves seed-closure browser runs belong to the spawned child server", () => {
    const verifier = readFileSync("scripts/verify-seed-closure.ts", "utf8");
    expect(verifier).toContain('randomBytes(24).toString("hex")');
    expect(verifier).toContain("VH_LOCAL_SERVER_NONCE: serverNonce");
    expect(verifier).toContain("health?.localServerNonce === serverNonce");
    expect(verifier).toContain("still owns its port after teardown");
    expect(verifier).toMatch(/EADDRINUSE\|address already in use/u);
    expect(verifier).toContain("await stopServer(server)");
  });

  it("adds public-web checks but not unrelated mobile or payment checks", () => {
    const checks = resolveProfileChecks(contract, "mvp", ["public_website"]);
    expect(checks).toContain("raw_html");
    expect(checks).not.toContain("seo_static");
    expect(checks).not.toContain("analytics_readiness");
    expect(checks).not.toContain("mobile_build_readiness");
    expect(checks).not.toContain("live_stripe_readback");
  });

  const webCommerceCapabilities = ["public_website", "stripe", "ga4", "gsc", "web_seo_aeo_geo"];

  it("keeps the release gate free of live provider read-backs and deduplicates shared checks", () => {
    const checks = resolveProfileChecks(contract, "release", webCommerceCapabilities);
    const readbacks = Object.entries(contract.checks)
      .filter(([, check]) => check.kind === "provider_readback")
      .map(([id]) => id);
    // A founder-alpha release gate must stay reachable with nothing connected.
    expect(checks.filter((check) => readbacks.includes(check))).toEqual([]);
    expect(checks).toContain("analytics_readiness");
    expect(checks).not.toContain("pricing_integrity");
    expect(checks).not.toContain("provider_contract_tests");
    expect(checks).not.toContain("raw_html");
    expect(checks).not.toContain("unit_integration");
    expect(checks).not.toContain("migration_rollback_tests");
    expect(checks).not.toContain("graph_resume_idempotency");
  });

  it("keeps deterministic analytics readiness independent of destinations and fresh data", () => {
    const analytics = parse(readFileSync("config/analytics.yaml", "utf8")) as unknown;
    expect(validateDeterministicAnalyticsReadiness(analytics)).toEqual([]);
    expect(contract.checks.analytics_readiness.kind).toBe("analytics_readiness");

    const liveChecks = resolveProfileChecks(contract, "live", ["ga4"]);
    const stableChecks = resolveProfileChecks(contract, "stable", ["ga4"]);
    expect(liveChecks).toContain("live_analytics_readback");
    expect(stableChecks).toContain("live_analytics_readback");
  });

  it("selects only relevant live read-backs and never a deterministic build check", () => {
    const checks = resolveProfileChecks(contract, "live", webCommerceCapabilities);
    expect(checks).toContain("live_stack_readback");
    expect(checks).toContain("live_stripe_readback");
    expect(checks).toContain("live_analytics_readback");
    expect(checks).not.toContain("live_revenuecat_readback");
    expect(checks).not.toContain("production_build");
    expect(checks.filter((check) => check === "live_analytics_readback")).toHaveLength(1);
  });

  it("requires both release evidence and live read-back in the stable profile", () => {
    const checks = resolveProfileChecks(contract, "stable", webCommerceCapabilities);
    const release = resolveProfileChecks(contract, "release", webCommerceCapabilities);
    const live = resolveProfileChecks(contract, "live", webCommerceCapabilities);
    for (const check of [...release, ...live]) expect(checks).toContain(check);
  });

  it("rejects a contract that puts a live provider read-back back into the release gate", () => {
    const base = parse(readFileSync("config/quality.yaml", "utf8")) as Record<string, unknown>;
    expect(qualitySchema.safeParse(base).success).toBe(true);

    const viaProfile = structuredClone(base) as typeof base & {
      profiles: { release: { checks: string[] } };
    };
    viaProfile.profiles.release.checks.push("live_stripe_readback");
    const profileResult = qualitySchema.safeParse(viaProfile);
    expect(profileResult.success).toBe(false);
    expect(JSON.stringify(profileResult.error?.issues)).toContain("live and stable profiles");

    const viaCapability = structuredClone(base) as typeof base & {
      capability_checks: { stripe: { release?: string[] } };
    };
    viaCapability.capability_checks.stripe.release = ["live_stripe_readback"];
    const capabilityResult = qualitySchema.safeParse(viaCapability);
    expect(capabilityResult.success).toBe(false);
    expect(JSON.stringify(capabilityResult.error?.issues)).toContain("live and stable profiles");
  });

  it("gives every skippable check four actionable fields", () => {
    for (const [id, check] of Object.entries(contract.checks)) {
      if (!(["manual", "provider_readback"] as string[]).includes(check.kind)) continue;
      expect(check.gap, id).toBeDefined();
      expect(check.gap?.why.length, id).toBeGreaterThan(10);
      expect(check.gap?.missing.length, id).toBeGreaterThan(10);
      expect(check.gap?.exact_command.length, id).toBeGreaterThan(5);
      expect(check.gap?.expected_evidence.length, id).toBeGreaterThan(10);
    }
  });

  it("redacts provider patterns and secret-bearing environment values from reports", () => {
    process.env.VH_QUALITY_TEST_SECRET = "quality-private-fixture-value";
    try {
      const output = redactQualityOutput(
        "Bearer abcdefghijklmnop quality-private-fixture-value sk_test_SYNTHETICNOTAREALredactionprobe1",
      );
      expect(output).not.toContain("abcdefghijklmnop");
      expect(output).not.toContain("quality-private-fixture-value");
      expect(output).not.toContain("sk_test_SYNTHETICNOTAREALredactionprobe1");
      expect(output).toContain("[REDACTED]");
    } finally {
      delete process.env.VH_QUALITY_TEST_SECRET;
    }
  });

  it("references only declared checks at valid phases", () => {
    for (const profile of Object.keys(contract.profiles) as QualityProfileId[]) {
      expect(() =>
        resolveProfileChecks(contract, profile, Object.keys(contract.capability_checks)),
      ).not.toThrow();
    }
    for (const check of Object.values(contract.checks)) {
      expect(Number.isInteger(check.phase)).toBe(true);
      expect(check.phase).toBeGreaterThan(0);
    }
  });

  it("returns nonzero for incomplete reports instead of treating skips as green", () => {
    const report = {
      passed: false,
      executed_checks_passed: true,
      status: "INCOMPLETE",
    } as Pick<QualityReport, "passed" | "executed_checks_passed" | "status">;
    expect(qualityProfileExitCode(report)).toBe(1);
    expect(qualityProfileExitCode({ passed: true })).toBe(0);
  });

  it("keeps generic doctor readiness as SKIP even when provider metadata says verified", () => {
    const definition = contract.checks.live_stripe_readback;
    expect(definition.command).toEqual(["pnpm", "vh", "doctor"]);
    const gap = unresolvedProviderReadbackGap(definition, {
      state: "verified",
      credential_ref: "cred://stripe/primary",
    });
    expect(gap.why).toContain("generic doctor exit does not prove");
    expect(gap.missing).toContain("provider-specific sanitized read-back artifact");
    expect(gap.expected_evidence).toContain("read-back");
    expect(gap.origin).toBe("implementation");
  });

  it("rejects matching hand-written report and receipt summaries without a strict bundle", () => {
    const definition = contract.checks.live_stack_readback;
    const root = mkdtempSync(join(tmpdir(), "vh-live-readback-"));
    try {
      const reportPath = join(root, "reports/dogfood/launch-receipt/final.json");
      const receiptPath = join(root, "reports/dogfood/launch-receipt/receipt.json");
      mkdirSync(dirname(reportPath), { recursive: true });
      const evidence = (provider: string, capability: string, account: string) => ({
        provider,
        capability,
        lifecycleState: "verified",
        accountId: account,
        resourceRefs: [`project_id=${provider}-project`],
        evidenceRef: `reports/dogfood/launch-receipt/providers/${provider}.json`,
        verified: true,
      });
      const providers = [
        evidence("github", "repository", "founder-github"),
        evidence("vercel", "production_deployment", "founder-vercel"),
        evidence("neon", "project, schema_migration, read_write_health_check", "founder-neon"),
      ];
      writeFileSync(
        reportPath,
        `${JSON.stringify({
          schemaVersion: 1,
          run: { id: "launch-real-1", status: "succeeded" },
          brief: { id: "launch-receipt", name: "Launch Receipt", synthetic: false },
          providers,
        })}\n`,
      );
      writeFileSync(
        receiptPath,
        `${JSON.stringify({
          schemaVersion: 1,
          venture: {
            name: "Launch Receipt",
            repository: "https://github.com/founder/launch-receipt",
            productionUrl: "https://launch-receipt.vercel.app",
            customDomain: null,
          },
          decision: {
            launchMode: "product_first",
            primarySuccessSignal: "launch_receipt_published",
            reviewDate: "2026-09-01",
            firstValidationAction: "Founder review",
          },
          build: {
            seed: "agentic-web-saas",
            coreVersion: "0.2.0",
            buildAgent: "codex",
            taskCount: 2,
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            totalTokens: null,
            toolCalls: null,
            retries: 0,
            failedCommands: null,
            elapsedMs: 100,
            filesRead: null,
            filesChanged: 12,
          },
          stack: {
            github: "verified",
            vercel: "verified",
            neon: "verified",
            commerce: "waiting",
            email: "waiting",
            analytics: "waiting",
            search: "waiting",
            dns: "planned",
          },
          verification: {
            repository: "verified",
            deployment: "verified",
            database: "verified",
            commerce: "waiting",
            primaryJourney: "verified",
            accessibility: "verified",
            rawHtml: "verified",
            providerReadBack: providers.map((provider) => ({
              provider: provider.provider,
              capability: provider.capability,
              state: "verified",
              evidenceRef: provider.evidenceRef,
            })),
          },
          manualActions: [],
          limitations: ["Stripe remains externally blocked"],
        })}\n`,
      );

      expect(
        evaluateProviderReadbackEvidence("live_stack_readback", definition, {
          root,
          providers: {
            github: { state: "verified", credential_ref: "cred://github/primary" },
            vercel: { state: "verified", credential_ref: "cred://vercel/primary" },
            neon: { state: "verified", credential_ref: "cred://neon/primary" },
            stripe: { state: "verified", credential_ref: "cred://stripe/primary" },
          },
        }),
      ).toMatchObject({
        status: "FAIL",
        gap: null,
      });
      expect(existsSync(join(root, definition.readback!.bundle_manifest))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("distinguishes external provider absence from an implementable parser gap", () => {
    const definition = contract.checks.live_stack_readback;
    const root = mkdtempSync(join(tmpdir(), "vh-live-readback-gap-"));
    try {
      expect(
        evaluateProviderReadbackEvidence("live_stack_readback", definition, {
          root,
          providers: {
            github: { state: "unconfigured", credential_ref: null },
            vercel: { state: "unconfigured", credential_ref: null },
            neon: { state: "unconfigured", credential_ref: null },
            stripe: { state: "unconfigured", credential_ref: null },
          },
        }),
      ).toMatchObject({ status: "SKIP", gap: { origin: "external" } });
      expect(
        evaluateProviderReadbackEvidence(
          "live_stack_readback",
          { ...definition, readback: undefined },
          { root, providers: {} },
        ),
      ).toMatchObject({ status: "FAIL", gap: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses durable verified lifecycle proof without discarding configured credential refs", () => {
    expect(
      mergeVerifiedProviderLifecycleStates(
        { neon: { state: "planned", credential_ref: "cred://neon/primary" } },
        [
          {
            provider: "neon",
            environment: "production",
            capability: "database",
            state: "verified",
            planId: "plan.neon.verified",
            verifiedAt: "2026-08-04T12:00:00.000Z",
            resourceRefs: [{ type: "project_id", value: "project-safe" }],
          },
        ],
      ),
    ).toEqual({ neon: { state: "verified", credential_ref: "cred://neon/primary" } });
  });

  it("accepts concise semantic core HTML without an arbitrary word minimum", () => {
    expect(hasServerRenderedCoreContent("<main><h1>Clear</h1><p>Useful now.</p></main>")).toBe(
      true,
    );
    expect(hasServerRenderedCoreContent("<div><p>Not the main region</p></div>")).toBe(false);
    expect(hasServerRenderedCoreContent("<main><h1>Heading only</h1></main>")).toBe(false);
    expect(hasServerRenderedCoreContent("<main><p></p></main>")).toBe(false);
    expect(
      hasServerRenderedCoreContent("<main><script><p>Not rendered content</p></script></main>"),
    ).toBe(false);
  });

  it("keeps CI staged, cancellable, and data-aware before weekly reporting", () => {
    const qualityWorkflow = readFileSync(".github/workflows/quality.yml", "utf8");
    const workflow = parseDocument(qualityWorkflow).toJS() as {
      jobs: Record<string, { if?: string; needs?: string }>;
    };
    const weeklyWorkflow = readFileSync(".github/workflows/weekly-analysis.yml", "utf8");
    expect(qualityWorkflow).toContain("pnpm verify:fast");
    expect(qualityWorkflow).toContain("pnpm verify:mvp");
    expect(qualityWorkflow).toContain("pnpm verify:release");
    expect(qualityWorkflow).toContain("command_exit=$?");
    expect(qualityWorkflow).toContain('case "${command_exit}:${status}" in');
    expect(qualityWorkflow).toContain("0:PASS|1:INCOMPLETE");
    expect(qualityWorkflow).toContain("cancel-in-progress: true");
    expect(workflow.jobs.release?.if).toBeUndefined();
    expect(workflow.jobs.release?.needs).toBe("mvp");
    expect(workflow.jobs).not.toHaveProperty("workspace-distribution");
    expect(weeklyWorkflow).toContain("pnpm vh data sync");
    expect(weeklyWorkflow).toContain("--fixture --sync-only");
    expect(weeklyWorkflow).toContain("workflow_dispatch:");
    expect(weeklyWorkflow).not.toMatch(/^\s*schedule:/m);
    expect(weeklyWorkflow).toContain("inputs.data_mode == 'synthetic_fixture'");
    expect(weeklyWorkflow.indexOf("Sync direct provider data")).toBeLessThan(
      weeklyWorkflow.indexOf("Aggregate only after"),
    );
    expect(weeklyWorkflow).toContain("--require-data");
  });
});

const packageManifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};

function rootVitestFiles(): string[] {
  return readdirSync("tests", { withFileTypes: true })
    .flatMap((entry) =>
      entry.isFile() && entry.name.endsWith(".test.ts") ? [`tests/${entry.name}`] : [],
    )
    .sort();
}

function globPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^${escaped
      .replaceAll("**/", "\u0000")
      .replaceAll("**", "\u0001")
      .replaceAll("*", "[^/]*")
      .replaceAll("\u0000", "(?:.*/)?")
      .replaceAll("\u0001", ".*")}$`,
    "u",
  );
}

function expandVitestCommand(command: string | string[] | undefined): string[] {
  if (!command) return [];
  const argv = Array.isArray(command) ? command : command.trim().split(/\s+/u);
  if (argv[0] === "pnpm" && argv[1] && packageManifest.scripts[argv[1]]) {
    return expandVitestCommand(packageManifest.scripts[argv[1]]);
  }
  const vitestIndex = argv.indexOf("vitest");
  const runIndex = argv.indexOf("run", vitestIndex + 1);
  if (vitestIndex < 0 || runIndex < 0) return [];

  const includes: string[] = [];
  const excludes: string[] = [];
  for (let index = runIndex + 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--exclude" && argv[index + 1]) {
      excludes.push(argv[index + 1]!.replace(/^(['"])(.*)\1$/u, "$2"));
      index += 1;
    } else if (token.startsWith("--exclude=")) {
      excludes.push(token.slice("--exclude=".length).replace(/^(['"])(.*)\1$/u, "$2"));
    } else if (!token.startsWith("-")) {
      includes.push(token.replace(/^(['"])(.*)\1$/u, "$2"));
    }
  }

  const files = rootVitestFiles();
  const includeMatchers = (includes.length > 0 ? includes : ["tests/**/*.test.ts"]).map(
    globPattern,
  );
  const excludeMatchers = excludes.map(globPattern);
  return files.filter(
    (file) =>
      includeMatchers.some((matcher) => matcher.test(file)) &&
      !excludeMatchers.some((matcher) => matcher.test(file)),
  );
}

function ownedLeafCommands(checkId: string): string[] {
  const definition = contract.checks[checkId];
  if (definition?.kind === "provider_readback" || definition?.kind === "manual") return [];
  const command = definition?.command;
  if (!command) return [];
  if (checkId !== "compatibility_verify") {
    return [Array.isArray(command) ? command.join(" ") : command.trim()];
  }
  const argv = Array.isArray(command) ? command : command.trim().split(/\s+/u);
  const delegated = new Set(
    argv.flatMap((token, index) => (argv[index - 1] === "--delegate" ? [token] : [])),
  );
  return contract.required_commands.always.filter((required) => !delegated.has(required));
}

describe("quality profile ownership regressions", () => {
  it("rejects duplicate YAML mapping keys before they can shadow check ownership", () => {
    const qualitySource = readFileSync("config/quality.yaml", "utf8");
    expect(parseDocument(qualitySource, { uniqueKeys: true }).errors).toEqual([]);
    const duplicate = parseDocument("checks:\n  parity:\n    kind: command\n    kind: manual\n", {
      uniqueKeys: true,
    });
    expect(duplicate.errors.map(({ message }) => message).join(" ")).toMatch(
      /Map keys must be unique/u,
    );
    expect(readFileSync("scripts/run-quality-profile.ts", "utf8")).toContain("uniqueKeys: true");
  });

  it("expands deterministic test and command ownership without overlap", () => {
    const allCapabilities = Object.keys(contract.capability_checks);
    const compatibilityOwned = ownedLeafCommands("compatibility_verify");
    expect(compatibilityOwned).toEqual(
      expect.arrayContaining([
        "pnpm verify:seo",
        "pnpm verify:consent",
        "pnpm verify:pricing-recording",
      ]),
    );
    const expandedMvp = resolveProfileChecks(contract, "mvp", allCapabilities);
    expect(expandedMvp).not.toEqual(
      expect.arrayContaining(["seo_static", "consent_contract", "pricing_integrity"]),
    );
    for (const [tier, selected] of [
      [
        "mvp + release",
        new Set([...expandedMvp, ...resolveProfileChecks(contract, "release", allCapabilities)]),
      ],
      ["stable", new Set(resolveProfileChecks(contract, "stable", allCapabilities))],
    ] as const) {
      const owners = new Map<string, string[]>();
      for (const checkId of selected) {
        for (const file of expandVitestCommand(contract.checks[checkId]?.command)) {
          owners.set(file, [...(owners.get(file) ?? []), checkId]);
        }
      }
      expect(
        rootVitestFiles().filter((file) => !owners.has(file)),
        `${tier}: every root Vitest file must have a deterministic tier owner`,
      ).toEqual([]);
      expect(
        [...owners].filter(([, checkIds]) => checkIds.length > 1),
        `${tier}: a full-suite owner and a focused owner must never execute the same file`,
      ).toEqual([]);

      const commandOwners = new Map<string, string[]>();
      for (const checkId of selected) {
        for (const command of ownedLeafCommands(checkId)) {
          commandOwners.set(command, [...(commandOwners.get(command) ?? []), checkId]);
        }
      }
      expect(
        [...commandOwners].filter(([, checkIds]) => checkIds.length > 1),
        `${tier}: an always-required command and a focused check must never share ownership`,
      ).toEqual([]);
    }
  });
});
