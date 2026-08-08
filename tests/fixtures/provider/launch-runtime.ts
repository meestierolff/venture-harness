import type { WorkflowDefinition } from "@/lib/workflow";
import type { ProviderId, ProviderPlanRequest } from "@/lib/providers";
import type { ProviderWorkflowPlanFactory } from "@/lib/runtime";
import { providerPlanFixtures } from "./requests";

interface SyntheticProviderTarget {
  provider: ProviderId;
  capabilities: readonly string[];
  environment?: ProviderPlanRequest["environment"];
}

const TARGET_BY_HANDLER: Readonly<Record<string, SyntheticProviderTarget>> = {
  "provider.github-repository": {
    provider: "github",
    capabilities: ["repository", "actions_secret", "repository_settings", "draft_pull_request"],
    environment: "preview",
  },
  "provider.neon-database": {
    provider: "neon",
    capabilities: [
      "project",
      "branch",
      "database",
      "role",
      "schema_migration",
      "read_write_health_check",
    ],
    environment: "preview",
  },
  "provider.brevo-sending-domain": {
    provider: "brevo",
    capabilities: ["sending_domain"],
    environment: "preview",
  },
  "provider.brevo-domain-verification": {
    provider: "brevo",
    capabilities: ["sending_domain_verification"],
    environment: "preview",
  },
  "provider.brevo-email": {
    provider: "brevo",
    capabilities: ["sender", "template", "webhook"],
    environment: "preview",
  },
  "provider.stripe-commerce": {
    provider: "stripe",
    capabilities: ["product", "price", "webhook", "billing_portal"],
    environment: "sandbox",
  },
  "provider.google-analytics-property": {
    provider: "google",
    capabilities: ["analytics_property"],
    environment: "preview",
  },
  "provider.google-analytics-stream": {
    provider: "google",
    capabilities: ["analytics_web_stream"],
    environment: "preview",
  },
  "provider.google-site-dns-record": {
    provider: "google",
    capabilities: ["site_verification_token"],
    environment: "preview",
  },
  "provider.google-site-verification": {
    provider: "google",
    capabilities: ["site_verification"],
    environment: "preview",
  },
  "provider.google-search-console": {
    provider: "google",
    capabilities: ["search_console_site", "search_console_sitemap"],
    environment: "preview",
  },
  "provider.bing-discovery": {
    provider: "bing",
    capabilities: ["site", "sitemap", "url_submission"],
    environment: "preview",
  },
  "provider.vercel-project": {
    provider: "vercel",
    capabilities: ["project", "environment_variable", "deployment", "domain"],
    environment: "preview",
  },
  "provider.revenuecat-entitlements": {
    provider: "revenuecat",
    capabilities: ["app", "entitlement", "offering", "webhook"],
    environment: "sandbox",
  },
  "provider.eas-build": {
    provider: "eas",
    capabilities: ["ios_build"],
    environment: "testflight",
  },
  "provider.eas-submit": {
    provider: "eas",
    capabilities: ["app_store_connection", "ios_submit"],
    environment: "testflight",
  },
  "provider.testflight-state": {
    provider: "app_store_connect",
    capabilities: ["build_processing", "testflight_group", "build_group_assignment"],
    environment: "testflight",
  },
  "provider.production-deploy": {
    provider: "vercel",
    capabilities: ["deployment"],
    environment: "production",
  },
};

export function syntheticProviderPlanFactories(
  definition: WorkflowDefinition,
): Readonly<Record<string, ProviderWorkflowPlanFactory>> {
  const handlers = definition.nodes
    .filter((node) => node.kind === "provider")
    .map((node) => node.handler)
    .filter((handler): handler is string => handler !== undefined);
  return Object.fromEntries(
    handlers.map((handler) => {
      const target = TARGET_BY_HANDLER[handler];
      if (!target) throw new Error(`Synthetic fixture has no provider target for ${handler}`);
      const base = providerPlanFixtures[target.provider];
      return [
        handler,
        async () => ({
          provider: target.provider,
          request: {
            ...base,
            environment: target.environment ?? base.environment,
            capabilities: target.capabilities,
            dryRun: false,
          },
        }),
      ];
    }),
  );
}

export function syntheticProviderIds(definition: WorkflowDefinition): ProviderId[] {
  return [
    ...new Set(
      definition.nodes
        .filter((node) => node.kind === "provider" && node.handler)
        .map((node) => TARGET_BY_HANDLER[node.handler!]?.provider)
        .filter((provider): provider is ProviderId => provider !== undefined),
    ),
  ];
}

export function syntheticProviderByNode(
  definition: WorkflowDefinition,
): Readonly<Record<string, ProviderId>> {
  return Object.fromEntries(
    definition.nodes
      .filter((node) => node.kind === "provider" && node.handler)
      .map((node) => [node.id, TARGET_BY_HANDLER[node.handler!]?.provider])
      .filter((entry): entry is [string, ProviderId] => entry[1] !== undefined),
  );
}
