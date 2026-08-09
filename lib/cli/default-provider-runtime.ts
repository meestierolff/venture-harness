import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { credentialReferenceSchema } from "../config/contracts";
import { mobileSchema, type MobileConfig } from "../config/mobile-schema";
import {
  providersSchema,
  type ProviderState,
  type ProvidersConfig,
} from "../config/provider-schema";
import { offerSchema } from "../config/schemas";
import { ventureSchema, type VentureV02 } from "../config/venture-schema";
import {
  inspectCliPrerequisites,
  type CliPrerequisite,
  type CliPrerequisiteResult,
  type CommandRunner,
  type CredentialBroker,
  type CredentialInspection,
  type CredentialKind,
} from "../credentials";
import type { FounderBrief } from "../launch";
import {
  providerRegistry,
  publicIdentifier,
  type ProviderExecutionContext,
  type ProviderId,
  type ProviderPlanRequest,
  type ProviderRegistry,
} from "../providers";
import {
  ProviderPlanFactoryPrerequisiteError,
  type ProviderLifecycleStore,
  type ProviderResourceReference,
  type ProviderWorkflowPlanFactory,
  type ProviderWorkflowPlanRequest,
  type ProviderResourceType,
  type VerifiedProviderLifecycleRecord,
} from "../runtime";
import type {
  WorkflowDefinition,
  WorkflowHandlerContext,
  WorkflowNodeDefinition,
} from "../workflow";

type OfferConfig = ReturnType<typeof offerSchema.parse>;

export interface DefaultProviderConfigSnapshot {
  providers: ProvidersConfig;
  venture: VentureV02;
  mobile: MobileConfig;
  offer: OfferConfig;
}

export interface DefaultProviderFactoryOptions {
  rootDir: string;
  brief: FounderBrief | (() => FounderBrief);
  definition: WorkflowDefinition;
  loadConfig?: () => DefaultProviderConfigSnapshot;
  lifecycleStore?: ProviderLifecycleStore;
}

export class ProviderFactoryPrerequisiteError extends ProviderPlanFactoryPrerequisiteError {
  constructor(
    readonly handler: string,
    message: string,
  ) {
    super(`${handler}: ${message}; no partial plan was returned and no provider request was made.`);
    this.name = "ProviderFactoryPrerequisiteError";
  }
}

interface ProviderHandlerTarget {
  provider: ProviderId;
  environment: ProviderPlanRequest["environment"];
}

export const DEFAULT_PROVIDER_TARGETS: Readonly<Record<string, ProviderHandlerTarget>> = {
  "provider.github-repository": { provider: "github", environment: "preview" },
  "provider.neon-database": { provider: "neon", environment: "preview" },
  "provider.brevo-sending-domain": { provider: "brevo", environment: "preview" },
  "provider.brevo-domain-verification": { provider: "brevo", environment: "preview" },
  "provider.brevo-email": { provider: "brevo", environment: "preview" },
  "provider.stripe-commerce": { provider: "stripe", environment: "sandbox" },
  "provider.google-analytics-property": { provider: "google", environment: "preview" },
  "provider.google-analytics-stream": { provider: "google", environment: "preview" },
  "provider.google-site-dns-record": { provider: "google", environment: "preview" },
  "provider.google-site-verification": { provider: "google", environment: "preview" },
  "provider.google-search-console": { provider: "google", environment: "preview" },
  "provider.bing-discovery": { provider: "bing", environment: "preview" },
  "provider.vercel-project": { provider: "vercel", environment: "preview" },
  "provider.vercel-database-environment": { provider: "vercel", environment: "preview" },
  "provider.vercel-stripe-environment": { provider: "vercel", environment: "preview" },
  "provider.vercel-stripe-webhook-environment": { provider: "vercel", environment: "preview" },
  "provider.vercel-brevo-environment": { provider: "vercel", environment: "preview" },
  "provider.vercel-ga-environment": { provider: "vercel", environment: "preview" },
  "provider.dns-records": { provider: "dns", environment: "production" },
  "provider.revenuecat-entitlements": { provider: "revenuecat", environment: "sandbox" },
  "provider.eas-build": { provider: "eas", environment: "testflight" },
  "provider.eas-submit": { provider: "eas", environment: "testflight" },
  "provider.testflight-state": {
    provider: "app_store_connect",
    environment: "testflight",
  },
  "provider.production-deploy": { provider: "vercel", environment: "production" },
};

const ADAPTER_CAPABILITIES: Partial<Record<ProviderId, Record<string, string[]>>> = {
  vercel: {
    public_website: ["project", "deployment", "domain"],
    vercel_analytics: ["web_analytics"],
  },
  neon: {
    database: ["project", "database", "schema_migration", "read_write_health_check"],
  },
  stripe: { stripe: ["product", "price", "webhook", "billing_portal"] },
  revenuecat: { revenuecat: ["app", "entitlement", "offering", "webhook"] },
  brevo: {
    transactional_email: ["sending_domain", "sending_domain_verification", "sender", "template"],
    lifecycle_email: ["sending_domain", "sending_domain_verification", "sender", "template"],
  },
  google: {
    ga4: ["analytics_property", "analytics_web_stream"],
    gsc: [
      "site_verification_token",
      "site_verification",
      "search_console_site",
      "search_console_sitemap",
    ],
  },
  bing: { bing_webmaster: ["site", "sitemap"] },
  dns: { public_website: ["record"] },
  mijndomein: { public_website: ["record", "domain_attachment"] },
  app_store_connect: {
    app_store_connect: [
      "first_app_record",
      "build_processing",
      "testflight_group",
      "build_group_assignment",
    ],
    ios_aso: ["build_metadata"],
  },
  eas: { eas: ["app_store_prerequisite", "app_store_connection", "ios_build", "ios_submit"] },
};

const CLI_IDS_BY_PROVIDER: Partial<Record<ProviderId, readonly string[]>> = {
  github: ["github"],
  vercel: ["vercel"],
  neon: ["neon", "postgres"],
  eas: ["eas"],
};

function readYaml(path: string): unknown {
  return parse(readFileSync(path, "utf8"));
}

export function loadDefaultProviderConfig(rootDir: string): DefaultProviderConfigSnapshot {
  const root = resolve(rootDir);
  const load = <T>(relativePath: string, parseConfig: (value: unknown) => T): T => {
    const path = resolve(root, relativePath);
    if (!existsSync(path)) {
      throw new ProviderPlanFactoryPrerequisiteError(
        `Missing ${relativePath}. Next: restore the v0.2 typed config or run vh upgrade before planning provider effects`,
      );
    }
    let value: unknown;
    try {
      value = readYaml(path);
    } catch {
      throw new ProviderPlanFactoryPrerequisiteError(
        `${relativePath} is not valid YAML. Next: repair it and run pnpm verify before planning provider effects`,
      );
    }
    try {
      return parseConfig(value);
    } catch {
      throw new ProviderPlanFactoryPrerequisiteError(
        `${relativePath} does not satisfy its v0.2 schema. Next: run pnpm verify, correct the reported fields, and rerun vh doctor`,
      );
    }
  };
  return {
    providers: load("config/providers.yaml", (value) => providersSchema.parse(value)),
    venture: load("config/venture.yaml", (value) => ventureSchema.parse(value)),
    mobile: load("config/mobile.yaml", (value) => mobileSchema.parse(value)),
    offer: load("config/offer.yaml", (value) => offerSchema.parse(value)),
  };
}

function currentBrief(value: FounderBrief | (() => FounderBrief)): FounderBrief {
  return typeof value === "function" ? value() : value;
}

function providerState(
  snapshot: DefaultProviderConfigSnapshot,
  provider: ProviderId,
): ProviderState {
  const state = snapshot.providers.providers[provider];
  if (!state) {
    throw new Error(`config/providers.yaml has no providers.${provider} entry`);
  }
  return state;
}

function fail(handler: string, message: string): never {
  throw new ProviderFactoryPrerequisiteError(handler, message);
}

function requireValue(
  handler: string,
  value: string | null | undefined,
  path: string,
  nextAction: string,
): string {
  if (!value) fail(handler, `missing ${path}. Next: ${nextAction}`);
  return value;
}

function requireExternal(
  handler: string,
  state: ProviderState,
  key: string,
  nextAction: string,
): string {
  return requireValue(
    handler,
    state.external_resource_ids[key],
    `config/providers.yaml providers.${DEFAULT_PROVIDER_TARGETS[handler]!.provider}.external_resource_ids.${key}`,
    nextAction,
  );
}

function requireCredential(
  handler: string,
  provider: ProviderId,
  value: string | null | undefined,
  path = `config/providers.yaml providers.${provider}.credential_ref`,
): string {
  const ref = requireValue(
    handler,
    value,
    path,
    `run vh auth login ${provider}, then record the registered cred:// reference in that field`,
  );
  return credentialReferenceSchema.parse(ref);
}

function requireVerifiedExisting(
  handler: string,
  provider: ProviderId,
  state: ProviderState,
  resource: string,
  lifecycleRecords: readonly VerifiedProviderLifecycleRecord[],
  requiredCapabilities: readonly string[],
  requiredResources: readonly ProviderResourceReference[],
): void {
  const verifiedCapabilities = new Set(lifecycleRecords.map(({ capability }) => capability));
  const scopedResourceRefs = lifecycleRecords
    .filter(({ capability }) => requiredCapabilities.includes(capability))
    .flatMap(({ resourceRefs }) => resourceRefs);
  if (
    state.state !== "verified" &&
    (!requiredCapabilities.every((capability) => verifiedCapabilities.has(capability)) ||
      !requiredResources.every(({ type, value }) =>
        scopedResourceRefs.some((reference) => resourceReferencesMatch(reference, { type, value })),
      ))
  ) {
    fail(
      handler,
      `providers.${provider}.state is ${state.state}, and no matching verified lifecycle record proves the existing ${resource}. Next: verify it with provider read-back in the same environment, set last_verified_at and evidence_artifact_ref, or inject a complete typed factory that can create and verify it`,
    );
  }
}

function resourceReferencesMatch(
  left: ProviderResourceReference,
  right: ProviderResourceReference,
): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "domain") return left.value.toLowerCase() === right.value.toLowerCase();
  if (left.type !== "site_url" && left.type !== "url") return left.value === right.value;
  try {
    return new URL(left.value).toString() === new URL(right.value).toString();
  } catch {
    return left.value === right.value;
  }
}

function lifecycleProvesExisting(
  lifecycleRecords: readonly VerifiedProviderLifecycleRecord[],
  capability: string,
  resource: ProviderResourceReference,
): boolean {
  return lifecycleRecords.some(
    (record) =>
      record.capability === capability &&
      record.resourceRefs.some((reference) => resourceReferencesMatch(reference, resource)),
  );
}

function lifecycleResourceValue(
  lifecycleRecords: readonly VerifiedProviderLifecycleRecord[],
  type: ProviderResourceType,
  capabilities: readonly string[],
): string | undefined {
  const acceptedCapabilities = new Set(capabilities);
  const values = new Set(
    lifecycleRecords
      .filter(({ capability }) => acceptedCapabilities.has(capability))
      .flatMap(({ resourceRefs }) => resourceRefs)
      .filter((reference) => reference.type === type)
      .map(({ value }) => value),
  );
  return values.size === 1 ? [...values][0] : undefined;
}

function withLifecycleResources(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
  lifecycleRecords: readonly VerifiedProviderLifecycleRecord[],
): DefaultProviderConfigSnapshot {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  const state = providerState(snapshot, target.provider);
  const reuse: Partial<Record<ProviderResourceType, readonly string[]>> =
    target.provider === "github"
      ? { repository: ["repository", "repository_settings"] }
      : target.provider === "vercel"
        ? { project: ["project"] }
        : target.provider === "neon"
          ? {
              project_id: ["project", "database"],
              branch_id: ["database"],
              database_name: ["database"],
            }
          : target.provider === "bing"
            ? { site_url: ["site"] }
            : {};
  const externalResourceIds = { ...state.external_resource_ids };
  for (const [type, capabilities] of Object.entries(reuse) as [
    ProviderResourceType,
    readonly string[],
  ][]) {
    if (externalResourceIds[type]) continue;
    const value = lifecycleResourceValue(lifecycleRecords, type, capabilities);
    if (value) externalResourceIds[type] = value;
  }
  if (Object.keys(externalResourceIds).length === Object.keys(state.external_resource_ids).length) {
    return snapshot;
  }
  return {
    ...snapshot,
    providers: {
      ...snapshot.providers,
      providers: {
        ...snapshot.providers.providers,
        [target.provider]: { ...state, external_resource_ids: externalResourceIds },
      },
    },
  };
}

function request(
  target: ProviderHandlerTarget,
  credentialRef: string | undefined,
  capabilities: readonly string[],
  inputs: ProviderPlanRequest["inputs"],
): ProviderWorkflowPlanRequest {
  return {
    provider: target.provider,
    request: {
      environment: target.environment,
      credentialRef,
      capabilities,
      inputs,
      dryRun: false,
    },
  };
}

function githubRequest(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
  lifecycleRecords: readonly VerifiedProviderLifecycleRecord[],
  rootDir: string,
): ProviderWorkflowPlanRequest {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  const state = providerState(snapshot, "github");
  const credentialRef = requireCredential(handler, "github", state.credential_ref);
  const repository = requireExternal(
    handler,
    state,
    "repository",
    "record the exact owner/name target; do not rely on the currently authenticated account",
  );
  const owner = requireValue(
    handler,
    state.team_id ?? state.account_id,
    "config/providers.yaml providers.github.team_id or account_id",
    "record the intended organization or account and confirm it matches the repository owner",
  );
  if (repository.split("/")[0] !== owner) {
    fail(
      handler,
      `repository owner ${repository.split("/")[0] ?? "(missing)"} does not match configured GitHub account/team ${owner}. Next: correct the target before any create or read-back`,
    );
  }
  const lifecycleCapability = ["repository_settings", "repository"].find((capability) =>
    lifecycleProvesExisting(lifecycleRecords, capability, {
      type: "repository",
      value: repository,
    }),
  );
  const intent =
    state.external_resource_ids.repository_intent ??
    (lifecycleCapability
      ? "use_verified"
      : requireExternal(
          handler,
          state,
          "repository_intent",
          "set create_from_source for a new repository or use_verified for a read-back-verified existing repository",
        ));
  if (intent === "create_from_source" || intent === "create_from_template") {
    return request(target, credentialRef, ["repository"], {
      repository,
      sourceDirectory: resolve(rootDir),
      visibility: snapshot.venture.venture.repository_visibility,
    });
  }
  if (intent === "use_verified") {
    requireVerifiedExisting(
      handler,
      "github",
      state,
      "repository",
      lifecycleRecords,
      [lifecycleCapability ?? "repository"],
      [{ type: "repository", value: repository }],
    );
    return request(target, credentialRef, ["repository_settings"], {
      repository,
      deleteBranchOnMerge: true,
    });
  }
  return fail(
    handler,
    `unsupported repository_intent ${intent}. Next: choose create_from_source or use_verified; create_from_template is accepted only as a deprecated compatibility alias that still publishes verified local source`,
  );
}

function vercelRequest(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
  lifecycleRecords: readonly VerifiedProviderLifecycleRecord[],
): ProviderWorkflowPlanRequest {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  const state = providerState(snapshot, "vercel");
  const credentialRef = requireCredential(handler, "vercel", state.credential_ref);
  const project = requireExternal(
    handler,
    state,
    "project",
    "record the exact Vercel project slug to create or reuse",
  );
  const scope = requireValue(
    handler,
    state.team_id ?? state.account_id,
    "config/providers.yaml providers.vercel.team_id or account_id",
    "record the exact Vercel team/account scope so the active CLI account is never inferred",
  );
  if (handler === "provider.production-deploy") {
    requireVerifiedExisting(
      handler,
      "vercel",
      state,
      "Vercel project",
      lifecycleRecords,
      ["project"],
      [{ type: "project", value: project }],
    );
    return request(target, credentialRef, ["deployment"], { project, scope });
  }
  const lifecycleProjectExists = lifecycleProvesExisting(lifecycleRecords, "project", {
    type: "project",
    value: project,
  });
  const projectIntent =
    state.external_resource_ids.project_intent ??
    (state.state === "verified" || lifecycleProjectExists
      ? "use_verified"
      : requireExternal(
          handler,
          state,
          "project_intent",
          "set create for a new Vercel project or use_verified for an existing project proven by provider read-back",
        ));
  if (projectIntent === "use_verified") {
    requireVerifiedExisting(
      handler,
      "vercel",
      state,
      "Vercel project",
      lifecycleRecords,
      ["project"],
      [{ type: "project", value: project }],
    );
  } else if (projectIntent === "create") {
    if (state.state === "verified" || lifecycleProjectExists) {
      fail(
        handler,
        `project_intent create conflicts with verified Vercel project ${project}. Next: set project_intent to use_verified or choose a new explicit project slug`,
      );
    }
  } else {
    fail(
      handler,
      `unsupported project_intent ${projectIntent}. Next: choose create or use_verified`,
    );
  }
  // GA4 is the founder-default rail's required analytics path. Vercel Web
  // Analytics remains an optional, separately reviewed dashboard action, so it
  // must never be mixed into this automatic apply-once project/deploy request.
  return request(
    target,
    credentialRef,
    ["project", "deployment", ...(snapshot.venture.venture.domain ? ["domain"] : [])],
    {
      project,
      scope,
      projectIntent,
      ...(snapshot.venture.venture.domain ? { domain: snapshot.venture.venture.domain } : {}),
    },
  );
}

function vercelEnvironmentRequest(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
): ProviderWorkflowPlanRequest {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  const state = providerState(snapshot, "vercel");
  const credentialRef = requireCredential(handler, "vercel", state.credential_ref);
  const project = requireExternal(
    handler,
    state,
    "project",
    "record the exact Vercel project slug to configure",
  );
  const scope = requireValue(
    handler,
    state.team_id ?? state.account_id,
    "config/providers.yaml providers.vercel.team_id or account_id",
    "record the exact Vercel team/account scope",
  );
  const binding: Readonly<Record<string, { name: string; provider: ProviderId; path: string }>> = {
    "provider.vercel-database-environment": {
      name: "DATABASE_URL",
      provider: "neon",
      path: "database_credential_ref",
    },
    "provider.vercel-stripe-environment": {
      name: "STRIPE_SECRET_KEY",
      provider: "stripe",
      path: "credential_ref",
    },
    "provider.vercel-stripe-webhook-environment": {
      name: "STRIPE_WEBHOOK_SECRET",
      provider: "stripe",
      path: "webhook_secret_credential_ref",
    },
    "provider.vercel-brevo-environment": {
      name: "BREVO_API_KEY",
      provider: "brevo",
      path: "credential_ref",
    },
    "provider.vercel-ga-environment": {
      name: "NEXT_PUBLIC_GA_MEASUREMENT_ID",
      provider: "google",
      path: "measurement_id_credential_ref",
    },
  };
  const selected = binding[handler];
  if (!selected) fail(handler, "unknown Vercel environment binding");
  const source = providerState(snapshot, selected.provider);
  const valueRef =
    selected.path === "credential_ref"
      ? source.credential_ref
      : source.external_resource_ids[selected.path];
  const environmentValueCredentialRef = requireCredential(
    handler,
    selected.provider,
    valueRef,
    `config/providers.yaml providers.${selected.provider}.${
      selected.path === "credential_ref"
        ? "credential_ref"
        : `external_resource_ids.${selected.path}`
    }`,
  );
  return request(target, credentialRef, ["environment_variable"], {
    project,
    scope,
    environmentVariableName: selected.name,
    environmentTarget: "production",
    environmentValueCredentialRef,
  });
}

function neonRequest(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
  lifecycleRecords: readonly VerifiedProviderLifecycleRecord[],
  rootDir: string,
): ProviderWorkflowPlanRequest {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  const state = providerState(snapshot, "neon");
  const credentialRef = requireCredential(handler, "neon", state.credential_ref);
  const projectIntent = state.external_resource_ids.project_intent ?? "use_verified";
  if (projectIntent === "create") {
    const organizationId = requireExternal(
      handler,
      state,
      "organization_id",
      "record the exact Neon organization id from the Founder Stack; do not fall back to the credential account",
    );
    const projectName =
      state.external_resource_ids.project_name ??
      requireValue(
        handler,
        snapshot.venture.venture.name,
        "config/venture.yaml venture.name",
        "record the exact Neon project name",
      );
    const regionId = requireValue(
      handler,
      state.region,
      "config/providers.yaml providers.neon.region",
      "record the exact Neon region id after checking availability and data-location requirements",
    );
    const databaseCredentialRef = requireCredential(
      handler,
      "neon",
      state.external_resource_ids.database_credential_ref,
      "config/providers.yaml providers.neon.external_resource_ids.database_credential_ref",
    );
    return request(
      target,
      credentialRef,
      ["project", "schema_migration", "read_write_health_check"],
      {
        organizationId,
        projectName,
        regionId,
        databaseCredentialRef,
        workingDirectory: resolve(rootDir),
      },
    );
  }
  if (projectIntent !== "use_verified") {
    fail(
      handler,
      `unsupported project_intent ${projectIntent}. Next: choose create or use_verified`,
    );
  }
  const projectId = requireExternal(
    handler,
    state,
    "project_id",
    "record the project id returned by Neon read-back",
  );
  const branchId = requireExternal(
    handler,
    state,
    "branch_id",
    "record the branch id returned by Neon read-back",
  );
  const databaseName = requireExternal(
    handler,
    state,
    "database_name",
    "record the database name returned by Neon read-back",
  );
  requireVerifiedExisting(
    handler,
    "neon",
    state,
    "Neon project, branch, and database",
    lifecycleRecords,
    ["project", "database"],
    [
      { type: "project_id", value: projectId },
      { type: "branch_id", value: branchId },
      { type: "database_name", value: databaseName },
    ],
  );
  const databaseCredentialRef = requireCredential(
    handler,
    "neon",
    state.external_resource_ids.database_credential_ref,
    "config/providers.yaml providers.neon.external_resource_ids.database_credential_ref",
  );
  return request(target, credentialRef, ["schema_migration", "read_write_health_check"], {
    projectId,
    branchId,
    databaseName,
    databaseCredentialRef,
    workingDirectory: resolve(rootDir),
  });
}

function exactMinorUnits(handler: string, amount: number, path: string): number {
  const minorUnits = amount * 100;
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    fail(
      handler,
      `${path} must be a non-negative amount with no more than two decimal places. Next: correct the approved offer price before creating an immutable Stripe price`,
    );
  }
  return minorUnits;
}

function stripeRequest(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
): ProviderWorkflowPlanRequest {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  const state = providerState(snapshot, "stripe");
  const credentialRef = requireCredential(handler, "stripe", state.credential_ref);
  const mode = requireExternal(
    handler,
    state,
    "mode",
    "set mode to test after registering a restricted Stripe test-mode credential",
  );
  if (mode !== "test") {
    fail(
      handler,
      `Stripe mode is ${mode}. Next: use an explicitly registered test-mode credential and set providers.stripe.external_resource_ids.mode to test; the default launch node never creates live prices`,
    );
  }
  const configuredPrices = [
    snapshot.offer.pricing.monthly_price === null
      ? null
      : {
          amount: snapshot.offer.pricing.monthly_price,
          interval: "month",
          path: "config/offer.yaml pricing.monthly_price",
        },
    snapshot.offer.pricing.annual_price === null
      ? null
      : {
          amount: snapshot.offer.pricing.annual_price,
          interval: "year",
          path: "config/offer.yaml pricing.annual_price",
        },
  ].filter((value): value is { amount: number; interval: string; path: string } => value !== null);
  if (configuredPrices.length !== 1) {
    fail(
      handler,
      configuredPrices.length === 0
        ? "no approved monthly or annual price exists in config/offer.yaml. Next: record the exact displayed price before planning Stripe"
        : "both monthly and annual prices are active, but the built-in node cannot yet prove two immutable Stripe price resources without omitting one. Next: select one launch price or inject a multi-price factory",
    );
  }
  const [configuredPrice] = configuredPrices;
  const domain = requireValue(
    handler,
    snapshot.venture.venture.domain,
    "config/venture.yaml venture.domain",
    "record the exact callback domain before creating the Stripe webhook",
  );
  const productName = requireValue(
    handler,
    snapshot.venture.venture.name,
    "config/venture.yaml venture.name",
    "record the exact product name",
  );
  const webhookSecretCredentialRef = requireCredential(
    handler,
    "stripe",
    state.external_resource_ids.webhook_secret_credential_ref,
    "config/providers.yaml providers.stripe.external_resource_ids.webhook_secret_credential_ref",
  );
  return request(target, credentialRef, ["product", "price", "webhook", "billing_portal"], {
    productName,
    ...(snapshot.offer.offer.sentence ? { productDescription: snapshot.offer.offer.sentence } : {}),
    productId: "{dependency.product.id}",
    currency: snapshot.offer.pricing.currency.toLowerCase(),
    unitAmount: exactMinorUnits(handler, configuredPrice.amount, configuredPrice.path),
    recurringInterval: configuredPrice.interval,
    webhookUrl: `https://${domain}/api/stripe/webhook`,
    webhookSecretCredentialRef,
    enabledEvents: [
      "checkout.session.completed",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.payment_failed",
    ],
    headline: `Manage ${productName}`,
  });
}

function brevoRequest(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
  workflow: WorkflowHandlerContext,
): ProviderWorkflowPlanRequest {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  const state = providerState(snapshot, "brevo");
  const credentialRef = requireCredential(handler, "brevo", state.credential_ref);
  const senderName = requireExternal(
    handler,
    state,
    "sender_name",
    "record the reviewed sender display name",
  );
  const senderEmail = requireExternal(
    handler,
    state,
    "sender_email",
    "record the reviewed sender address on the verified domain",
  );
  const senderDomain = senderEmail.slice(senderEmail.lastIndexOf("@") + 1);
  if (!senderEmail.includes("@") || !senderDomain) {
    fail(handler, "sender_email is not an address on a reviewable sending domain");
  }
  if (handler === "provider.brevo-sending-domain") {
    return request(target, credentialRef, ["sending_domain"], { domainName: senderDomain });
  }
  if (handler === "provider.brevo-domain-verification") {
    const dns = workflow.dependencyOutputs["dns-records"];
    const records =
      dns && !Array.isArray(dns) && typeof dns === "object" && Array.isArray(dns.records)
        ? dns.records
        : [];
    if (
      !records.some(
        (record) =>
          record &&
          !Array.isArray(record) &&
          typeof record === "object" &&
          record.source_provider === "brevo",
      )
    ) {
      fail(
        handler,
        "the same-run DNS evidence does not contain the ordered Brevo records. Next: complete the consolidated DNS node with its exact typed output",
      );
    }
    return request(target, credentialRef, ["sending_domain_verification"], {
      domainName: senderDomain,
    });
  }
  const templateName = requireExternal(
    handler,
    state,
    "template_name",
    "record the reviewed inactive template name",
  );
  const templateSubject = requireExternal(
    handler,
    state,
    "template_subject",
    "record the reviewed template subject",
  );
  const templateHtml = requireExternal(
    handler,
    state,
    "template_html",
    "record reviewed HTML or inject a factory that reads a repository template artifact",
  );
  const webhookUrl = state.external_resource_ids.webhook_url;
  const webhookEvents = state.external_resource_ids.webhook_events
    ?.split(",")
    .map((event) => event.trim())
    .filter(Boolean);
  return request(
    target,
    credentialRef,
    ["sender", "template", ...(webhookUrl ? ["webhook"] : [])],
    {
      senderName,
      senderEmail,
      templateName,
      templateSubject,
      templateHtml,
      ...(webhookUrl
        ? {
            webhookUrl,
            webhookEvents:
              webhookEvents && webhookEvents.length > 0
                ? webhookEvents
                : ["delivered", "hardBounce", "spam"],
          }
        : {}),
    },
  );
}

function dependencyIdentifier(
  handler: string,
  workflow: WorkflowHandlerContext,
  dependency: string,
  type: Parameters<typeof publicIdentifier>[1],
): string {
  return requireValue(
    handler,
    publicIdentifier(workflow.dependencyOutputs[dependency], type),
    `${dependency}.output.publicOutputs.identifiers.${type}`,
    `resume the same run after ${dependency} has provider read-back evidence with one exact ${type}`,
  );
}

function googleRequest(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
  workflow: WorkflowHandlerContext,
): ProviderWorkflowPlanRequest {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  const state = providerState(snapshot, "google");
  const credentialRef = requireCredential(handler, "google", state.credential_ref);
  const domain = requireValue(
    handler,
    snapshot.venture.venture.domain,
    "config/venture.yaml venture.domain",
    "record the exact production domain before Google setup",
  );
  const siteUrl = state.external_resource_ids.site_url ?? `sc-domain:${domain}`;
  const sitemapUrl = state.external_resource_ids.sitemap_url ?? `https://${domain}/sitemap.xml`;
  switch (handler) {
    case "provider.google-analytics-property": {
      const analyticsAccountId = requireExternal(
        handler,
        state,
        "analytics_account_id",
        "record the exact GA4 account id returned by account lookup",
      );
      const propertyDisplayName =
        state.external_resource_ids.property_display_name ??
        requireValue(
          handler,
          snapshot.venture.venture.name,
          "config/venture.yaml venture.name",
          "record a reviewed GA4 property name",
        );
      return request(target, credentialRef, ["analytics_property"], {
        analyticsAccountId,
        propertyDisplayName,
        reportingTimeZone: snapshot.venture.venture.timezone,
        currencyCode: snapshot.venture.venture.currency,
      });
    }
    case "provider.google-analytics-stream":
      return request(target, credentialRef, ["analytics_web_stream"], {
        analyticsPropertyId: dependencyIdentifier(
          handler,
          workflow,
          "google-analytics-property",
          "property_id",
        ),
        streamDisplayName: state.external_resource_ids.stream_display_name ?? `${domain} web`,
        defaultUri: `https://${domain}/`,
        measurementIdCredentialRef: requireCredential(
          handler,
          "google",
          state.external_resource_ids.measurement_id_credential_ref,
          "config/providers.yaml providers.google.external_resource_ids.measurement_id_credential_ref",
        ),
      });
    case "provider.google-site-dns-record":
      return request(target, credentialRef, ["site_verification_token"], {
        siteIdentifier: domain,
        siteType: "INET_DOMAIN",
        verificationMethod: "DNS_TXT",
        dnsTtl: 3_600,
      });
    case "provider.google-site-verification": {
      const dns = workflow.dependencyOutputs["dns-records"];
      const records =
        dns && !Array.isArray(dns) && typeof dns === "object" && Array.isArray(dns.records)
          ? dns.records
          : [];
      if (
        !records.some(
          (record) =>
            record &&
            !Array.isArray(record) &&
            typeof record === "object" &&
            record.source_provider === "google",
        )
      ) {
        fail(
          handler,
          "the same-run DNS evidence does not contain the Google token record. Next: complete the consolidated DNS node with its exact typed output",
        );
      }
      return request(target, credentialRef, ["site_verification"], {
        siteIdentifier: domain,
        siteType: "INET_DOMAIN",
        verificationMethod: "DNS_TXT",
      });
    }
    case "provider.google-search-console":
      return request(target, credentialRef, ["search_console_site", "search_console_sitemap"], {
        siteUrl,
        sitemapUrl,
      });
    default:
      return fail(handler, "unknown staged Google handler");
  }
}

function bingRequest(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
  lifecycleRecords: readonly VerifiedProviderLifecycleRecord[],
): ProviderWorkflowPlanRequest {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  const state = providerState(snapshot, "bing");
  const credentialRef = requireCredential(handler, "bing", state.credential_ref);
  const domain = requireValue(
    handler,
    snapshot.venture.venture.domain,
    "config/venture.yaml venture.domain",
    "record the exact verified production domain",
  );
  const authMode = requireExternal(
    handler,
    state,
    "auth_mode",
    "set api_key or oauth to match the registered credential kind",
  );
  if (authMode !== "api_key" && authMode !== "oauth") {
    fail(handler, `unsupported Bing auth_mode ${authMode}. Next: choose api_key or oauth`);
  }
  const siteUrl = state.external_resource_ids.site_url ?? `https://${domain}`;
  const sitemapUrl = state.external_resource_ids.sitemap_url ?? `https://${domain}/sitemap.xml`;
  const siteAlreadyVerified = lifecycleProvesExisting(lifecycleRecords, "site", {
    type: "site_url",
    value: siteUrl,
  });
  const siteIntent =
    state.external_resource_ids.site_intent ??
    (state.state === "verified" || siteAlreadyVerified ? "use_verified" : "create");
  if (siteIntent === "use_verified") {
    requireVerifiedExisting(
      handler,
      "bing",
      state,
      "owned Bing site",
      lifecycleRecords,
      ["site"],
      [{ type: "site_url", value: siteUrl }],
    );
    return request(target, credentialRef, ["sitemap"], { authMode, siteUrl, sitemapUrl });
  }
  if (siteIntent !== "create") {
    fail(
      handler,
      `unsupported Bing site_intent ${siteIntent}. Next: choose create or use_verified`,
    );
  }
  return request(target, credentialRef, ["site", "sitemap"], {
    authMode,
    siteUrl,
    sitemapUrl,
  });
}

function easRequest(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
  workflow: WorkflowHandlerContext,
  rootDir: string,
): ProviderWorkflowPlanRequest {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  const state = providerState(snapshot, "eas");
  const projectId = requireValue(
    handler,
    snapshot.mobile.mobile.eas.project_id,
    "config/mobile.yaml mobile.eas.project_id",
    "run the reviewed EAS project-link step and record its read-back id",
  );
  const credentialRef = requireCredential(
    handler,
    "eas",
    snapshot.mobile.mobile.eas.credential_ref ?? state.credential_ref,
    "config/mobile.yaml mobile.eas.credential_ref or config/providers.yaml providers.eas.credential_ref",
  );
  const buildProfile = snapshot.mobile.mobile.eas.build_profiles.includes("production")
    ? "production"
    : fail(
        handler,
        "config/mobile.yaml mobile.eas.build_profiles does not contain production. Next: add a reviewed production build profile",
      );
  const projectDirectory = resolve(rootDir, "mobile/expo");
  if (handler === "provider.eas-build") {
    return request(target, credentialRef, ["ios_build"], {
      projectId,
      buildProfile,
      projectDirectory,
    });
  }
  const apple = workflow.dependencyOutputs["apple-first-app-record"];
  if (!apple || Array.isArray(apple) || typeof apple !== "object") {
    fail(handler, "the same-run first App Store Connect record output is missing");
  }
  const appStoreAppId = requireValue(
    handler,
    typeof apple.apple_app_id === "string" ? apple.apple_app_id : undefined,
    "apple-first-app-record.output.apple_app_id",
    "complete the explicit Apple record manual node",
  );
  const bundleId = requireValue(
    handler,
    typeof apple.bundle_identifier === "string" ? apple.bundle_identifier : undefined,
    "apple-first-app-record.output.bundle_identifier",
    "complete the explicit Apple record manual node",
  );
  if (
    snapshot.mobile.mobile.bundle_identifier &&
    snapshot.mobile.mobile.bundle_identifier !== bundleId
  ) {
    fail(
      handler,
      `Apple bundle identifier ${bundleId} does not match config/mobile.yaml ${snapshot.mobile.mobile.bundle_identifier}. Next: correct the mismatch before submission`,
    );
  }
  const easBuildId = dependencyIdentifier(handler, workflow, "eas-build", "build_id");
  return request(target, credentialRef, ["app_store_connection", "ios_submit"], {
    projectId,
    projectDirectory,
    appStoreAppId,
    bundleId,
    easBuildId,
    submitProfile: "production",
  });
}

function testflightRequest(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
  workflow: WorkflowHandlerContext,
): ProviderWorkflowPlanRequest {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  const state = providerState(snapshot, "app_store_connect");
  const credentialRef = requireCredential(
    handler,
    "app_store_connect",
    snapshot.mobile.mobile.app_store_connect.credential_ref ?? state.credential_ref,
    "config/mobile.yaml mobile.app_store_connect.credential_ref or config/providers.yaml providers.app_store_connect.credential_ref",
  );
  const apple = workflow.dependencyOutputs["apple-first-app-record"];
  if (!apple || Array.isArray(apple) || typeof apple !== "object") {
    fail(handler, "the same-run first App Store Connect record output is missing");
  }
  const appStoreAppId = requireValue(
    handler,
    typeof apple.apple_app_id === "string" ? apple.apple_app_id : undefined,
    "apple-first-app-record.output.apple_app_id",
    "complete the explicit Apple record manual node",
  );
  const appVersion = dependencyIdentifier(handler, workflow, "eas-build", "app_version");
  const buildNumber = dependencyIdentifier(handler, workflow, "eas-build", "build_number");
  const betaGroupName =
    state.external_resource_ids.beta_group_name ??
    `${requireValue(handler, snapshot.venture.venture.name, "config/venture.yaml venture.name", "record the venture name")} Internal`;
  return request(
    target,
    credentialRef,
    ["build_processing", "testflight_group", "build_group_assignment"],
    {
      appStoreAppId,
      appVersion,
      buildNumber,
      betaGroupName,
      isInternalGroup: true,
      appStoreBuildId: "{dependency.build_processing.data.0.id}",
      betaGroupId: "{dependency.testflight_group.data.id}",
    },
  );
}

function unsupportedRequest(handler: string, snapshot: DefaultProviderConfigSnapshot): never {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  // Load every typed config snapshot before deciding. This keeps later config
  // changes visible while ensuring a broad-but-partial factory never slips in.
  void snapshot.offer;
  void snapshot.mobile;
  void providerState(snapshot, target.provider);
  const reasons: Readonly<Record<string, string>> = {
    "provider.stripe-commerce":
      "the adapter cannot feed a newly read-back Stripe product id into exact-price, portal, checkout, and webhook operations in one node. Next: complete config/offer.yaml pricing and inject a staged typed factory that verifies each test-mode resource",
    "provider.dns-records":
      "the complete additive record set is produced by upstream provider read-back and cannot be inferred from a single configured value. Next: use the compiled manual DNS node or inject a record-set factory that preserves mail records and verifies authoritative DNS",
    "provider.revenuecat-entitlements":
      "the adapter does not yet compose Test Store products and packages with app, entitlement, offering, and webhook read-back. Next: finish the manual RevenueCat project/key prerequisite and inject a complete staged factory",
  };
  return fail(
    handler,
    reasons[handler] ??
      `no complete built-in composition is registered for ${target.provider}. Next: inject a typed factory with apply and read-back coverage`,
  );
}

function buildDefaultRequest(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
  lifecycleRecords: readonly VerifiedProviderLifecycleRecord[],
  workflow: WorkflowHandlerContext,
  rootDir: string,
): ProviderWorkflowPlanRequest {
  switch (handler) {
    case "provider.github-repository":
      return githubRequest(handler, snapshot, lifecycleRecords, rootDir);
    case "provider.vercel-project":
    case "provider.production-deploy":
      return vercelRequest(handler, snapshot, lifecycleRecords);
    case "provider.vercel-database-environment":
    case "provider.vercel-stripe-environment":
    case "provider.vercel-stripe-webhook-environment":
    case "provider.vercel-brevo-environment":
    case "provider.vercel-ga-environment":
      return vercelEnvironmentRequest(handler, snapshot);
    case "provider.neon-database":
      return neonRequest(handler, snapshot, lifecycleRecords, rootDir);
    case "provider.stripe-commerce":
      return stripeRequest(handler, snapshot);
    case "provider.brevo-sending-domain":
    case "provider.brevo-domain-verification":
    case "provider.brevo-email":
      return brevoRequest(handler, snapshot, workflow);
    case "provider.google-analytics-property":
    case "provider.google-analytics-stream":
    case "provider.google-site-dns-record":
    case "provider.google-site-verification":
    case "provider.google-search-console":
      return googleRequest(handler, snapshot, workflow);
    case "provider.bing-discovery":
      return bingRequest(handler, snapshot, lifecycleRecords);
    case "provider.eas-build":
    case "provider.eas-submit":
      return easRequest(handler, snapshot, workflow, rootDir);
    case "provider.testflight-state":
      return testflightRequest(handler, snapshot, workflow);
    default:
      return unsupportedRequest(handler, snapshot);
  }
}

export function createDefaultProviderPlanFactories(
  options: DefaultProviderFactoryOptions,
): Readonly<Record<string, ProviderWorkflowPlanFactory>> {
  const handlers = options.definition.nodes
    .filter((node) => node.kind === "provider" && node.handler)
    .map((node) => node.handler!);
  return Object.fromEntries(
    handlers.map((handler) => {
      if (!DEFAULT_PROVIDER_TARGETS[handler]) {
        throw new ProviderFactoryPrerequisiteError(
          handler,
          "the launch graph contains an unknown provider handler. Next: register an explicit typed target",
        );
      }
      const factory: ProviderWorkflowPlanFactory = async (workflow) => {
        if (workflow.node.handler !== handler) {
          fail(
            handler,
            `factory was invoked for ${workflow.node.handler ?? workflow.node.id}. Next: fix the runtime handler map`,
          );
        }
        const brief = currentBrief(options.brief);
        if (brief.id !== options.definition.id.replace(/^launch-/, "")) {
          fail(
            handler,
            `founder brief ${brief.id} does not match graph ${options.definition.id}. Next: recreate the launch plan from the current brief`,
          );
        }
        const snapshot = (
          options.loadConfig ?? (() => loadDefaultProviderConfig(options.rootDir))
        )();
        let lifecycleRecords: VerifiedProviderLifecycleRecord[] = [];
        if (options.lifecycleStore) {
          try {
            lifecycleRecords = (await options.lifecycleStore.list()).filter(
              ({ provider, environment, capability }) => {
                const target = DEFAULT_PROVIDER_TARGETS[handler]!;
                if (provider !== target.provider) return false;
                if (environment === target.environment) return true;
                return (
                  handler === "provider.production-deploy" &&
                  provider === "vercel" &&
                  target.environment === "production" &&
                  environment === "preview" &&
                  capability === "project"
                );
              },
            );
          } catch {
            fail(
              handler,
              "verified provider lifecycle state is corrupt or unreadable. Next: restore it from trusted read-back evidence before planning or applying provider effects",
            );
          }
        }
        return buildDefaultRequest(
          handler,
          withLifecycleResources(handler, snapshot, lifecycleRecords),
          lifecycleRecords,
          workflow,
          options.rootDir,
        );
      };
      return [handler, factory];
    }),
  );
}

function adapterCapabilities(provider: ProviderId, ventureCapabilities: string[]): string[] {
  const mapping = ADAPTER_CAPABILITIES[provider] ?? {};
  return [...new Set(ventureCapabilities.flatMap((capability) => mapping[capability] ?? []))];
}

function compatibleKinds(
  provider: ProviderId,
  capabilities: readonly string[],
  registry: ProviderRegistry,
) {
  const descriptor = registry.get(provider).descriptor;
  const specific = (descriptor.credentialRequirements ?? [])
    .filter((requirement) =>
      requirement.capabilities.some((capability) => capabilities.includes(capability)),
    )
    .flatMap((requirement) => requirement.acceptedKinds);
  return [
    ...new Set<CredentialKind>(
      specific.length > 0
        ? specific
        : descriptor.authMethods.filter(
            (method): method is CredentialKind => method !== "manual" && method !== "none",
          ),
    ),
  ];
}

function missingKinds(
  provider: ProviderId,
  capabilities: readonly string[],
  inspections: readonly CredentialInspection[],
  registry: ProviderRegistry,
): CredentialKind[] {
  const descriptor = registry.get(provider).descriptor;
  const requirements = (descriptor.credentialRequirements ?? []).filter((requirement) =>
    requirement.capabilities.some((capability) => capabilities.includes(capability)),
  );
  if (requirements.length === 0) {
    const accepted = compatibleKinds(provider, capabilities, registry);
    return accepted.some((kind) => inspections.some((inspection) => inspection.kind === kind))
      ? []
      : accepted;
  }
  return [
    ...new Set(
      requirements.flatMap((requirement) =>
        requirement.acceptedKinds.some((kind) =>
          inspections.some((inspection) => inspection.kind === kind),
        )
          ? []
          : requirement.acceptedKinds,
      ),
    ),
  ];
}

function authenticated(inspection: CredentialInspection): boolean {
  return (
    inspection.status === "available" &&
    ((inspection.kind === "cli_session" && inspection.backend === "cli_session") ||
      (inspection.testStatus === "passed" && inspection.testedAt !== undefined))
  );
}

function dummyHandlerContext(node: WorkflowNodeDefinition): WorkflowHandlerContext {
  return {
    runId: "doctor-plan-only",
    node,
    attempt: 1,
    dependencyOutputs: {},
    idempotencyKey: `doctor:${node.id}`,
    signal: new AbortController().signal,
    trace: () => undefined,
  };
}

export interface DefaultProviderDoctorOptions {
  rootDir: string;
  broker: CredentialBroker;
  context: ProviderExecutionContext;
  runner: CommandRunner;
  lifecycleStore?: ProviderLifecycleStore;
  registry?: ProviderRegistry;
  prerequisites?: readonly CliPrerequisite[];
  launch?: {
    brief: FounderBrief;
    definition: WorkflowDefinition;
    factories?: Readonly<Record<string, ProviderWorkflowPlanFactory>>;
  };
}

interface PlanAvailability {
  available: boolean;
  status: "available" | "blocked" | "not_required" | "brief_required" | "manual_only";
  blockers: string[];
  requirement: string | null;
}

function planAvailability(
  available: boolean,
  status: PlanAvailability["status"],
  blockers: string[] = [],
  requirement: string | null = null,
): PlanAvailability {
  return { available, status, blockers, requirement };
}

async function inspectCredentialRefs(broker: CredentialBroker): Promise<CredentialInspection[]> {
  return Promise.all(
    broker.list().map(async (reference) => {
      try {
        return await broker.inspect(reference.ref);
      } catch (error) {
        return {
          ...reference,
          status: "unavailable" as const,
          writable: false,
          message: broker.redactor.redactText(
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    }),
  );
}

function cliChecksForProvider(
  provider: ProviderId,
  results: readonly CliPrerequisiteResult[],
): CliPrerequisiteResult[] {
  const ids = new Set(CLI_IDS_BY_PROVIDER[provider] ?? []);
  return results.filter(({ id }) => ids.has(id));
}

async function inspectProviderPlan(
  provider: ProviderId,
  registry: ProviderRegistry,
  launch: DefaultProviderDoctorOptions["launch"],
): Promise<{ availability: PlanAvailability; handlers: string[] }> {
  if (!launch) {
    return {
      handlers: [],
      availability: planAvailability(false, "brief_required", [
        "No founder brief is selected. Next: run vh create --brief <file>.",
      ]),
    };
  }
  const nodes = launch.definition.nodes.filter(
    (node) =>
      node.kind === "provider" &&
      node.handler &&
      DEFAULT_PROVIDER_TARGETS[node.handler]?.provider === provider,
  );
  if (nodes.length === 0) {
    return { handlers: [], availability: planAvailability(false, "not_required") };
  }
  const factories =
    launch.factories ??
    createDefaultProviderPlanFactories({
      rootDir: "",
      brief: launch.brief,
      definition: launch.definition,
      loadConfig: () => {
        throw new Error("doctor factory config loader was not initialized");
      },
    });
  const blockers: string[] = [];
  for (const node of nodes) {
    const factory = factories[node.handler!];
    if (!factory) {
      blockers.push(`${node.handler}: no provider plan factory is registered`);
      continue;
    }
    try {
      const target = await factory(dummyHandlerContext(node));
      if (target.provider !== provider) {
        blockers.push(`${node.handler}: resolved ${target.provider}, expected ${provider}`);
        continue;
      }
      const plan = (target.adapter ?? registry.get(provider)).plan({
        ...target.request,
        dryRun: true,
      });
      if (plan.operations.length === 0) {
        blockers.push(`${node.handler}: the dry-run plan contains no complete operation`);
      }
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    handlers: nodes.map((node) => node.handler!),
    availability:
      blockers.length === 0
        ? planAvailability(true, "available")
        : planAvailability(false, "blocked", blockers),
  };
}

export async function inspectDefaultProviderDoctor(options: DefaultProviderDoctorOptions) {
  const registry = options.registry ?? providerRegistry;
  const snapshot = loadDefaultProviderConfig(options.rootDir);
  const cliPrerequisites = await inspectCliPrerequisites(options.runner, {
    prerequisites: options.prerequisites,
    redactor: options.context.redactor,
  });
  const inspections = await inspectCredentialRefs(options.broker);
  const launch = options.launch
    ? {
        ...options.launch,
        factories:
          options.launch.factories ??
          createDefaultProviderPlanFactories({
            rootDir: options.rootDir,
            brief: options.launch.brief,
            definition: options.launch.definition,
            lifecycleStore: options.lifecycleStore,
          }),
      }
    : undefined;
  const providerChecks = await Promise.all(
    registry.list().map(async (adapter) => {
      const provider = adapter.descriptor.id;
      const configured = snapshot.providers.providers[provider];
      const requestedCapabilities = adapterCapabilities(provider, configured?.capability_ids ?? []);
      const refs = inspections.filter((inspection) => inspection.provider === provider);
      const configuredRefs = configured?.credential_ref ? [configured.credential_ref] : [];
      const credentialRefs = [...new Set([...configuredRefs, ...refs.map(({ ref }) => ref)])];
      const doctor = await adapter.doctor(
        { credentialRefs, requiredCapabilities: requestedCapabilities },
        options.context,
      );
      const cliChecks = cliChecksForProvider(provider, cliPrerequisites);
      const cliBlocked = cliChecks.some(({ status }) => status !== "installed");
      const requiredScopes = [
        ...new Set([...adapter.descriptor.requiredScopes, ...(configured?.required_scopes ?? [])]),
      ];
      const authenticatedRefs = refs.filter(authenticated);
      const declaredScopes = new Set(authenticatedRefs.flatMap(({ scopes }) => scopes));
      const missingScopes = requiredScopes.filter(
        (scope) => !declaredScopes.has(scope) && !declaredScopes.has("*"),
      );
      const acceptedKinds = compatibleKinds(provider, requestedCapabilities, registry);
      const missingCredentialKinds = adapter.descriptor.transports.every(
        (transport) => transport === "manual",
      )
        ? []
        : missingKinds(provider, requestedCapabilities, authenticatedRefs, registry);
      const plan = await inspectProviderPlan(provider, registry, launch);
      const manualOnly = adapter.descriptor.transports.every((transport) => transport === "manual");
      const authenticationRequired = acceptedKinds.length > 0;
      const authenticationProven = !authenticationRequired || missingCredentialKinds.length === 0;
      const doctorReady = doctor.status === "ready" && !cliBlocked && authenticationProven;
      const applyBlockers = [
        ...plan.availability.blockers,
        ...(cliBlocked
          ? cliChecks
              .filter(({ status }) => status !== "installed")
              .map(({ nextAction, binary }) => nextAction ?? `${binary} is unavailable`)
          : []),
        ...(doctor.status === "ready"
          ? []
          : doctor.issues.map(({ message, remediation }) => `${message}. Next: ${remediation}`)),
        ...(!authenticationProven
          ? [
              `No available credential has durable authenticated provider evidence for required kind(s): ${missingCredentialKinds.join(", ")}. Next: for API/OAuth/JWT refs inject an official remote credential tester and run vh auth test ${provider}; local backend availability alone is not authorization proof. For CLI sessions, run the official provider login and repeat vh doctor.`,
            ]
          : []),
      ];
      const applyAvailability = manualOnly
        ? planAvailability(
            false,
            "manual_only",
            applyBlockers,
            "Complete the declared human action and attach read-back evidence.",
          )
        : plan.availability.available && doctorReady
          ? planAvailability(
              true,
              "available",
              [],
              "Apply still requires a reviewed, unexpired run authorization envelope.",
            )
          : planAvailability(false, "blocked", [...new Set(applyBlockers)]);
      return {
        ...doctor,
        effectiveStatus:
          cliBlocked && doctor.status === "ready"
            ? "unavailable"
            : !authenticationProven && doctor.status === "ready"
              ? "auth_required"
              : doctor.status,
        configuredState: configured?.state ?? "unconfigured",
        configuredCredentialRef: configured?.credential_ref ?? null,
        configuredAccountId: configured?.account_id ?? null,
        configuredTeamId: configured?.team_id ?? null,
        configuredRegion: configured?.region ?? null,
        requestedCapabilities,
        registeredCredentialRefs: refs.map(({ ref }) => ref),
        authenticatedCredentialRefs: authenticatedRefs.map(({ ref }) => ref),
        expiredCredentialRefs: refs
          .filter(({ status }) => status === "expired")
          .map(({ ref, expiresAt }) => ({ ref, expiresAt: expiresAt ?? null })),
        missingExpiryCredentialRefs: refs
          .filter(({ expiresAt }) => expiresAt === undefined)
          .map(({ ref }) => ref),
        testedCredentialRefs: refs
          .filter(({ testedAt }) => testedAt !== undefined)
          .map(({ ref, testedAt, testStatus }) => ({
            ref,
            testedAt: testedAt!,
            testStatus: testStatus ?? "unknown",
          })),
        missingCredentialKinds,
        missingScopes,
        manualOnly,
        cliPrerequisites: cliChecks,
        planHandlers: plan.handlers,
        dryRunAvailability: plan.availability,
        applyAvailability,
      };
    }),
  );
  return {
    cliPrerequisites,
    registeredCredentialRefs: inspections.map((inspection) => ({
      ref: inspection.ref,
      provider: inspection.provider,
      kind: inspection.kind,
      backend: inspection.backend,
      status: inspection.status,
      scopes: [...inspection.scopes],
      expiresAt: inspection.expiresAt ?? null,
      testedAt: inspection.testedAt ?? null,
      testStatus: inspection.testStatus ?? null,
      revokedAt: inspection.revokedAt ?? null,
    })),
    authenticatedCredentialRefs: inspections
      .filter(authenticated)
      .map(({ ref, provider, kind }) => ({ ref, provider, kind })),
    testedCredentialRefs: inspections
      .filter(({ testedAt }) => testedAt !== undefined)
      .map(({ ref, provider, testedAt, testStatus }) => ({
        ref,
        provider,
        testedAt: testedAt!,
        testStatus: testStatus ?? "unknown",
      })),
    authenticationLimitation:
      "An available official CLI session or a persisted successful result from an injected official remote tester is durable authenticated evidence. Backend availability and failed/unknown tests are metadata only; doctor does not claim it validated them remotely.",
    manualOnlyProviders: registry
      .list()
      .filter((adapter) =>
        adapter.descriptor.transports.every((transport) => transport === "manual"),
      )
      .map((adapter) => adapter.descriptor.id),
    providerChecks,
  };
}
