import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LaunchBriefError,
  compileLaunchDryRun,
  founderBriefSchema,
  routeLaunch,
  type FounderBrief,
} from "@/lib/launch";
import { validateWorkflow } from "@/lib/workflow";

function fixture(name: string): FounderBrief {
  const raw = parse(readFileSync(resolve("fixtures", name, "brief.yaml"), "utf8"));
  return founderBriefSchema.parse(raw);
}

describe("launch router", () => {
  it("selects a thin web MVP and Stripe without enabling RevenueCat", () => {
    const decision = routeLaunch(fixture("web-saas"));
    expect(decision.mode.selectedMode).toBe("thin_mvp");
    expect(decision.rail).toMatchObject({ appKind: "web", mobileStack: "none" });
    expect(decision.payment.provider).toBe("stripe");
    expect(decision.capabilities).toContain("stripe");
    expect(decision.capabilities).not.toContain("revenuecat");
  });

  it("selects a product-first Expo hybrid and RevenueCat as one entitlement source", () => {
    const decision = routeLaunch(fixture("ios-subscription"));
    expect(decision.mode.selectedMode).toBe("product_first");
    expect(decision.rail).toMatchObject({ appKind: "hybrid", mobileStack: "expo_react_native" });
    expect(decision.payment).toMatchObject({
      provider: "revenuecat",
      entitlementSource: "revenuecat",
    });
    expect(decision.capabilities).toEqual(
      expect.arrayContaining(["revenuecat", "app_store_connect", "eas", "ios_aso"]),
    );
    expect(decision.capabilities).not.toContain("stripe");
  });

  it("blocks deceptive and unsafe requests instead of routing around them", () => {
    const deceptive = { ...fixture("web-saas"), deceptive_request: true };
    expect(() => routeLaunch(deceptive)).toThrowError(LaunchBriefError);
    try {
      routeLaunch(deceptive);
    } catch (error) {
      expect((error as LaunchBriefError).code).toBe("deceptive_request");
    }
  });
});

describe("launch graph compiler", () => {
  it("fails closed when file storage is requested without an explicit provider contract", () => {
    const base = fixture("web-saas");
    const withStorage: FounderBrief = {
      ...base,
      needs: { ...base.needs, file_storage: true },
    };

    expect(() => compileLaunchDryRun(withStorage)).toThrow(
      "file_storage was requested, but Venture Harness v0.2 has no selected storage provider",
    );
  });

  it("changes graph strategy for validate-first, concierge-first, and product-first", () => {
    const base = fixture("web-saas");
    const validateFirst: FounderBrief = {
      ...base,
      factors: {
        ...base.factors,
        smallest_useful_build_cost: "high",
        smallest_useful_build_time: "high",
        regulatory_or_safety_risk: "high",
        real_usage_required: "low",
        founder_evidence: "unknown",
        concierge_delivery_fit: "low",
      },
    };
    const conciergeFirst: FounderBrief = {
      ...base,
      factors: {
        ...base.factors,
        smallest_useful_build_cost: "moderate",
        smallest_useful_build_time: "moderate",
        regulatory_or_safety_risk: "low",
        real_usage_required: "low",
        founder_evidence: "unknown",
        marketplace_cold_start: "high",
        concierge_delivery_fit: "high",
      },
    };

    const validationGraph = compileLaunchDryRun(validateFirst);
    const conciergeGraph = compileLaunchDryRun(conciergeFirst);
    const productGraph = compileLaunchDryRun(fixture("ios-subscription"));

    expect(validationGraph.decision.mode.selectedMode).toBe("validate_first");
    expect(validationGraph.graph.nodes.some(({ id }) => id === "define-validation-gate")).toBe(
      true,
    );
    expect(conciergeGraph.decision.mode.selectedMode).toBe("concierge_first");
    expect(conciergeGraph.graph.nodes.some(({ id }) => id === "prepare-concierge-operations")).toBe(
      true,
    );
    expect(productGraph.graph.nodes.some(({ id }) => id === "define-usage-proof")).toBe(true);
    expect(validationGraph.graph.nodes.some(({ id }) => id === "define-usage-proof")).toBe(false);
    expect(conciergeGraph.graph.nodes.some(({ id }) => id === "define-usage-proof")).toBe(false);
  });

  it("compiles a valid web dry run with one consolidated DNS manual node", () => {
    const dryRun = compileLaunchDryRun(fixture("web-saas"));
    expect(() => validateWorkflow(dryRun.graph)).not.toThrow();
    expect(dryRun.synthetic).toBe(true);
    expect(dryRun.eventPacks).toEqual([
      "core_product",
      "web_acquisition",
      "onboarding",
      "authentication",
      "subscription",
      "content",
      "feedback",
      "reliability",
    ]);
    expect(dryRun.graph.metadata?.activeEventPacks).toEqual(dryRun.eventPacks);
    expect(dryRun.graph.nodes.find(({ id }) => id === "install-dependencies")).toMatchObject({
      kind: "code",
      handler: "launch.installDependencies",
      dependencies: [],
      effect: "local_write",
    });
    expect(dryRun.graph.nodes.find(({ id }) => id === "prepare-repository")?.dependencies).toEqual([
      "install-dependencies",
    ]);
    expect(dryRun.manualActions.map((action) => action.nodeId)).toEqual(["dns-records"]);
    expect(dryRun.graph.nodes.filter((node) => node.id === "stripe-commerce")).toHaveLength(1);
    expect(dryRun.graph.nodes.find(({ id }) => id === "github-repository")?.dependencies).toEqual([
      "verify-local",
    ]);
    expect(dryRun.graph.nodes.find(({ id }) => id === "vercel-project")?.dependencies).toEqual([
      "github-repository",
      "google-analytics-stream",
      "neon-database",
      "stripe-commerce",
      "verify-local",
    ]);
    expect(dryRun.graph.nodes.find(({ id }) => id === "verify-production")?.dependencies).toEqual([
      "production-deploy",
    ]);
    const ancestors = (nodeId: string): Set<string> => {
      const found = new Set<string>();
      const visit = (id: string): void => {
        const node = dryRun.graph.nodes.find((candidate) => candidate.id === id);
        for (const dependency of node?.dependencies ?? []) {
          if (found.has(dependency)) continue;
          found.add(dependency);
          visit(dependency);
        }
      };
      visit(nodeId);
      return found;
    };
    expect(ancestors("github-repository")).toContain("install-dependencies");
    expect(ancestors("production-deploy")).toContain("install-dependencies");
    expect(dryRun.graph.nodes.find(({ id }) => id === "launch-report")?.dependencies).toEqual(
      expect.arrayContaining([
        "verify-production",
        "dns-records",
        "brevo-email",
        "google-search-console",
        "bing-discovery",
      ]),
    );
    expect(dryRun.graph.nodes.find(({ id }) => id === "verify-launch")?.dependencies).not.toContain(
      "dns-records",
    );
    expect(dryRun.parallelLayers.some((layer) => layer.length > 1)).toBe(true);
  });

  it("omits DNS entirely for a valid launch with no domain-dependent capability", () => {
    const base = fixture("web-saas");
    const domainless: FounderBrief = {
      ...base,
      domain: null,
      monetization_model: "none",
      needs: {
        ...base.needs,
        transactional_email: false,
        lifecycle_email: false,
        analytics: false,
        search_discovery: false,
      },
    };

    const dryRun = compileLaunchDryRun(domainless);

    expect(() => validateWorkflow(dryRun.graph)).not.toThrow();
    expect(dryRun.graph.nodes.map(({ id }) => id)).not.toContain("dns-records");
    expect(dryRun.manualActions.map(({ nodeId }) => nodeId)).not.toContain("dns-records");
    expect(dryRun.graph.nodes.find(({ id }) => id === "launch-report")?.dependencies).not.toContain(
      "dns-records",
    );
  });

  it("reaches the explicit Apple record and DNS manual nodes before TestFlight continuation", () => {
    const dryRun = compileLaunchDryRun(fixture("ios-subscription"));
    expect(() => validateWorkflow(dryRun.graph)).not.toThrow();
    expect(dryRun.manualActions.map((action) => action.nodeId).sort()).toEqual([
      "apple-first-app-record",
      "dns-records",
    ]);
    const testflight = dryRun.graph.nodes.find((node) => node.id === "testflight-state");
    expect(testflight?.dependencies).toEqual(
      expect.arrayContaining(["apple-first-app-record", "eas-build"]),
    );
    expect(dryRun.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "eas",
          estimatedCost: "unknown",
          directChargeBasis: null,
          ongoingAccountPlanUsageCovered: false,
        }),
      ]),
    );
    expect(
      dryRun.resources
        .filter(({ provider }) => provider !== "eas")
        .every(
          ({ estimatedCost, directChargeBasis, ongoingAccountPlanUsageCovered }) =>
            estimatedCost === 0 &&
            directChargeBasis === "reviewed_known_zero_direct_charge" &&
            !ongoingAccountPlanUsageCovered,
        ),
    ).toBe(true);
  });
});
