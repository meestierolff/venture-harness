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
  stripe: {
    provider: "stripe",
    resource: "test-mode product, exact monthly EUR price, billing portal, and webhook",
  },
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

const providerUrlDeferredCapabilities = new Set([
  "transactional_email",
  "lifecycle_email",
  "ga4",
  "gsc",
  "bing_webmaster",
  "vercel_analytics",
]);

export const launchProviderCapabilitiesByNode: Readonly<Record<string, readonly string[]>> = {
  "github-repository": ["repository"],
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
  "stripe-commerce": ["product", "price"],
  "stripe-callbacks": ["webhook", "billing_portal"],
  "stripe-domain-callbacks": ["webhook", "billing_portal"],
  "google-analytics-property": ["analytics_property"],
  "google-analytics-stream": ["analytics_web_stream"],
  "google-site-dns-record": ["site_verification_token"],
  "google-site-verification": ["site_verification"],
  "google-search-console": ["search_console_site", "search_console_sitemap"],
  "bing-discovery": ["site", "sitemap", "url_submission"],
  "vercel-project": ["project", "deployment", "domain"],
  "vercel-database-environment": ["environment_variable"],
  "vercel-stripe-environment": ["environment_variable"],
  "vercel-stripe-webhook-environment": ["environment_variable"],
  "vercel-stripe-price-environment": ["environment_variable"],
  "vercel-stripe-price-lookup-environment": ["environment_variable"],
  "vercel-brevo-environment": ["environment_variable"],
  "vercel-ga-environment": ["environment_variable"],
  "dns-records": ["record"],
  "revenuecat-entitlements": ["project_bootstrap", "app", "entitlement", "offering", "webhook"],
  "eas-build": ["ios_build"],
  "eas-submit": ["app_store_connection", "ios_submit"],
  "testflight-state": ["build_processing", "testflight_group", "build_group_assignment"],
  "production-deploy": ["deployment"],
  "initial-production-deploy": ["deployment"],
  "analytics-production-redeploy": ["deployment"],
  "email-production-redeploy": ["deployment"],
};

export const launchProviderByNode = {
  "github-repository": "github",
  "neon-database": "neon",
  "brevo-sending-domain": "brevo",
  "brevo-domain-verification": "brevo",
  "brevo-email": "brevo",
  "stripe-commerce": "stripe",
  "stripe-callbacks": "stripe",
  "stripe-domain-callbacks": "stripe",
  "google-analytics-property": "google",
  "google-analytics-stream": "google",
  "google-site-dns-record": "google",
  "google-site-verification": "google",
  "google-search-console": "google",
  "bing-discovery": "bing",
  "vercel-project": "vercel",
  "vercel-database-environment": "vercel",
  "vercel-stripe-environment": "vercel",
  "vercel-stripe-webhook-environment": "vercel",
  "vercel-stripe-price-environment": "vercel",
  "vercel-stripe-price-lookup-environment": "vercel",
  "vercel-brevo-environment": "vercel",
  "vercel-ga-environment": "vercel",
  "production-deploy": "vercel",
  "initial-production-deploy": "vercel",
  "analytics-production-redeploy": "vercel",
  "email-production-redeploy": "vercel",
  "dns-records": "dns",
  "revenuecat-entitlements": "revenuecat",
  "apple-first-app-record": "app_store_connect",
  "eas-build": "eas",
  "eas-submit": "eas",
  "testflight-state": "app_store_connect",
} as const satisfies Readonly<Record<string, string>>;

/**
 * Integrations in this set are deferred from the one-prompt founder launch.
 * Their typed gaps remain durable in the Launch Receipt, while the initial
 * graph stops at a verified provider production URL. A later, separately
 * authorized workflow can attach DNS and the optional integrations.
 */
export const launchOptionalProviderNodeIds: ReadonlySet<string> = new Set([
  "brevo-sending-domain",
  "brevo-domain-verification",
  "brevo-email",
  "google-analytics-property",
  "google-analytics-stream",
  "google-site-dns-record",
  "google-site-verification",
  "google-search-console",
  "bing-discovery",
  "dns-records",
  "vercel-brevo-environment",
  "vercel-ga-environment",
  "analytics-production-redeploy",
  "email-production-redeploy",
  "verify-custom-domain",
  "stripe-domain-callbacks",
]);

export interface LaunchCompilationOptions {
  /**
   * The first launch defaults to the provider URL. A custom-domain workflow is
   * an explicit later authorization boundary after authoritative DNS read-back.
   */
  initialOrigin?: "provider_url" | "custom_domain";
}

const launchProviderOperationCeilingOverrides: Readonly<Record<string, number>> = Object.freeze({
  // Vercel project planning performs a project lookup/create boundary plus the
  // preview deployment while remaining inside the two exact capabilities.
  "vercel-project": 3,
});

export function launchProviderNodeOperationCeiling(node: WorkflowNodeDefinition): number {
  return (
    launchProviderOperationCeilingOverrides[node.id] ??
    Math.max(1, node.authorization.scopes.length)
  );
}

/** Conservative per-node sum bound for the immutable founder Grant. */
export function launchProviderOperationCeiling(definition: WorkflowDefinition): number {
  return definition.nodes
    .filter((node) => node.kind === "provider")
    .reduce((total, node) => total + launchProviderNodeOperationCeiling(node), 0);
}

export const launchBuildAgentHandlers = new Set([
  "launch.prepareRepository",
  "launch.reviewProduct",
]);

export function launchBuildAgentTaskCount(definition: WorkflowDefinition): number {
  return definition.nodes.filter(
    (node) => node.kind === "model" && node.handler && launchBuildAgentHandlers.has(node.handler),
  ).length;
}

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
      scopes: [...(launchProviderCapabilitiesByNode[id] ?? [capability])],
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

export function compileLaunchGraph(
  briefInput: FounderBrief,
  decisionInput?: LaunchDecision,
  options: LaunchCompilationOptions = {},
) {
  const brief = founderBriefSchema.parse(briefInput);
  const decision = decisionInput ?? routeLaunch(brief);
  const initialOrigin = options.initialOrigin ?? "provider_url";
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
  const dependencyBootstrapNodes: WorkflowNodeDefinition[] =
    decision.rail.appKind === "web"
      ? [
          workflowNode("install-dependencies", {
            purpose:
              "Install the ordinary child repository's exact lockfile before any product build or quality command runs.",
            capability: "dependencies.install",
            handler: "launch.installDependencies",
            effect: "local_write",
            idempotencyKey: `launch:${brief.id}:install-dependencies`,
            timeoutMs: 300_000,
            retry: {
              maxAttempts: 2,
              retryableCodes: ["DEPENDENCY_INSTALL_FAILED"],
              backoff: { strategy: "none", initialMs: 0, maxMs: 0, multiplier: 1 },
            },
            reconciliation: {
              handler: "launch.installDependencies",
              pollIntervalMs: 0,
              maxPollAttempts: 1,
            },
            concurrencyGroup: "local",
            evidence: {
              required: true,
              artifact: "reports/quality/dependency-install.json",
            },
            completion: {
              description:
                "The exact child lockfile installed successfully through a direct package-manager argv without joining the parent workspace or executing third-party lifecycle scripts.",
            },
          }),
        ]
      : [];
  const seedVerificationNodes: WorkflowNodeDefinition[] =
    decision.rail.appKind === "web"
      ? [
          workflowNode("verify-seed-typecheck", {
            purpose:
              "Typecheck the unchanged deterministic web seed before any model-authored product work starts.",
            kind: "code",
            capability: "quality.seed_typecheck",
            dependencies: ["install-dependencies"],
            handler: "launch.verifySeedTypecheck",
            idempotencyKey: `launch:${brief.id}:verify-seed-typecheck`,
            timeoutMs: 300_000,
            concurrencyGroup: "quality",
            evidence: {
              required: true,
              artifact: "reports/quality/seed-typecheck.json",
            },
          }),
          workflowNode("verify-seed-build", {
            purpose:
              "Build the unchanged deterministic web seed before any model-authored product work starts.",
            kind: "code",
            capability: "quality.seed_build",
            dependencies: ["verify-seed-typecheck"],
            handler: "launch.verifySeedBuild",
            idempotencyKey: `launch:${brief.id}:verify-seed-build`,
            timeoutMs: 300_000,
            concurrencyGroup: "quality",
            evidence: {
              required: true,
              artifact: "reports/quality/seed-build.json",
            },
          }),
          workflowNode("verify-seed-readonly", {
            purpose:
              "Run the unchanged deterministic web seed's read-only end-to-end check before any model-authored product work starts.",
            kind: "code",
            capability: "quality.seed_readonly",
            dependencies: ["verify-seed-build"],
            handler: "launch.verifySeedReadonly",
            idempotencyKey: `launch:${brief.id}:verify-seed-readonly`,
            timeoutMs: 300_000,
            concurrencyGroup: "quality",
            evidence: {
              required: true,
              artifact: "reports/quality/seed-readonly.json",
            },
          }),
          workflowNode("verify-seed-tests", {
            purpose:
              "Run the unchanged deterministic web seed's full test suite before any model-authored product work starts.",
            kind: "code",
            capability: "quality.seed_tests",
            dependencies: ["verify-seed-readonly"],
            handler: "launch.verifySeedTests",
            idempotencyKey: `launch:${brief.id}:verify-seed-tests`,
            timeoutMs: 300_000,
            concurrencyGroup: "quality",
            evidence: {
              required: true,
              artifact: "reports/quality/seed-tests.json",
            },
          }),
        ]
      : [];
  const dependencyFinalizationNodes: WorkflowNodeDefinition[] =
    decision.rail.appKind === "web"
      ? [
          workflowNode("finalize-dependencies", {
            purpose:
              "Re-verify the Core-owned package execution policy and checkpoint the unchanged exact child lockfile after product work; reject any package, script, lifecycle-policy, or lock mutation.",
            capability: "dependencies.install",
            dependencies: ["prepare-repository"],
            handler: "launch.installDependencies",
            effect: "local_write",
            idempotencyKey: `launch:${brief.id}:finalize-dependencies`,
            timeoutMs: 300_000,
            retry: {
              maxAttempts: 2,
              retryableCodes: ["DEPENDENCY_INSTALL_FAILED"],
              backoff: { strategy: "none", initialMs: 0, maxMs: 0, multiplier: 1 },
            },
            reconciliation: {
              handler: "launch.installDependencies",
              pollIntervalMs: 0,
              maxPollAttempts: 1,
            },
            concurrencyGroup: "local",
            evidence: {
              required: true,
              artifact: "reports/quality/dependency-finalization.json",
            },
            completion: {
              description:
                "The reviewed package scripts, dependencies, empty lifecycle-build allowlist, and exact lockfile are unchanged, installed, and read back before provider, source publication, or deployment work proceeds.",
            },
          }),
        ]
      : [];
  const repositoryReadyNodeId =
    decision.rail.appKind === "web" ? "finalize-dependencies" : "prepare-repository";
  const nodes: WorkflowNodeDefinition[] = [
    ...dependencyBootstrapNodes,
    ...seedVerificationNodes,
    workflowNode("prepare-repository", {
      purpose:
        decision.rail.appKind === "web"
          ? `In one bounded build call, refine the proposition, create the venture-specific design, and implement and test the smallest useful journey: ${brief.smallest_core_journey}`
          : "Create the venture-owned native scaffold and managed-file manifest before product review.",
      kind: decision.rail.appKind === "web" ? "model" : "code",
      capability:
        decision.rail.appKind === "web"
          ? "product.web"
          : decision.rail.mobileStack === "swiftui"
            ? "product.swiftui"
            : "product.expo",
      dependencies:
        decision.rail.appKind === "web"
          ? ["verify-seed-tests"]
          : dependencyBootstrapNodes.map(({ id }) => id),
      transport: decision.rail.appKind === "web" ? "model" : "code",
      effect: "local_write",
      handler: "launch.prepareRepository",
      ...(decision.rail.appKind === "web" ? { model: { tier: "capable" as const } } : {}),
      idempotencyKey: `launch:${brief.id}:prepare`,
      timeoutMs: decision.rail.appKind === "web" ? 900_000 : 120_000,
      concurrencyGroup: "product-build",
      evidence: { required: true, artifact: "reports/launch/local-scaffold.json" },
      completion: {
        description:
          decision.rail.appKind === "web"
            ? "The venture scaffold, proposition, original responsive design, core journey, affected tests, and minimum privacy-safe event instrumentation are complete in one coherent product build. Mode-specific validation, concierge, or usage proof is included only when selected."
            : "The selected native scaffold and managed manifest are complete.",
      },
    }),
    ...dependencyFinalizationNodes,
    workflowNode("review-product", {
      purpose:
        "Independently review the proposition, venture-specific design, primary journey, tests, truth, accessibility, responsive behavior, analytics privacy, and selected-mode evidence; make only focused repairs and verify them.",
      kind: "model",
      capability: "product.review_repair",
      dependencies: [repositoryReadyNodeId],
      transport: "model",
      handler: "launch.reviewProduct",
      model: { tier: "capable" },
      effect: "local_write",
      idempotencyKey: `launch:${brief.id}:review-product`,
      timeoutMs: 900_000,
      concurrencyGroup: "product-build",
      evidence: { required: true, artifact: "reports/launch/product-review.json" },
      completion: {
        description:
          "An independent pass has exercised the primary journey and directly checked the affected product; defects are repaired or recorded as exact blockers without broadening scope.",
      },
    }),
    workflowNode("verify-local", {
      purpose: "Run affected local tests, schemas, secrets, PII, truth, and core journey checks.",
      capability: "quality.fast",
      dependencies: ["review-product"],
      handler: "launch.verifyLocal",
      idempotencyKey: `launch:${brief.id}:verify-local`,
      concurrencyGroup: "quality",
      evidence: { required: true, artifact: "reports/quality/launch-fast.json" },
    }),
    workflowNode("verify-launch", {
      purpose:
        "Run the complete local child MVP gate, including typecheck, production build, deterministic product checks, and the primary journey, before any provider effect is permitted.",
      capability: "quality.mvp",
      dependencies: ["verify-local"],
      handler: "launch.verifyMvp",
      idempotencyKey: `launch:${brief.id}:verify-mvp`,
      concurrencyGroup: "quality",
      evidence: { required: true, artifact: "reports/quality/launch-mvp.json" },
    }),
    providerNode(
      "github-repository",
      "Publish the verified local source tree to the child GitHub repository and read the exact remote commit back.",
      "github_repository",
      ["verify-launch"],
    ),
  ];

  const completionDependencies = new Set<string>(["verify-launch", "github-repository"]);
  const preDeployDependencies = new Set<string>(["verify-launch", "github-repository"]);
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
        ["verify-launch"],
      ),
    );
    completionDependencies.add("neon-database");
    preDeployDependencies.add("neon-database");
  }
  if (needsBrevo) {
    nodes.push(
      providerNode(
        "brevo-sending-domain",
        "Create or locate the Brevo sending domain and read back its exact public DNS authentication record plan.",
        "transactional_email",
        ["verify-launch"],
        "api",
      ),
    );
    dnsDependencies.push("brevo-sending-domain");
  }
  if (has("stripe")) {
    nodes.push(
      providerNode(
        "stripe-commerce",
        "Create and verify the test-mode product and one exact immutable price before any deployment callback is configured.",
        "stripe",
        ["verify-launch"],
        "api",
      ),
    );
    completionDependencies.add("stripe-commerce");
    preDeployDependencies.add("stripe-commerce");
  }
  if (needsGa4) {
    nodes.push(
      providerNode(
        "google-analytics-property",
        "Create or locate the GA4 property and read the exact property identifier back.",
        "google_discovery",
        ["verify-launch"],
        "api",
      ),
    );
  }
  if (needsGsc) {
    nodes.push(
      providerNode(
        "google-site-dns-record",
        "Request and read back the exact Google DNS verification token without claiming site ownership.",
        "google_discovery",
        ["verify-launch"],
        "api",
      ),
    );
    dnsDependencies.push("google-site-dns-record");
  }
  if (has("bing_webmaster")) {
    nodes.push(
      providerNode(
        "bing-discovery",
        "Add or locate the exact Bing site after production is reachable, submit its sitemap, and verify data access.",
        "bing_webmaster",
        ["production-deploy"],
        "api",
      ),
    );
  }

  nodes.push(
    providerNode(
      "vercel-project",
      "Create or link the explicitly scoped Vercel project, configure its domain when declared, deploy preview, and read project and deployment state back.",
      "public_website",
      [...preDeployDependencies].filter((id) => id !== "stripe-commerce").sort(),
    ),
  );
  completionDependencies.add("vercel-project");
  dnsDependencies.push("vercel-project");

  const environmentNodes: WorkflowNodeDefinition[] = [];
  if (has("database")) {
    environmentNodes.push(
      providerNode(
        "vercel-database-environment",
        "Bind the brokered Neon connection URI to the Vercel production DATABASE_URL variable and verify only its name and target by read-back.",
        "public_website",
        ["neon-database", "vercel-project"],
      ),
    );
  }
  if (has("stripe")) {
    environmentNodes.push(
      providerNode(
        "vercel-stripe-environment",
        "Bind the restricted Stripe credential reference to STRIPE_SECRET_KEY in Vercel production without reading its value back.",
        "public_website",
        ["stripe-commerce", "vercel-project"],
      ),
      providerNode(
        "vercel-stripe-webhook-environment",
        "Bind the captured Stripe webhook signing secret reference to STRIPE_WEBHOOK_SECRET in Vercel production without persisting the value.",
        "public_website",
        ["stripe-callbacks", "vercel-project"],
      ),
      providerNode(
        "vercel-stripe-price-environment",
        "Bind the same-run read-back Stripe price ID as a typed non-secret production application variable.",
        "public_website",
        ["stripe-commerce", "vercel-project"],
      ),
      providerNode(
        "vercel-stripe-price-lookup-environment",
        "Bind the deterministic immutable Stripe price lookup key as a typed non-secret production application variable.",
        "public_website",
        ["stripe-commerce", "vercel-project"],
      ),
    );
  }
  if (needsBrevo) {
    environmentNodes.push(
      providerNode(
        "vercel-brevo-environment",
        "Bind the restricted Brevo credential reference to BREVO_API_KEY in Vercel production without reading its value back.",
        "public_website",
        ["brevo-email", "vercel-project"],
      ),
    );
  }
  if (needsGa4) {
    environmentNodes.push(
      providerNode(
        "vercel-ga-environment",
        "Bind the read-back GA4 measurement identifier reference to NEXT_PUBLIC_GA_MEASUREMENT_ID in Vercel production.",
        "public_website",
        ["google-analytics-stream", "vercel-project"],
      ),
    );
  }
  const criticalPreOriginEnvironmentNodes = environmentNodes.filter(
    ({ id }) => id === "vercel-database-environment",
  );
  const stripeEnvironmentNodes = environmentNodes.filter(({ id }) =>
    id.startsWith("vercel-stripe-"),
  );
  const optionalIntegrationEnvironmentNodes = environmentNodes.filter(
    ({ id }) => id === "vercel-brevo-environment" || id === "vercel-ga-environment",
  );
  nodes.push(...criticalPreOriginEnvironmentNodes);
  for (const node of criticalPreOriginEnvironmentNodes) {
    preDeployDependencies.add(node.id);
    completionDependencies.add(node.id);
  }

  const needsDnsRecords = Boolean(brief.domain) || needsBrevo || needsGsc;
  if (needsDnsRecords) {
    if (
      brief.preferred_dns_provider === "mijndomein" ||
      brief.preferred_dns_provider === "manual"
    ) {
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
  }

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
  }

  if (decision.rail.appKind !== "web") {
    nodes.push(
      manualNode(
        "apple-first-app-record",
        "Create the first App Store Connect app record and return app name, bundle ID, SKU, language, Apple app ID, and team ID.",
        "app_store_connect",
        ["verify-launch"],
        "mobile_testflight",
      ),
    );
    if (has("revenuecat")) {
      nodes.push(
        providerNode(
          "revenuecat-entitlements",
          "Configure Test Store app, products, entitlement, offering, packages, and webhook; keep Apple products pending until verified.",
          "revenuecat",
          ["verify-launch"],
          "api",
        ),
      );
      completionDependencies.add("revenuecat-entitlements");
      preDeployDependencies.add("revenuecat-entitlements");
    }
    if (has("eas")) {
      nodes.push(
        providerNode(
          "eas-build",
          "Configure EAS project/build profiles and produce a reproducible iOS build.",
          "eas",
          ["verify-launch"],
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
      preDeployDependencies.add("testflight-state");
    }
  }

  const needsInitialProductionOrigin = has("stripe");
  if (needsInitialProductionOrigin) {
    nodes.push(
      providerNode(
        "initial-production-deploy",
        "Create and read back one initial production deployment so origin-dependent integrations bind to a real production URL, never a preview URL.",
        "public_website",
        ["verify-launch", "vercel-project"],
      ),
    );
    completionDependencies.add("initial-production-deploy");
  }
  if (has("stripe")) {
    nodes.push(
      providerNode(
        "stripe-callbacks",
        "Create and verify the Stripe test-mode webhook and billing portal against the exact same-run production deployment origin; a merely declared custom domain is never selected.",
        "stripe",
        ["initial-production-deploy", "stripe-commerce", "vercel-project"],
        "api",
      ),
      ...stripeEnvironmentNodes.map((node) => ({
        ...node,
        dependencies: [
          ...new Set([...node.dependencies, "initial-production-deploy", "stripe-callbacks"]),
        ].sort(),
      })),
    );
    completionDependencies.add("stripe-callbacks");
    for (const node of stripeEnvironmentNodes) completionDependencies.add(node.id);
  } else {
    nodes.push(...stripeEnvironmentNodes);
  }
  nodes.push(
    ...optionalIntegrationEnvironmentNodes.filter(({ id }) => id === "vercel-brevo-environment"),
  );
  if (needsGa4) {
    const analyticsOriginDependency = has("stripe")
      ? "initial-production-deploy"
      : "production-deploy";
    nodes.push(
      providerNode(
        "google-analytics-stream",
        "Create and verify the GA4 web stream from the same-run property id and exact production origin; a preview URL is never accepted.",
        "google_discovery",
        ["google-analytics-property", analyticsOriginDependency],
        "api",
      ),
      ...optionalIntegrationEnvironmentNodes.filter(({ id }) => id === "vercel-ga-environment"),
    );
  }
  const finalProductionDependencies = has("stripe")
    ? [...stripeEnvironmentNodes, ...criticalPreOriginEnvironmentNodes].map(({ id }) => id)
    : ["verify-launch", "vercel-project", ...criticalPreOriginEnvironmentNodes.map(({ id }) => id)];
  nodes.push(
    providerNode(
      "production-deploy",
      "Deploy the final verified web surface with all typed application bindings, then read the immutable production deployment and domain state back.",
      "public_website",
      finalProductionDependencies,
    ),
    ...(needsGa4
      ? [
          providerNode(
            "analytics-production-redeploy",
            "Redeploy production only after the verified public GA4 measurement identifier is bound.",
            "public_website",
            ["production-deploy", "vercel-ga-environment"],
          ),
        ]
      : []),
    ...(needsBrevo
      ? [
          providerNode(
            "email-production-redeploy",
            "Redeploy production only after the verified Brevo application credential binding is ready.",
            "public_website",
            ["production-deploy", "vercel-brevo-environment"],
          ),
        ]
      : []),
    workflowNode("verify-production", {
      purpose:
        "Run the generic read-only deployment-surface check, then the exact Launch Contract primary journey under a labeled test identity with bounded reversible writes and verified cleanup against the exact production URL returned by deployment read-back.",
      capability: "product.primary_journey.verify",
      dependencies: ["production-deploy"],
      handler: "launch.verifyProduction",
      effect: "external_reversible",
      risk: "high",
      authorization: {
        required: true,
        profile: "standard_launch",
        scopes: ["product.primary_journey.verify"],
      },
      idempotencyKey: `launch:${brief.id}:verify-production`,
      retry: {
        maxAttempts: 1,
        retryableCodes: [],
        backoff: { strategy: "none", initialMs: 0, maxMs: 0, multiplier: 1 },
      },
      reconciliation: {
        handler: "launch.verifyProduction",
        pollIntervalMs: 0,
        maxPollAttempts: 3,
      },
      concurrencyGroup: "quality",
      evidence: { required: true, artifact: "reports/quality/post-deploy.json" },
      completion: {
        description:
          "The generic deployment surface passed separately; the exact product journey passed under one labeled test identity, produced run-bound evidence, and verified cleanup of every reversible test write without charging, publishing, configuring providers, deleting unrelated data, or sending outside the authorized test recipient.",
      },
    }),
    ...(brief.domain
      ? [
          workflowNode("verify-custom-domain", {
            purpose:
              "After same-run Vercel attachment and DNS propagation read-back, rerun the generic surface and exact Launch Contract journey against the exact custom-domain HTTPS origin; never fall back after this origin is selected.",
            capability: "product.primary_journey.verify",
            dependencies: [
              "production-deploy",
              "vercel-project",
              "dns-records",
              "verify-production",
            ],
            handler: "launch.verifyProduction",
            effect: "external_reversible",
            risk: "high",
            authorization: {
              required: true,
              profile: "standard_launch",
              scopes: ["product.primary_journey.verify"],
            },
            idempotencyKey: `launch:${brief.id}:verify-custom-domain`,
            retry: {
              maxAttempts: 1,
              retryableCodes: [],
              backoff: { strategy: "none", initialMs: 0, maxMs: 0, multiplier: 1 },
            },
            reconciliation: {
              handler: "launch.verifyProduction",
              pollIntervalMs: 0,
              maxPollAttempts: 3,
            },
            concurrencyGroup: "quality",
            evidence: { required: true, artifact: "reports/quality/custom-domain.json" },
            completion: {
              description:
                "The exact verified custom-domain origin passed the generic surface and immutable product journey, and every labeled test write was cleaned up with read-back.",
            },
          }),
        ]
      : []),
    ...(brief.domain && has("stripe")
      ? [
          providerNode(
            "stripe-domain-callbacks",
            "After the custom origin has same-run Vercel attachment, authoritative DNS, and product-journey verification, rebind Stripe callbacks to that exact verified HTTPS origin.",
            "stripe",
            ["dns-records", "stripe-callbacks", "vercel-project", "verify-custom-domain"],
            "api",
          ),
        ]
      : []),
    workflowNode("launch-report", {
      purpose: "Write sanitized human and JSON launch reports with only genuine remaining actions.",
      capability: "launch.report",
      dependencies: [...new Set(["verify-production", ...completionDependencies])].sort(),
      handler: "launch.report",
      idempotencyKey: `launch:${brief.id}:report`,
      concurrencyGroup: "report",
      evidence: { required: true, artifact: "reports/launch/final.json" },
    }),
  );

  const effectiveNodes =
    initialOrigin === "provider_url"
      ? nodes
          .filter((node) => !launchOptionalProviderNodeIds.has(node.id))
          .map((node) =>
            node.id === "vercel-project"
              ? {
                  ...node,
                  purpose:
                    "Create or link the explicitly scoped Vercel project, deploy preview, and read project and deployment state back without requesting a custom domain.",
                  authorization: {
                    ...node.authorization,
                    scopes: node.authorization.scopes.filter((scope) => scope !== "domain"),
                  },
                }
              : node,
          )
      : nodes;
  const budgets = Object.fromEntries(
    [...new Set(effectiveNodes.map((node) => node.budgetCategory))].map((category) => [
      category,
      0,
    ]),
  );
  return defineWorkflow({
    id: `launch-${brief.id}`,
    name: `Launch ${brief.name}`,
    version: "0.2.0",
    nodes: effectiveNodes,
    maxParallel: 4,
    // This is a scheduler safety bound, not a product-loop budget. A launch
    // graph can legitimately need several parallel batches plus resumptions.
    maxIterations: Math.max(50, effectiveNodes.length * 4),
    budgets,
    metadata: {
      synthetic: brief.synthetic ?? false,
      launchMode: decision.mode.selectedMode,
      appKind: decision.rail.appKind,
      paymentProvider: decision.payment.provider,
      initialOrigin,
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

export function compileLaunchDryRun(
  briefInput: FounderBrief,
  decisionInput?: LaunchDecision,
  options: LaunchCompilationOptions = {},
): LaunchDryRun {
  const brief = founderBriefSchema.parse(briefInput);
  const decision = decisionInput ?? routeLaunch(brief);
  if (decision.briefId !== brief.id) {
    throw new Error(`Launch decision for ${decision.briefId} cannot compile brief ${brief.id}`);
  }
  const graph = compileLaunchGraph(brief, decision, options);
  const activeProviders = new Set<string>(
    graph.nodes.flatMap((node) => {
      const provider = launchProviderByNode[node.id as keyof typeof launchProviderByNode];
      return provider ? [provider] : [];
    }),
  );
  const eventPacks = resolveActiveEventPacks({
    capabilities: decision.capabilities,
    appKind: decision.rail.appKind,
    monetizationModel: brief.monetization_model,
    leadJourney: ["lead_generation", "services"].includes(brief.monetization_model),
  });
  const resources: DryRunResource[] = [];
  for (const capability of decision.capabilities) {
    const mapped = capabilityProviders[capability];
    if (
      !mapped ||
      !activeProviders.has(mapped.provider) ||
      (graph.metadata?.initialOrigin === "provider_url" &&
        providerUrlDeferredCapabilities.has(capability)) ||
      capability === "vercel_analytics"
    ) {
      continue;
    }
    resources.push({
      provider: mapped.provider,
      resource: mapped.resource,
      environment:
        mapped.provider === "stripe"
          ? "test"
          : mapped.provider === "revenuecat"
            ? "test"
            : "preview",
      estimatedCost: mapped.provider === "eas" ? "unknown" : 0,
      directChargeBasis: mapped.provider === "eas" ? null : "reviewed_known_zero_direct_charge",
      ongoingAccountPlanUsageCovered: false,
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
