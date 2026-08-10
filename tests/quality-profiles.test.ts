import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  mergeVerifiedProviderLifecycleStates,
  qualityProfileExitCode,
  redactQualityOutput,
  resolveProfileChecks,
  unresolvedProviderReadbackGap,
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
  it("defines fast, MVP, release, live, and stable without removing the compatibility gate", () => {
    expect(Object.keys(contract.profiles)).toEqual(["fast", "mvp", "release", "live", "stable"]);
    expect(contract.required_commands.always).toContain("pnpm test");
    expect(contract.profiles.mvp.checks).toContain("compatibility_verify");
    expect(contract.profiles.mvp.checks).toEqual(
      expect.arrayContaining(["workspace_build", "workspace_contract"]),
    );
    expect(contract.profiles.release.checks).toContain("compatibility_verify");
    expect(contract.profiles.release.checks).toEqual(
      expect.arrayContaining(["workspace_build", "workspace_contract", "workspace_pack_consumer"]),
    );
    expect(contract.checks.workspace_build.command).toEqual(["pnpm", "workspace:build"]);
    expect(contract.checks.workspace_contract.command).toEqual(["pnpm", "workspace:check"]);
    expect(contract.checks.workspace_pack_consumer.command).toEqual(["pnpm", "test:workspace"]);
    expect(contract.checks.workspace_pack_consumer.phase).toBeGreaterThan(
      contract.checks.workspace_build.phase,
    );
    expect(contract.checks.provider_contract_tests.command).toEqual(["pnpm", "test:providers"]);
  });

  it("adds public-web checks but not unrelated mobile or payment checks", () => {
    const checks = resolveProfileChecks(contract, "mvp", ["public_website"]);
    expect(checks).toContain("raw_html");
    expect(checks).toContain("seo_static");
    expect(checks).toContain("analytics_readiness");
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
    expect(checks).toContain("pricing_integrity");
    expect(checks).toContain("provider_contract_tests");
    expect(checks.filter((check) => check === "raw_html")).toHaveLength(1);
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

  it("returns nonzero for incomplete release reports instead of treating skips as green", () => {
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
    const weeklyWorkflow = readFileSync(".github/workflows/weekly-analysis.yml", "utf8");
    expect(qualityWorkflow).toContain("pnpm verify:fast");
    expect(qualityWorkflow).toContain("pnpm verify:mvp");
    expect(qualityWorkflow).toContain("pnpm verify:release");
    expect(qualityWorkflow).toContain("cancel-in-progress: true");
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
