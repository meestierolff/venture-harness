import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
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
import { launchContractSchema, type LaunchContract } from "../founder-launch";
import {
  inspectCliPrerequisites,
  type CliPrerequisite,
  type CliPrerequisiteResult,
  type CommandRunner,
  type CredentialBroker,
  type CredentialInspection,
  type CredentialKind,
} from "../credentials";
import { founderBriefSchema, type FounderBrief } from "../launch";
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
  /** Pre-model immutable provider/config snapshot used by founder apply/resume. */
  configSnapshot?: DefaultProviderConfigSnapshot;
  /** Canonical commercial decisions; Stripe may not reread a model-mutable offer instead. */
  launchContract?: LaunchContract;
  loadConfig?: () => DefaultProviderConfigSnapshot;
  lifecycleStore?: ProviderLifecycleStore;
}

export class ProviderFactoryPrerequisiteError extends ProviderPlanFactoryPrerequisiteError {
  constructor(
    readonly handler: string,
    message: string,
    waitKind?: "auth" | "external",
  ) {
    super(
      `${handler}: ${message}; no partial plan was returned and no provider request was made.`,
      waitKind,
    );
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
  "provider.stripe-callbacks": { provider: "stripe", environment: "sandbox" },
  "provider.stripe-domain-callbacks": { provider: "stripe", environment: "sandbox" },
  "provider.google-analytics-property": { provider: "google", environment: "preview" },
  "provider.google-analytics-stream": { provider: "google", environment: "preview" },
  "provider.google-site-dns-record": { provider: "google", environment: "preview" },
  "provider.google-site-verification": { provider: "google", environment: "preview" },
  "provider.google-search-console": { provider: "google", environment: "preview" },
  "provider.bing-discovery": { provider: "bing", environment: "preview" },
  "provider.vercel-project": { provider: "vercel", environment: "preview" },
  "provider.vercel-database-environment": { provider: "vercel", environment: "production" },
  "provider.vercel-stripe-environment": { provider: "vercel", environment: "production" },
  "provider.vercel-stripe-webhook-environment": {
    provider: "vercel",
    environment: "production",
  },
  "provider.vercel-stripe-price-environment": {
    provider: "vercel",
    environment: "production",
  },
  "provider.vercel-stripe-price-lookup-environment": {
    provider: "vercel",
    environment: "production",
  },
  "provider.vercel-brevo-environment": { provider: "vercel", environment: "production" },
  "provider.vercel-ga-environment": { provider: "vercel", environment: "production" },
  "provider.dns-records": { provider: "dns", environment: "production" },
  "provider.revenuecat-entitlements": { provider: "revenuecat", environment: "sandbox" },
  "provider.eas-build": { provider: "eas", environment: "testflight" },
  "provider.eas-submit": { provider: "eas", environment: "testflight" },
  "provider.testflight-state": {
    provider: "app_store_connect",
    environment: "testflight",
  },
  "provider.production-deploy": { provider: "vercel", environment: "production" },
  "provider.initial-production-deploy": { provider: "vercel", environment: "production" },
  "provider.analytics-production-redeploy": { provider: "vercel", environment: "production" },
  "provider.email-production-redeploy": { provider: "vercel", environment: "production" },
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

function immutableConfigSnapshot(
  snapshot: DefaultProviderConfigSnapshot,
): DefaultProviderConfigSnapshot {
  return {
    providers: providersSchema.parse(snapshot.providers),
    venture: ventureSchema.parse(snapshot.venture),
    mobile: mobileSchema.parse(snapshot.mobile),
    offer: offerSchema.parse(snapshot.offer),
  };
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
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProviderFactoryPrerequisiteError(
      handler,
      `missing ${path}. Next: run vh auth login ${provider}, then record the registered cred:// reference in that field`,
      "auth",
    );
  }
  try {
    return credentialReferenceSchema.parse(value);
  } catch {
    throw new ProviderFactoryPrerequisiteError(
      handler,
      `${path} is not a valid cred:// reference. Next: run vh auth login ${provider} and record its registered reference`,
      "auth",
    );
  }
}

function requireCustomDomain(handler: string, brief: FounderBrief, purpose: string): string {
  if (!brief.domain) {
    throw new ProviderFactoryPrerequisiteError(
      handler,
      `missing canonical custom domain for ${purpose}. Next: keep the provider production URL live and resume this optional integration after a domain is reviewed`,
      "external",
    );
  }
  return brief.domain;
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
  authorizedDomain: string | null,
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
  if (
    handler === "provider.production-deploy" ||
    handler === "provider.initial-production-deploy" ||
    handler === "provider.analytics-production-redeploy" ||
    handler === "provider.email-production-redeploy"
  ) {
    requireVerifiedExisting(
      handler,
      "vercel",
      state,
      "Vercel project",
      lifecycleRecords,
      ["project"],
      [{ type: "project", value: project }],
    );
    return request(target, credentialRef, ["deployment"], {
      project,
      scope,
      deploymentPhase:
        handler === "provider.initial-production-deploy"
          ? "initial_production_origin"
          : handler === "provider.analytics-production-redeploy"
            ? "analytics_configured_production"
            : handler === "provider.email-production-redeploy"
              ? "email_configured_production"
              : "final_configured_production",
    });
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
    ["project", "deployment", ...(authorizedDomain ? ["domain"] : [])],
    {
      project,
      scope,
      projectIntent,
      ...(authorizedDomain ? { domain: authorizedDomain } : {}),
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

function vercelPublicStripeEnvironmentRequest(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
  brief: FounderBrief,
  workflow: WorkflowHandlerContext,
  launchContract?: LaunchContract,
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
  let environmentVariableName: string;
  let environmentPublicValue: string;
  if (handler === "provider.vercel-stripe-price-environment") {
    environmentVariableName = "STRIPE_PRICE_ID";
    environmentPublicValue = dependencyIdentifier(handler, workflow, "stripe-commerce", "price_id");
  } else if (handler === "provider.vercel-stripe-price-lookup-environment") {
    environmentVariableName = "STRIPE_PRICE_LOOKUP_KEY";
    const price = launchContract
      ? contractStripePrice(handler, launchContract)
      : configuredStripePrice(handler, snapshot);
    const unitAmount = exactMinorUnits(handler, price.amount, price.path);
    environmentPublicValue = stripePriceLookupKey(
      brief.id,
      price.currency,
      unitAmount,
      price.interval,
    );
  } else {
    return fail(handler, "unknown public Stripe application binding");
  }
  return request(target, credentialRef, ["environment_variable"], {
    project,
    scope,
    environmentVariableName,
    environmentTarget: "production",
    environmentPublicValue,
  });
}

function vercelPublicGoogleEnvironmentRequest(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
  workflow: WorkflowHandlerContext,
): ProviderWorkflowPlanRequest {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  const state = providerState(snapshot, "vercel");
  return request(
    target,
    requireCredential(handler, "vercel", state.credential_ref),
    ["environment_variable"],
    {
      project: requireExternal(
        handler,
        state,
        "project",
        "record the exact Vercel project slug to configure",
      ),
      scope: requireValue(
        handler,
        state.team_id ?? state.account_id,
        "config/providers.yaml providers.vercel.team_id or account_id",
        "record the exact Vercel team/account scope",
      ),
      environmentVariableName: "NEXT_PUBLIC_GA_MEASUREMENT_ID",
      environmentTarget: "production",
      environmentPublicValue: dependencyIdentifier(
        handler,
        workflow,
        "google-analytics-stream",
        "measurement_id",
      ),
    },
  );
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

function safeVerifiedVercelOrigin(
  handler: string,
  workflow: WorkflowHandlerContext,
  purpose = "domainless Stripe callbacks",
  dependencyId = "initial-production-deploy",
): string {
  const dependency = workflow.dependencyOutputs[dependencyId];
  if (
    !dependency ||
    Array.isArray(dependency) ||
    typeof dependency !== "object" ||
    dependency.provider !== "vercel" ||
    dependency.state !== "verified" ||
    !Array.isArray(dependency.environments) ||
    !dependency.environments.includes("production") ||
    !Array.isArray(dependency.capabilities) ||
    !dependency.capabilities.includes("deployment") ||
    !Array.isArray(dependency.resourceRefs)
  ) {
    return fail(
      handler,
      `${purpose} requires same-run verified ${dependencyId} output with one exact production deployment URL. Next: resume after that production deployment read-back`,
    );
  }
  const origins = new Set<string>();
  for (const reference of dependency.resourceRefs) {
    if (typeof reference !== "string" || !reference.startsWith("url=")) continue;
    try {
      const url = new URL(reference.slice("url=".length));
      const hostname = url.hostname.toLowerCase();
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        isIP(hostname) !== 0 ||
        !hostname.includes(".") ||
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".internal")
      ) {
        continue;
      }
      origins.add(url.origin);
    } catch {
      // Provider output is never repaired or guessed at this boundary.
    }
  }
  if (origins.size !== 1) {
    return fail(
      handler,
      `${dependencyId} read-back must contain one exact safe HTTPS production origin for ${purpose}; found ${origins.size}. Next: reconcile the production deployment before configuring it`,
    );
  }
  return [...origins][0]!;
}

function verifiedCustomDomainOrigin(
  handler: string,
  brief: FounderBrief,
  workflow: WorkflowHandlerContext,
): string {
  const domain = requireValue(
    handler,
    brief.domain,
    "canonical founder brief domain",
    "record a reviewed custom domain before requesting callback rebinding",
  );
  let expected: string;
  try {
    const url = new URL(`https://${domain}`);
    if (
      url.origin !== `https://${domain}` ||
      url.username ||
      url.password ||
      url.port ||
      isIP(url.hostname) !== 0 ||
      !url.hostname.includes(".") ||
      url.hostname.endsWith(".local") ||
      url.hostname.endsWith(".internal")
    ) {
      return fail(handler, "the canonical custom domain is not one safe HTTPS hostname");
    }
    expected = url.origin;
  } catch {
    return fail(handler, "the canonical custom domain is not one safe HTTPS hostname");
  }
  const project = workflow.dependencyOutputs["vercel-project"];
  const dns = workflow.dependencyOutputs["dns-records"];
  const verification = workflow.dependencyOutputs["verify-custom-domain"];
  const projectRefs =
    project &&
    !Array.isArray(project) &&
    typeof project === "object" &&
    project.provider === "vercel" &&
    project.state === "verified" &&
    Array.isArray(project.capabilities) &&
    project.capabilities.includes("domain") &&
    Array.isArray(project.resourceRefs)
      ? project.resourceRefs
      : [];
  const attached = projectRefs.some((reference) => {
    if (typeof reference !== "string") return false;
    const separator = reference.indexOf("=");
    if (separator < 0 || !["domain", "site_url", "url"].includes(reference.slice(0, separator))) {
      return false;
    }
    const value = reference.slice(separator + 1);
    if (value === domain) return true;
    try {
      return new URL(value).origin === expected;
    } catch {
      return false;
    }
  });
  const dnsVerified =
    dns !== undefined &&
    dns !== null &&
    !Array.isArray(dns) &&
    typeof dns === "object" &&
    ((dns.mode === "manual_dns" &&
      Array.isArray(dns.propagation_checks) &&
      dns.propagation_checks.length >= 2 &&
      dns.propagation_checks.every(
        (check) =>
          check && !Array.isArray(check) && typeof check === "object" && check.status === "matched",
      )) ||
      (dns.provider === "dns" &&
        dns.state === "verified" &&
        Array.isArray(dns.capabilities) &&
        dns.capabilities.includes("record")));
  const journeyVerified =
    verification !== undefined &&
    verification !== null &&
    !Array.isArray(verification) &&
    typeof verification === "object" &&
    verification.target === "verified_custom_domain" &&
    verification.deploymentUrl === expected &&
    verification.customDomain !== null &&
    typeof verification.customDomain === "object" &&
    !Array.isArray(verification.customDomain) &&
    verification.customDomain.state === "verified" &&
    verification.customDomain.origin === expected;
  if (!attached || !dnsVerified || !journeyVerified) {
    throw new ProviderFactoryPrerequisiteError(
      handler,
      "custom-domain callbacks require same-run verified Vercel attachment, authoritative DNS, and exact-origin product-journey evidence. Next: finish the custom-domain verification node, then resume callback rebinding",
      "external",
    );
  }
  return expected;
}

function contractStripePrice(
  handler: string,
  contract: LaunchContract,
): { amount: number; interval: string | null; currency: string; path: string } {
  if (
    contract.business.paymentProvider !== "stripe" ||
    contract.business.priceHypothesis === null
  ) {
    return fail(handler, "the canonical Launch Contract does not authorize one Stripe price");
  }
  if (!["subscription", "one_time", "service"].includes(contract.business.model)) {
    return fail(
      handler,
      `Launch Contract pricing model ${contract.business.model} has no deterministic built-in Stripe price shape. Next: select a supported exact subscription, one-time, or service price or inject a reviewed typed factory`,
    );
  }
  return {
    amount: contract.business.priceHypothesis,
    interval: contract.business.model === "subscription" ? "month" : null,
    currency: contract.business.currency,
    path: "canonical Launch Contract business.priceHypothesis",
  };
}

function configuredStripePrice(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
): { amount: number; interval: string | null; currency: string; path: string } {
  const configuredPrices = [
    snapshot.offer.pricing.monthly_price === null
      ? null
      : {
          amount: snapshot.offer.pricing.monthly_price,
          interval: "month",
          currency: snapshot.offer.pricing.currency,
          path: "config/offer.yaml pricing.monthly_price",
        },
    snapshot.offer.pricing.annual_price === null
      ? null
      : {
          amount: snapshot.offer.pricing.annual_price,
          interval: "year",
          currency: snapshot.offer.pricing.currency,
          path: "config/offer.yaml pricing.annual_price",
        },
    snapshot.offer.pricing.one_time_price === null
      ? null
      : {
          amount: snapshot.offer.pricing.one_time_price,
          interval: null,
          currency: snapshot.offer.pricing.currency,
          path: "config/offer.yaml pricing.one_time_price",
        },
  ].filter(
    (value): value is { amount: number; interval: string | null; currency: string; path: string } =>
      value !== null,
  );
  if (configuredPrices.length !== 1) {
    return fail(
      handler,
      configuredPrices.length === 0
        ? "no approved recurring or one-time price exists in config/offer.yaml. Next: record the exact displayed price before planning Stripe"
        : "multiple launch prices are active, but the built-in node cannot yet prove multiple immutable Stripe price resources without omitting one. Next: select one launch price or inject a multi-price factory",
    );
  }
  return configuredPrices[0]!;
}

function stripePriceLookupKey(
  ventureSlug: string,
  currency: string,
  unitAmount: number,
  interval: string | null,
): string {
  return `vh_${ventureSlug.replaceAll("-", "_")}_${currency.toLowerCase()}_${unitAmount}_${interval ?? "once"}`;
}

function stripeRequest(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
  brief: FounderBrief,
  workflow: WorkflowHandlerContext,
  launchContract?: LaunchContract,
): ProviderWorkflowPlanRequest {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  const state = providerState(snapshot, "stripe");
  const credentialRef = requireCredential(handler, "stripe", state.credential_ref);
  const stripeAccountId = requireValue(
    handler,
    state.account_id,
    "config/providers.yaml providers.stripe.account_id",
    "record the exact Stripe account proven by the restricted test credential",
  );
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
  const productName = launchContract?.venture.name ?? brief.name;
  const stripeMode = requireExternal(
    handler,
    state,
    "mode",
    "record Stripe test mode in the Founder Stack profile",
  );
  if (stripeMode !== "test") {
    fail(handler, "dogfood Stripe provisioning is restricted to test mode");
  }
  if (handler === "provider.stripe-commerce") {
    const configuredPrice = launchContract
      ? contractStripePrice(handler, launchContract)
      : configuredStripePrice(handler, snapshot);
    return request(target, credentialRef, ["product", "price"], {
      ventureSlug: brief.id,
      stripeAccountId,
      stripeMode,
      productName,
      ...(launchContract
        ? { productDescription: launchContract.venture.oneSentenceThesis }
        : snapshot.offer.offer.sentence
          ? { productDescription: snapshot.offer.offer.sentence }
          : {}),
      productId: "{dependency.product.id}",
      currency: configuredPrice.currency.toLowerCase(),
      unitAmount: exactMinorUnits(handler, configuredPrice.amount, configuredPrice.path),
      ...(configuredPrice.interval ? { recurringInterval: configuredPrice.interval } : {}),
    });
  }
  if (handler !== "provider.stripe-callbacks" && handler !== "provider.stripe-domain-callbacks") {
    return fail(handler, "unknown staged Stripe handler");
  }
  const callbackOrigin =
    handler === "provider.stripe-domain-callbacks"
      ? verifiedCustomDomainOrigin(handler, brief, workflow)
      : safeVerifiedVercelOrigin(handler, workflow, "Stripe callbacks");
  const webhookSecretCredentialRef = requireCredential(
    handler,
    "stripe",
    state.external_resource_ids.webhook_secret_credential_ref,
    "config/providers.yaml providers.stripe.external_resource_ids.webhook_secret_credential_ref",
  );
  return request(target, credentialRef, ["webhook", "billing_portal"], {
    ventureSlug: brief.id,
    stripeAccountId,
    stripeMode,
    webhookUrl: `${callbackOrigin}/api/stripe/webhook`,
    webhookSecretCredentialRef,
    enabledEvents: [
      "checkout.session.completed",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.payment_failed",
    ],
    headline: `Manage ${productName}`,
    portalReturnUrl: `${callbackOrigin}/account`,
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
  brief: FounderBrief,
  workflow: WorkflowHandlerContext,
): ProviderWorkflowPlanRequest {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  const state = providerState(snapshot, "google");
  const credentialRef = requireCredential(handler, "google", state.credential_ref);
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
    case "provider.google-analytics-stream": {
      const originDependency = workflow.node.dependencies.includes("initial-production-deploy")
        ? "initial-production-deploy"
        : "production-deploy";
      const productionOrigin = safeVerifiedVercelOrigin(
        handler,
        workflow,
        "the GA4 web stream",
        originDependency,
      );
      return request(target, credentialRef, ["analytics_web_stream"], {
        analyticsPropertyId: dependencyIdentifier(
          handler,
          workflow,
          "google-analytics-property",
          "property_id",
        ),
        streamDisplayName:
          state.external_resource_ids.stream_display_name ??
          `${new URL(productionOrigin).hostname} web`,
        defaultUri: `${productionOrigin}/`,
        measurementIdCredentialRef: requireCredential(
          handler,
          "google",
          state.external_resource_ids.measurement_id_credential_ref,
          "config/providers.yaml providers.google.external_resource_ids.measurement_id_credential_ref",
        ),
      });
    }
    default: {
      const domain = requireCustomDomain(
        handler,
        brief,
        "Google site verification or search setup",
      );
      const siteUrl = state.external_resource_ids.site_url ?? `sc-domain:${domain}`;
      const sitemapUrl = state.external_resource_ids.sitemap_url ?? `https://${domain}/sitemap.xml`;
      switch (handler) {
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
  }
}

function bingRequest(
  handler: string,
  snapshot: DefaultProviderConfigSnapshot,
  brief: FounderBrief,
  lifecycleRecords: readonly VerifiedProviderLifecycleRecord[],
): ProviderWorkflowPlanRequest {
  const target = DEFAULT_PROVIDER_TARGETS[handler]!;
  const state = providerState(snapshot, "bing");
  const credentialRef = requireCredential(handler, "bing", state.credential_ref);
  const domain = requireCustomDomain(handler, brief, "Bing site and sitemap setup");
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
  // Validate the complete captured config before deciding so a broad but
  // partial factory never slips in through mutable late-bound state.
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
  brief: FounderBrief,
  lifecycleRecords: readonly VerifiedProviderLifecycleRecord[],
  workflow: WorkflowHandlerContext,
  rootDir: string,
  launchContract?: LaunchContract,
): ProviderWorkflowPlanRequest {
  switch (handler) {
    case "provider.github-repository":
      return githubRequest(handler, snapshot, lifecycleRecords, rootDir);
    case "provider.vercel-project":
    case "provider.initial-production-deploy":
    case "provider.analytics-production-redeploy":
    case "provider.email-production-redeploy":
    case "provider.production-deploy":
      return vercelRequest(handler, snapshot, lifecycleRecords, brief.domain ?? null);
    case "provider.vercel-database-environment":
    case "provider.vercel-stripe-environment":
    case "provider.vercel-stripe-webhook-environment":
    case "provider.vercel-brevo-environment":
      return vercelEnvironmentRequest(handler, snapshot);
    case "provider.vercel-ga-environment":
      return vercelPublicGoogleEnvironmentRequest(handler, snapshot, workflow);
    case "provider.vercel-stripe-price-environment":
    case "provider.vercel-stripe-price-lookup-environment":
      return vercelPublicStripeEnvironmentRequest(
        handler,
        snapshot,
        brief,
        workflow,
        launchContract,
      );
    case "provider.neon-database":
      return neonRequest(handler, snapshot, lifecycleRecords, rootDir);
    case "provider.stripe-commerce":
    case "provider.stripe-callbacks":
    case "provider.stripe-domain-callbacks":
      return stripeRequest(handler, snapshot, brief, workflow, launchContract);
    case "provider.brevo-sending-domain":
    case "provider.brevo-domain-verification":
    case "provider.brevo-email":
      return brevoRequest(handler, snapshot, workflow);
    case "provider.google-analytics-property":
    case "provider.google-analytics-stream":
    case "provider.google-site-dns-record":
    case "provider.google-site-verification":
    case "provider.google-search-console":
      return googleRequest(handler, snapshot, brief, workflow);
    case "provider.bing-discovery":
      return bingRequest(handler, snapshot, brief, lifecycleRecords);
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
  if (options.configSnapshot && options.loadConfig) {
    throw new Error("Default provider factories accept configSnapshot or loadConfig, not both");
  }
  const brief = founderBriefSchema.parse(currentBrief(options.brief));
  const launchContract = options.launchContract
    ? launchContractSchema.parse(options.launchContract)
    : undefined;
  const capturedConfig = immutableConfigSnapshot(
    options.configSnapshot ??
      (options.loadConfig ? options.loadConfig() : loadDefaultProviderConfig(options.rootDir)),
  );
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
        if (brief.id !== options.definition.id.replace(/^launch-/, "")) {
          fail(
            handler,
            `founder brief ${brief.id} does not match graph ${options.definition.id}. Next: recreate the launch plan from the current brief`,
          );
        }
        const snapshot = immutableConfigSnapshot(capturedConfig);
        let lifecycleRecords: VerifiedProviderLifecycleRecord[] = [];
        if (options.lifecycleStore) {
          try {
            lifecycleRecords = (await options.lifecycleStore.list()).filter(
              ({ provider, environment, capability }) => {
                const target = DEFAULT_PROVIDER_TARGETS[handler]!;
                if (provider !== target.provider) return false;
                if (environment === target.environment) return true;
                return (
                  (handler === "provider.production-deploy" ||
                    handler === "provider.initial-production-deploy" ||
                    handler === "provider.analytics-production-redeploy" ||
                    handler === "provider.email-production-redeploy") &&
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
          brief,
          lifecycleRecords,
          workflow,
          options.rootDir,
          launchContract,
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
      (inspection.testStatus === "passed" &&
        inspection.testedAt !== undefined &&
        (inspection.provider !== "stripe" || inspection.providerMode === "test")))
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
  if (!launch.factories) {
    return {
      handlers: nodes.map((node) => node.handler!),
      availability: planAvailability(false, "blocked", [
        "Provider doctor has no immutable config-bound plan factories for this launch.",
      ]),
    };
  }
  const factories = launch.factories;
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
