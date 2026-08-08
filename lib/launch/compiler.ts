import { resolveActiveEventPacks } from "../analytics";
import {
  defineWorkflow,
  topologicalOrder,
  workflowNode,
  type WorkflowDefinition,
  type WorkflowNodeDefinition,
} from "../workflow";
import type { DryRunResource, FounderBrief, LaunchDecision, LaunchDryRun } from "./types";
import { founderBriefSchema } from "./types";
import { routeLaunch } from "./router";
import {
  launchManualActionContracts,
  launchManualOutputValidatorName,
  type LaunchManualNodeId,
} from "./manual-evidence";

const capabilityProviders: Record<string, { provider: string; resource: string }> = {
  public_website: { provider: "vercel", resource: "project and deployments" },
  database: {
    provider: "neon",
    resource: "verified project, branch, database, migration, and read/write health",
  },
  transactional_email: { provider: "brevo", resource: "sender, domain, and templates" },
  lifecycle_email: { provider: "brevo", resource: "lifecycle policy and templates" },
  stripe: { provider: "stripe", resource: "product, exact prices, checkout, portal, and webhook" },
  revenuecat: {
    provider: "revenuecat",
    resource: "app, products, entitlement, offering, packages, and webhook",
  },
  ga4: { provider: "google", resource: "GA4 property and data stream" },
  gsc: { provider: "google", resource: "Search Console property and sitemap" },
  bing_webmaster: { provider: "bing", resource: "site and sitemap" },
  vercel_analytics: { provider: "vercel", resource: "verified analytics setting" },
  app_store_connect: {
    provider: "app_store_connect",
    resource: "app record, metadata, builds, and TestFlight groups",
  },
  eas: { provider: "eas", resource: "project, build profiles, build, and submit workflow" },
};

const providerCapabilitiesByNode: Readonly<Record<string, readonly string[]>> = {
  "github-repository": [
    "repository",
    "actions_secret",
    "repository_settings",
    "draft_pull_request",
  ],
  "neon-database": [
    "project",
    "branch",
    "database",
    "role",
    "schema_migration",
    "read_write_health_check",
  ],
  "brevo-sending-domain": ["sending_domain"],
  "brevo-domain-verification": ["sending_domain_verification"],
  "brevo-email": ["sender", "template", "webhook"],
  "stripe-commerce": ["product", "price", "webhook", "billing_portal"],
  "google-analytics-property": ["analytics_property"],
  "google-analytics-stream": ["analytics_web_stream"],
  "google-site-dns-record": ["site_verification_token"],
  "google-site-verification": ["site_verification"],
  "google-search-console": ["search_console_site", "search_console_sitemap"],
  "bing-discovery": ["site", "sitemap", "url_submission"],
  "vercel-project": ["project", "environment_variable", "deployment", "domain", "web_analytics"],
  "dns-records": ["record"],
  "revenuecat-entitlements": ["project_bootstrap", "app", "entitlement", "offering", "webhook"],
  "eas-build": ["ios_build"],
  "eas-submit": ["app_store_connection", "ios_submit"],
  "testflight-state": ["build_processing", "testflight_group", "build_group_assignment"],
  "production-deploy": ["deployment"],
};

function providerNode(
  id: string,
  purpose: string,
  capability: string,
  dependencies: string[],
  transport: "cli" | "api" = "cli",
  authorizationProfile = "standard_launch",
): WorkflowNodeDefinition {
  return workflowNode(id, {
    purpose,
    kind: "provider",
    capability,
    dependencies,
    transport,
    handler: `provider.${id}`,
    effect: "external_reversible",
    risk: "medium",
    authorization: {
      required: true,
      profile: authorizationProfile,
      scopes: [...(providerCapabilitiesByNode[id] ?? [capability])],
    },
    idempotencyKey: `launch:${id}`,
    timeoutMs: 120_000,
    retry: {
      maxAttempts: 3,
      retryableCodes: ["rate_limited", "provider_unavailable", "timeout"],
      backoff: { strategy: "exponential", initialMs: 500, maxMs: 8_000, multiplier: 2 },
    },
    concurrencyGroup: capability,
    cost: { amount: 0, unit: "unknown" },
    budgetCategory: capability,
    evidence: { required: true, artifact: `reports/launch/provider-${id}.json` },
    completion: { description: `${purpose}; provider state read back and verified` },
  });
}

function manualNode(
  id: LaunchManualNodeId,
  purpose: string,
  capability: string,
  dependencies: string[],
  authorizationProfile = "standard_launch",
): WorkflowNodeDefinition {
  return workflowNode(id, {
    purpose,
    kind: "manual_action",
    capability,
    dependencies,
    transport: "manual",
    handler: undefined,
    output: { validator: launchManualOutputValidatorName(id) },
    effect: "external_reversible",
    risk: "medium",
    authorization: { required: true, profile: authorizationProfile, scopes: [capability] },
    idempotencyKey: `manual:${id}`,
    concurrencyGroup: "manual",
    evidence: { required: true, artifact: `reports/launch/manual-${id}.json` },
    completion: {
      description: `${purpose}; submitted fields and verification evidence validated`,
      validator: launchManualOutputValidatorName(id),
    },
  });
}

export function compileLaunchGraph(briefInput: FounderBrief, decisionInput?: LaunchDecision) {
  const brief = founderBriefSchema.parse(briefInput);
  const decision = decisionInput ?? routeLaunch(brief);
  if (decision.capabilities.includes("file_storage")) {
    throw new Error(
      "file_storage was requested, but Venture Harness v0.2 has no selected storage provider, typed provider adapter, or manual evidence contract. Next: select and implement an explicit storage capability before compiling the launch graph; storage cannot be silently omitted.",
    );
  }
  const activeEventPacks = resolveActiveEventPacks({
    capabilities: decision.capabilities,
    appKind: decision.rail.appKind,
    monetizationModel: brief.monetization_model,
    leadJourney: ["lead_generation", "services"].includes(brief.monetization_model),
  });
  const modePreparationNodes: WorkflowNodeDefinition[] = [];
  if (decision.mode.selectedMode === "validate_first") {
    modePreparationNodes.push(
      workflowNode("define-validation-gate", {
        purpose:
          "Define the smallest honest demand test, its primary signal, decision threshold, stop rule, and optional 30/60/90-day gates before product scope expands.",
        kind: "model",
        capability: "validation.strategy",
        dependencies: ["prepare-repository"],
        transport: "model",
        handler: "launch.defineValidationGate",
        model: { tier: "capable" },
        effect: "local_write",
        idempotencyKey: `launch:${brief.id}:validation-gate`,
        concurrencyGroup: "strategy",
        evidence: {
          required: true,
          artifact: "reports/launch/validation-gate.json",
        },
        completion: {
          description:
            "The validation hypothesis, threshold, stop rule, assumptions, and optional timed gates are explicit.",
        },
      }),
    );
  }
  if (decision.mode.selectedMode === "concierge_first") {
    modePreparationNodes.push(
      workflowNode("prepare-concierge-operations", {
        purpose:
          "Define the bounded human-delivery workflow, service limits, disclosures, evidence capture, and handoff before automating the outcome.",
        kind: "model",
        capability: "concierge.operations",
        dependencies: ["prepare-repository"],
        transport: "model",
        handler: "launch.prepareConciergeOperations",
        model: { tier: "capable" },
        effect: "local_write",
        idempotencyKey: `launch:${brief.id}:concierge-operations`,
        concurrencyGroup: "strategy",
        evidence: {
          required: true,
          artifact: "reports/launch/concierge-operations.json",
        },
        completion: {
          description:
            "The concierge journey is deliverable without deception and has capacity, privacy, escalation, and evidence limits.",
        },
      }),
    );
  }
  const designDependencies =
    modePreparationNodes.length > 0
      ? modePreparationNodes.map(({ id }) => id)
      : ["prepare-repository"];
  const postBuildModeNodes: WorkflowNodeDefinition[] =
    decision.mode.selectedMode === "product_first"
      ? [
          workflowNode("define-usage-proof", {
            purpose:
              "Define how real product use will demonstrate the promised value, including activation, retention, quality, and deletion or failure signals.",
            kind: "model",
            capability: "product.usage_proof",
            dependencies: ["build-core-journey", "configure-event-pack"],
            transport: "model",
            handler: "launch.defineUsageProof",
            model: { tier: "capable" },
            effect: "local_write",
            idempotencyKey: `launch:${brief.id}:usage-proof`,
            concurrencyGroup: "strategy",
            evidence: { required: true, artifact: "reports/launch/usage-proof.json" },
            completion: {
              description:
                "Activation, usage, retention, failure, and deletion evidence are connected to the core journey without collecting private content.",
            },
          }),
        ]
      : [];
  const nodes: WorkflowNodeDefinition[] = [
    workflowNode("prepare-repository", {
      purpose: "Create the venture-owned local scaffold and managed-file manifest.",
      capability: "harness.create",
      effect: "local_write",
      handler: "launch.prepareRepository",
      idempotencyKey: `launch:${brief.id}:prepare`,
      concurrencyGroup: "local",
      evidence: { required: true, artifact: "reports/launch/local-scaffold.json" },
    }),
    ...modePreparationNodes,
    workflowNode("design-direction", {
      purpose:
        "Create a distinct, accessible visual direction and responsive composition for the smallest core journey.",
      kind: "model",
      capability: "design.system",
      dependencies: designDependencies,
      transport: "model",
      handler: "launch.designDirection",
      model: { tier: "capable" },
      effect: "local_write",
      idempotencyKey: `launch:${brief.id}:design-direction`,
      concurrencyGroup: "product-build",
      evidence: { required: true, artifact: "reports/launch/design-direction.json" },
      completion: {
        description:
          "Design thesis, tokens, responsive composition, accessibility constraints, and anti-template audit are recorded.",
      },
    }),
    workflowNode("build-core-journey", {
      purpose: `Build and test the smallest useful ${decision.rail.appKind} journey: ${brief.smallest_core_journey}`,
      kind: "model",
      capability:
        decision.rail.appKind === "web"
          ? "product.web"
          : decision.rail.mobileStack === "swiftui"
            ? "product.swiftui"
            : "product.expo",
      dependencies: ["design-direction"],
      transport: "model",
      handler: "launch.buildCoreJourney",
      model: { tier: "capable" },
      effect: "local_write",
      idempotencyKey: `launch:${brief.id}:build-core-journey`,
      timeoutMs: 900_000,
      concurrencyGroup: "product-build",
      evidence: { required: true, artifact: "reports/launch/core-journey.json" },
      completion: {
        description:
          "The declared core journey exists, uses labeled sample data where needed, and has affected tests.",
      },
    }),
    workflowNode("configure-event-pack", {
      purpose:
        "Enable the minimum capability-driven analytics event pack without personal or free-form data.",
      capability: "analytics.event_pack",
      dependencies: ["build-core-journey"],
      handler: "launch.configureEventPack",
      effect: "local_write",
      idempotencyKey: `launch:${brief.id}:event-pack`,
      concurrencyGroup: "analytics",
      evidence: { required: true, artifact: "reports/launch/event-pack.json" },
    }),
    ...postBuildModeNodes,
    workflowNode("verify-local", {
      purpose: "Run affected local tests, schemas, secrets, PII, truth, and core journey checks.",
      capability: "quality.fast",
      dependencies: [
        "build-core-journey",
        "configure-event-pack",
        ...postBuildModeNodes.map(({ id }) => id),
      ],
      handler: "launch.verifyLocal",
      idempotencyKey: `launch:${brief.id}:verify-local`,
      concurrencyGroup: "quality",
      evidence: { required: true, artifact: "reports/quality/launch-fast.json" },
    }),
    providerNode(
      "github-repository",
      "Publish the verified local source tree to the child GitHub repository and read the exact remote commit back.",
      "github_repository",
      ["verify-local"],
    ),
  ];

  const completionDependencies = new Set<string>(["verify-local", "github-repository"]);
  const dnsDependencies: string[] = [];
  const has = (capability: string) => decision.capabilities.includes(capability as never);
  const needsBrevo = has("transactional_email") || has("lifecycle_email");
  const needsGa4 = has("ga4");
  const needsGsc = has("gsc");

  if (has("database")) {
    nodes.push(
      providerNode(
        "neon-database",
        "Create or use an explicitly identified Neon database, capture a generated connection URI only behind a writable credential reference, apply the executable schema migration, and verify read/write health.",
        "database",
        ["prepare-repository"],
      ),
    );
    completionDependencies.add("neon-database");
  }
  if (needsBrevo) {
    nodes.push(
      providerNode(
        "brevo-sending-domain",
        "Create or locate the Brevo sending domain and read back its exact public DNS authentication record plan.",
        "transactional_email",
        ["prepare-repository"],
        "api",
      ),
    );
    dnsDependencies.push("brevo-sending-domain");
  }
  if (has("stripe")) {
    nodes.push(
      providerNode(
        "stripe-commerce",
        "Create and verify test-mode product, exact prices, checkout, portal, and webhook.",
        "stripe",
        ["prepare-repository"],
        "api",
      ),
    );
    completionDependencies.add("stripe-commerce");
  }
  if (needsGa4) {
    nodes.push(
      providerNode(
        "google-analytics-property",
        "Create or locate the GA4 property and read the exact property identifier back.",
        "google_discovery",
        ["prepare-repository"],
        "api",
      ),
      providerNode(
        "google-analytics-stream",
        "Create or locate the GA4 web stream from the same-run property identifier and read its measurement identifier back.",
        "google_discovery",
        ["google-analytics-property"],
        "api",
      ),
    );
    completionDependencies.add("google-analytics-stream");
  }
  if (needsGsc) {
    nodes.push(
      providerNode(
        "google-site-dns-record",
        "Request and read back the exact Google DNS verification token without claiming site ownership.",
        "google_discovery",
        ["prepare-repository"],
        "api",
      ),
    );
    dnsDependencies.push("google-site-dns-record");
  }
  if (has("bing_webmaster")) {
    nodes.push(
      providerNode(
        "bing-discovery",
        "Add or locate the Bing site, submit sitemap, and verify data access.",
        "bing_webmaster",
        ["prepare-repository"],
        "api",
      ),
    );
    completionDependencies.add("bing-discovery");
  }

  nodes.push(
    providerNode(
      "vercel-project",
      "Create or link the explicitly scoped Vercel project, deploy preview, and read project and deployment state back.",
      "public_website",
      ["github-repository", "verify-local"],
    ),
  );
  completionDependencies.add("vercel-project");
  dnsDependencies.push("vercel-project");

  if (brief.preferred_dns_provider === "mijndomein" || brief.preferred_dns_provider === "manual") {
    nodes.push(
      manualNode(
        "dns-records",
        "Apply one ordered DNS task preserving existing MX, SPF, DKIM, and DMARC records, then verify propagation.",
        "dns",
        [...new Set(dnsDependencies)].sort(),
      ),
    );
  } else {
    nodes.push(
      providerNode(
        "dns-records",
        "Apply additive DNS records idempotently and verify propagation without replacing nameservers.",
        "dns",
        [...new Set(dnsDependencies)].sort(),
        "api",
      ),
    );
  }
  completionDependencies.add("dns-records");

  if (needsBrevo) {
    nodes.push(
      providerNode(
        "brevo-domain-verification",
        "Authenticate the Brevo sending domain only after the planned DNS records are verified, then require authenticated=true by read-back.",
        "transactional_email",
        ["dns-records", "brevo-sending-domain"],
        "api",
      ),
      providerNode(
        "brevo-email",
        "Create and read back the reviewed sender, inactive template, and optional webhook without sending email.",
        "transactional_email",
        ["brevo-domain-verification"],
        "api",
      ),
    );
    completionDependencies.add("brevo-email");
  }

  if (needsGsc) {
    nodes.push(
      providerNode(
        "google-site-verification",
        "Ask Google Site Verification to verify the already-published DNS token and read ownership back.",
        "google_discovery",
        ["dns-records", "google-site-dns-record"],
        "api",
      ),
      providerNode(
        "google-search-console",
        "Add and read back the Search Console property and sitemap after Google ownership verification; do not infer indexing.",
        "google_discovery",
        ["google-site-verification"],
        "api",
      ),
    );
    completionDependencies.add("google-search-console");
  }

  if (decision.rail.appKind !== "web") {
    nodes.push(
      manualNode(
        "apple-first-app-record",
        "Create the first App Store Connect app record and return app name, bundle ID, SKU, language, Apple app ID, and team ID.",
        "app_store_connect",
        ["prepare-repository"],
        "mobile_testflight",
      ),
    );
    if (has("revenuecat")) {
      nodes.push(
        providerNode(
          "revenuecat-entitlements",
          "Configure Test Store app, products, entitlement, offering, packages, and webhook; keep Apple products pending until verified.",
          "revenuecat",
          ["prepare-repository"],
          "api",
        ),
      );
      completionDependencies.add("revenuecat-entitlements");
    }
    if (has("eas")) {
      nodes.push(
        providerNode(
          "eas-build",
          "Configure EAS project/build profiles and produce a reproducible iOS build.",
          "eas",
          ["build-core-journey", "verify-local"],
          "cli",
          "mobile_testflight",
        ),
        providerNode(
          "eas-submit",
          "Connect the exact same-run Apple app record, submit the verified EAS build, and read submission state back without claiming TestFlight processing.",
          "eas",
          ["apple-first-app-record", "eas-build"],
          "cli",
          "mobile_testflight",
        ),
        providerNode(
          "testflight-state",
          "Read the submitted build from App Store Connect by app/version/build number, require VALID processing, and verify its TestFlight group assignment without claiming publication.",
          "app_store_connect",
          ["apple-first-app-record", "eas-build", "eas-submit"],
          "api",
          "mobile_testflight",
        ),
      );
      completionDependencies.add("testflight-state");
    }
  }

  nodes.push(
    workflowNode("verify-launch", {
      purpose:
        "Verify every active critical journey, provider read-back, web/mobile behavior, and release invariant.",
      capability: "quality.mvp",
      dependencies: [...completionDependencies].sort(),
      handler: "launch.verifyMvp",
      idempotencyKey: `launch:${brief.id}:verify-mvp`,
      concurrencyGroup: "quality",
      evidence: { required: true, artifact: "reports/quality/launch-mvp.json" },
    }),
    providerNode(
      "production-deploy",
      "Deploy the verified web surface to production and read the immutable deployment and domain state back.",
      "public_website",
      ["verify-launch"],
    ),
    workflowNode("verify-production", {
      purpose:
        "Run read-only HTTPS smoke plus desktop and mobile critical-surface journeys against the exact production URL returned by deployment read-back.",
      capability: "quality.post_deploy",
      dependencies: ["production-deploy"],
      handler: "launch.verifyProduction",
      effect: "read",
      idempotencyKey: `launch:${brief.id}:verify-production`,
      concurrencyGroup: "quality",
      evidence: { required: true, artifact: "reports/quality/post-deploy.json" },
    }),
    workflowNode("launch-report", {
      purpose: "Write sanitized human and JSON launch reports with only genuine remaining actions.",
      capability: "launch.report",
      dependencies: ["verify-production"],
      handler: "launch.report",
      idempotencyKey: `launch:${brief.id}:report`,
      concurrencyGroup: "report",
      evidence: { required: true, artifact: "reports/launch/final.json" },
    }),
  );

  const budgets = Object.fromEntries(
    [...new Set(nodes.map((node) => node.budgetCategory))].map((category) => [category, 0]),
  );
  return defineWorkflow({
    id: `launch-${brief.id}`,
    name: `Launch ${brief.name}`,
    version: "0.2.0",
    nodes,
    maxParallel: 4,
    // This is a scheduler safety bound, not a product-loop budget. A launch
    // graph can legitimately need several parallel batches plus resumptions.
    maxIterations: Math.max(50, nodes.length * 4),
    budgets,
    metadata: {
      synthetic: brief.synthetic ?? false,
      launchMode: decision.mode.selectedMode,
      appKind: decision.rail.appKind,
      paymentProvider: decision.payment.provider,
      activeEventPacks,
    },
  });
}

function parallelLayers(graph: WorkflowDefinition): string[][] {
  const layer = new Map<string, number>();
  for (const id of topologicalOrder(graph)) {
    const node = graph.nodes.find((candidate) => candidate.id === id)!;
    layer.set(
      id,
      node.dependencies.length === 0
        ? 0
        : 1 + Math.max(...node.dependencies.map((dep) => layer.get(dep) ?? 0)),
    );
  }
  const out: string[][] = [];
  for (const [id, index] of layer) (out[index] ??= []).push(id);
  return out.map((ids) => ids.sort());
}

function criticalPath(graph: WorkflowDefinition): string[] {
  const best = new Map<string, string[]>();
  for (const id of topologicalOrder(graph)) {
    const node = graph.nodes.find((candidate) => candidate.id === id)!;
    const prefix =
      node.dependencies
        .map((dependency) => best.get(dependency) ?? [])
        .sort((a, b) => b.length - a.length || a.join().localeCompare(b.join()))[0] ?? [];
    best.set(id, [...prefix, id]);
  }
  return (
    [...best.values()].sort((a, b) => b.length - a.length || a.join().localeCompare(b.join()))[0] ??
    []
  );
}

export function compileLaunchDryRun(briefInput: FounderBrief): LaunchDryRun {
  const brief = founderBriefSchema.parse(briefInput);
  const decision = routeLaunch(brief);
  const graph = compileLaunchGraph(brief, decision);
  const eventPacks = resolveActiveEventPacks({
    capabilities: decision.capabilities,
    appKind: decision.rail.appKind,
    monetizationModel: brief.monetization_model,
    leadJourney: ["lead_generation", "services"].includes(brief.monetization_model),
  });
  const resources: DryRunResource[] = [];
  for (const capability of decision.capabilities) {
    const mapped = capabilityProviders[capability];
    if (!mapped) continue;
    resources.push({
      provider: mapped.provider,
      resource: mapped.resource,
      environment:
        mapped.provider === "stripe"
          ? "test"
          : mapped.provider === "revenuecat"
            ? "test"
            : "preview",
      estimatedCost: "unknown",
    });
  }
  return {
    synthetic: brief.synthetic ?? false,
    decision,
    eventPacks,
    graph,
    resources,
    manualActions: graph.nodes
      .filter((node) => node.kind === "manual_action")
      .map((node) => {
        const contract = launchManualActionContracts[node.id as LaunchManualNodeId];
        if (!contract) throw new Error(`No manual action contract exists for ${node.id}.`);
        return { purpose: node.purpose, ...contract };
      }),
    criticalPath: criticalPath(graph),
    parallelLayers: parallelLayers(graph),
    authorizationRequirements: [
      ...new Set(
        graph.nodes
          .filter((node) => node.authorization.required)
          .flatMap((node) => node.authorization.scopes),
      ),
    ].sort(),
    verificationCommands: ["pnpm verify:fast", "pnpm verify:mvp", "pnpm test:fixtures"],
  };
}
