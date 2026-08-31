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
    expect(conciergeGraph.decision.mode.selectedMode).toBe("concierge_first");
    for (const graph of [validationGraph, conciergeGraph]) {
      expect(graph.graph.nodes.filter(({ kind }) => kind === "model").map(({ id }) => id)).toEqual([
        "prepare-repository",
        "review-product",
      ]);
      expect(graph.graph.nodes.some(({ id }) => id === "define-usage-proof")).toBe(false);
      expect(graph.graph.nodes.some(({ id }) => id === "define-validation-gate")).toBe(false);
      expect(graph.graph.nodes.some(({ id }) => id === "prepare-concierge-operations")).toBe(false);
    }
    expect(productGraph.graph.nodes.find(({ id }) => id === "prepare-repository")?.kind).toBe(
      "code",
    );
    expect(
      productGraph.graph.nodes.some(({ id }) =>
        [
          "verify-seed-typecheck",
          "verify-seed-build",
          "verify-seed-readonly",
          "verify-seed-tests",
        ].includes(id),
      ),
    ).toBe(false);
    expect(
      productGraph.graph.nodes.filter(({ kind }) => kind === "model").map(({ id }) => id),
    ).toEqual(["review-product"]);
  });

  it("defaults a valid web dry run to a nonblocking provider production URL", () => {
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
    const seedPreflight = [
      ["verify-seed-typecheck", "launch.verifySeedTypecheck", "install-dependencies"],
      ["verify-seed-build", "launch.verifySeedBuild", "verify-seed-typecheck"],
      ["verify-seed-readonly", "launch.verifySeedReadonly", "verify-seed-build"],
      ["verify-seed-tests", "launch.verifySeedTests", "verify-seed-readonly"],
    ] as const;
    for (const [id, handler, dependency] of seedPreflight) {
      expect(dryRun.graph.nodes.find((node) => node.id === id)).toMatchObject({
        kind: "code",
        handler,
        dependencies: [dependency],
        timeoutMs: 300_000,
      });
    }
    expect(dryRun.graph.nodes.find(({ id }) => id === "prepare-repository")?.dependencies).toEqual([
      "verify-seed-tests",
    ]);
    expect(dryRun.graph.metadata?.initialOrigin).toBe("provider_url");
    expect(dryRun.manualActions).toEqual([]);
    expect(dryRun.graph.nodes.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining([
        "dns-records",
        "verify-custom-domain",
        "brevo-email",
        "google-search-console",
        "bing-discovery",
      ]),
    );
    expect(dryRun.graph.nodes.filter((node) => node.id === "stripe-commerce")).toHaveLength(1);
    expect(dryRun.graph.nodes.find(({ id }) => id === "github-repository")?.dependencies).toEqual([
      "verify-launch",
    ]);
    expect(dryRun.graph.nodes.find(({ id }) => id === "vercel-project")?.dependencies).toEqual([
      "github-repository",
      "neon-database",
      "verify-launch",
    ]);
    expect(
      dryRun.graph.nodes.find(({ id }) => id === "stripe-commerce")?.dependencies,
    ).not.toContain("vercel-project");
    expect(
      dryRun.graph.nodes.find(({ id }) => id === "initial-production-deploy")?.dependencies,
    ).toEqual(["verify-launch", "vercel-project"]);
    expect(dryRun.graph.nodes.find(({ id }) => id === "stripe-callbacks")?.dependencies).toEqual([
      "initial-production-deploy",
      "stripe-commerce",
      "vercel-project",
    ]);
    expect(
      dryRun.graph.nodes.find(({ id }) => id === "vercel-stripe-price-environment")?.dependencies,
    ).toEqual(
      expect.arrayContaining([
        "initial-production-deploy",
        "stripe-callbacks",
        "stripe-commerce",
        "vercel-project",
      ]),
    );
    expect(dryRun.graph.nodes.find(({ id }) => id === "production-deploy")?.dependencies).toEqual(
      expect.arrayContaining([
        "vercel-stripe-environment",
        "vercel-stripe-webhook-environment",
        "vercel-stripe-price-environment",
        "vercel-stripe-price-lookup-environment",
      ]),
    );
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
    for (const prerequisite of [
      "install-dependencies",
      "verify-seed-typecheck",
      "verify-seed-build",
      "verify-seed-readonly",
      "verify-seed-tests",
    ]) {
      expect(ancestors("github-repository")).toContain(prerequisite);
      expect(ancestors("production-deploy")).toContain(prerequisite);
    }
    for (const node of dryRun.graph.nodes.filter(
      ({ effect }) => effect === "external_reversible" || effect === "external_irreversible",
    )) {
      expect(ancestors(node.id), `${node.id} must wait for the frozen child install`).toContain(
        "finalize-dependencies",
      );
      expect(ancestors(node.id), `${node.id} must wait for the complete local MVP gate`).toContain(
        "verify-launch",
      );
    }
    expect(dryRun.graph.nodes.find(({ id }) => id === "launch-report")?.dependencies).toEqual(
      expect.arrayContaining(["verify-production"]),
    );
    expect(dryRun.graph.nodes.find(({ id }) => id === "launch-report")?.dependencies).not.toEqual(
      expect.arrayContaining([
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

  it("keeps the consolidated DNS rail behind an explicit later custom-domain compilation", () => {
    const dryRun = compileLaunchDryRun(
      { ...fixture("web-saas"), domain: "synthetic.example.test" },
      undefined,
      {
        initialOrigin: "custom_domain",
      },
    );

    expect(() => validateWorkflow(dryRun.graph)).not.toThrow();
    expect(dryRun.graph.metadata?.initialOrigin).toBe("custom_domain");
    expect(dryRun.manualActions.map((action) => action.nodeId)).toEqual(["dns-records"]);
    expect(dryRun.graph.nodes.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "dns-records",
        "verify-custom-domain",
        "brevo-email",
        "google-search-console",
        "bing-discovery",
      ]),
    );
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

  it("stages domainless Stripe around a verified production origin and final deploy", () => {
    const base = fixture("web-saas");
    const domainlessStripe: FounderBrief = {
      ...base,
      domain: null,
      needs: {
        ...base.needs,
        transactional_email: false,
        lifecycle_email: false,
        analytics: false,
        search_discovery: false,
      },
    };
    const graph = compileLaunchDryRun(domainlessStripe).graph;
    expect(() => validateWorkflow(graph)).not.toThrow();
    expect(graph.nodes.map(({ id }) => id)).not.toContain("dns-records");
    expect(graph.nodes.find(({ id }) => id === "vercel-project")?.dependencies).not.toContain(
      "stripe-commerce",
    );
    expect(graph.nodes.find(({ id }) => id === "initial-production-deploy")?.dependencies).toEqual([
      "verify-launch",
      "vercel-project",
    ]);
    expect(graph.nodes.find(({ id }) => id === "stripe-callbacks")?.dependencies).toEqual([
      "initial-production-deploy",
      "stripe-commerce",
      "vercel-project",
    ]);
    for (const id of [
      "vercel-stripe-environment",
      "vercel-stripe-webhook-environment",
      "vercel-stripe-price-environment",
      "vercel-stripe-price-lookup-environment",
    ]) {
      expect(graph.nodes.find((node) => node.id === id)?.dependencies).toContain(
        "stripe-callbacks",
      );
      expect(graph.nodes.find((node) => node.id === "production-deploy")?.dependencies).toContain(
        id,
      );
    }
  });

  it("reaches the explicit Apple record and DNS manual nodes before TestFlight continuation", () => {
    const dryRun = compileLaunchDryRun(fixture("ios-subscription"), undefined, {
      initialOrigin: "custom_domain",
    });
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
