import { providerRegistry, type ProviderRegistry } from "./registry";
import type {
  JsonValue,
  ProviderAdapter,
  ProviderEnvironment,
  ProviderId,
  ProviderOperation,
  ProviderPlan,
} from "./types";

/**
 * Provider-neutral company-stack roles supported by the operational adapter
 * layer. Each role names the concrete adapter capability its provider must
 * implement; a Stack Profile chooses the provider, not the contract.
 */
export const stackCapabilityContracts = {
  "source.repository.create": "repository",
  "hosting.web.deploy": "deployment",
  "database.postgres.provision": "project",
  "database.migrations.apply": "schema_migration",
  "commerce.web_subscription": "product",
  "commerce.native_subscription": "entitlement",
  "email.transactional": "template",
  "analytics.web.configure": "analytics_property",
  "search.google.configure": "search_console_site",
  "search.bing.configure": "site",
  "dns.record": "record",
  "mobile.ios.build": "ios_build",
} as const;

export type StackCapabilityRole = keyof typeof stackCapabilityContracts;

export type StackCapabilityBinding<Role extends StackCapabilityRole = StackCapabilityRole> = {
  readonly providerId: ProviderId;
  readonly capability: (typeof stackCapabilityContracts)[Role];
  readonly rationale: string;
};

export type StackProfileBindings = {
  readonly [Role in StackCapabilityRole]: StackCapabilityBinding<Role>;
};

export interface ProviderStackProfile {
  readonly profileId: string;
  readonly version: string;
  readonly label: string;
  /** Local contract verification is not evidence of authenticated provider state. */
  readonly verification: "local_contract_only";
  readonly bindings: StackProfileBindings;
}

const founderDefaultBindings = {
  "source.repository.create": {
    providerId: "github",
    capability: "repository",
    rationale: "Founder-default source publication uses the registered GitHub adapter.",
  },
  "hosting.web.deploy": {
    providerId: "vercel",
    capability: "deployment",
    rationale: "Founder-default web deployment uses the registered Vercel adapter.",
  },
  "database.postgres.provision": {
    providerId: "neon",
    capability: "project",
    rationale:
      "Founder-default PostgreSQL provisioning starts with the registered Neon project contract.",
  },
  "database.migrations.apply": {
    providerId: "neon",
    capability: "schema_migration",
    rationale: "Founder-default migrations use the registered Neon PostgreSQL migration contract.",
  },
  "commerce.web_subscription": {
    providerId: "stripe",
    capability: "product",
    rationale:
      "Founder-default web subscription catalog setup starts with Stripe product provisioning.",
  },
  "commerce.native_subscription": {
    providerId: "revenuecat",
    capability: "entitlement",
    rationale: "Founder-default native subscription access uses RevenueCat entitlements.",
  },
  "email.transactional": {
    providerId: "brevo",
    capability: "template",
    rationale: "Founder-default transactional email preparation uses inactive Brevo templates.",
  },
  "analytics.web.configure": {
    providerId: "google",
    capability: "analytics_property",
    rationale: "Founder-default web analytics configuration uses Google Analytics properties.",
  },
  "search.google.configure": {
    providerId: "google",
    capability: "search_console_site",
    rationale: "Founder-default Google discovery setup uses the Search Console site contract.",
  },
  "search.bing.configure": {
    providerId: "bing",
    capability: "site",
    rationale: "Founder-default Bing discovery setup uses the Webmaster site contract.",
  },
  "dns.record": {
    providerId: "mijndomein",
    capability: "record",
    rationale: "The founder-default registrar is MijnDomein and DNS changes remain manual.",
  },
  "mobile.ios.build": {
    providerId: "eas",
    capability: "ios_build",
    rationale: "Founder-default cross-platform iOS builds use the registered EAS adapter.",
  },
} as const satisfies StackProfileBindings;

export const founderDefaultStackProfile = {
  profileId: "founder-default",
  version: "0.2.0",
  label: "Founder default",
  verification: "local_contract_only",
  bindings: founderDefaultBindings,
} as const satisfies ProviderStackProfile;

export const genericDnsStackProfile = {
  profileId: "founder-default-generic-dns",
  version: "0.2.0",
  label: "Founder default with provider-neutral DNS",
  verification: "local_contract_only",
  bindings: {
    ...founderDefaultBindings,
    "dns.record": {
      providerId: "dns",
      capability: "record",
      rationale:
        "Use the registered provider-neutral manual DNS adapter for a non-MijnDomein zone.",
    },
  },
} as const satisfies ProviderStackProfile;

export const providerStackProfiles = [
  founderDefaultStackProfile,
  genericDnsStackProfile,
] as const satisfies readonly ProviderStackProfile[];

export type StackProfileErrorCode =
  | "invalid_profile"
  | "unknown_role"
  | "missing_role"
  | "provider_not_registered"
  | "role_capability_mismatch"
  | "capability_not_implemented"
  | "invalid_dry_run_plan";

export class StackProfileError extends Error {
  constructor(
    message: string,
    readonly code: StackProfileErrorCode,
  ) {
    super(message);
    this.name = "StackProfileError";
  }
}

const stackCapabilityRoles = Object.keys(stackCapabilityContracts) as StackCapabilityRole[];
const knownStackCapabilityRoles = new Set<string>(stackCapabilityRoles);

function runtimeBindings(profile: ProviderStackProfile): Readonly<Record<string, unknown>> {
  if (
    !profile.bindings ||
    typeof profile.bindings !== "object" ||
    Array.isArray(profile.bindings)
  ) {
    throw new StackProfileError(
      `Stack Profile ${profile.profileId} has no bindings object`,
      "invalid_profile",
    );
  }
  return profile.bindings;
}

function assertProfileIdentity(profile: ProviderStackProfile): void {
  if (
    typeof profile.profileId !== "string" ||
    profile.profileId.trim() === "" ||
    typeof profile.version !== "string" ||
    profile.version.trim() === "" ||
    typeof profile.label !== "string" ||
    profile.label.trim() === "" ||
    profile.verification !== "local_contract_only"
  ) {
    throw new StackProfileError(
      "Stack Profile identity or verification status is invalid",
      "invalid_profile",
    );
  }
}

function checkedBinding(
  profile: ProviderStackProfile,
  role: StackCapabilityRole,
  registry: ProviderRegistry,
): { binding: StackCapabilityBinding; adapter: ProviderAdapter } {
  const candidate = runtimeBindings(profile)[role];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new StackProfileError(
      `Stack Profile ${profile.profileId} is missing required role ${role}`,
      "missing_role",
    );
  }
  const binding = candidate as Partial<StackCapabilityBinding>;
  if (
    typeof binding.providerId !== "string" ||
    typeof binding.capability !== "string" ||
    typeof binding.rationale !== "string" ||
    binding.rationale.trim() === ""
  ) {
    throw new StackProfileError(
      `Stack Profile ${profile.profileId} has an invalid binding for ${role}`,
      "invalid_profile",
    );
  }
  const expectedCapability = stackCapabilityContracts[role];
  if (binding.capability !== expectedCapability) {
    throw new StackProfileError(
      `Role ${role} requires capability ${expectedCapability}, not ${binding.capability}`,
      "role_capability_mismatch",
    );
  }
  if (!registry.has(binding.providerId)) {
    throw new StackProfileError(
      `Provider adapter is not registered: ${binding.providerId}`,
      "provider_not_registered",
    );
  }
  const adapter = registry.get(binding.providerId);
  if (!adapter.descriptor.capabilities.includes(binding.capability)) {
    throw new StackProfileError(
      `${adapter.descriptor.displayName} does not implement ${binding.capability} for ${role}`,
      "capability_not_implemented",
    );
  }
  return { binding: binding as StackCapabilityBinding, adapter };
}

export function validateStackProfile(
  profile: ProviderStackProfile,
  registry: ProviderRegistry = providerRegistry,
): ProviderStackProfile {
  assertProfileIdentity(profile);
  const bindings = runtimeBindings(profile);
  for (const role of Object.keys(bindings)) {
    if (!knownStackCapabilityRoles.has(role)) {
      throw new StackProfileError(
        `Stack Profile ${profile.profileId} contains unknown role ${role}`,
        "unknown_role",
      );
    }
  }
  for (const role of stackCapabilityRoles) checkedBinding(profile, role, registry);
  return profile;
}

export interface ResolvedStackCapability<Role extends StackCapabilityRole = StackCapabilityRole> {
  readonly profileId: string;
  readonly profileVersion: string;
  readonly role: Role;
  readonly providerId: ProviderId;
  readonly capability: (typeof stackCapabilityContracts)[Role];
  readonly adapter: ProviderAdapter;
}

export function resolveStackCapability<Role extends StackCapabilityRole>(
  profile: ProviderStackProfile,
  role: Role,
  registry: ProviderRegistry = providerRegistry,
): ResolvedStackCapability<Role> {
  validateStackProfile(profile, registry);
  const { binding, adapter } = checkedBinding(profile, role, registry);
  return {
    profileId: profile.profileId,
    profileVersion: profile.version,
    role,
    providerId: binding.providerId,
    capability: binding.capability as (typeof stackCapabilityContracts)[Role],
    adapter,
  };
}

export interface StackCapabilityDryRunRequest {
  readonly environment: ProviderEnvironment;
  readonly credentialRef?: string;
  readonly inputs: Readonly<Record<string, JsonValue | undefined>>;
}

export interface PlannedStackCapability<
  Role extends StackCapabilityRole = StackCapabilityRole,
> extends ResolvedStackCapability<Role> {
  readonly plan: ProviderPlan;
}

function hasExactlyOneExecutionSpec(operation: ProviderOperation): boolean {
  return [operation.command, operation.http, operation.manual].filter(Boolean).length === 1;
}

function assertTypeCompleteDryRunPlan(
  resolved: ResolvedStackCapability,
  environment: ProviderEnvironment,
  plan: ProviderPlan,
): void {
  const targeted = plan.operations.filter(
    (operation) => operation.capability === resolved.capability,
  );
  if (
    plan.dryRun !== true ||
    plan.provider !== resolved.providerId ||
    plan.environment !== environment ||
    plan.id.trim() === "" ||
    Number.isNaN(Date.parse(plan.createdAt)) ||
    targeted.length === 0
  ) {
    throw new StackProfileError(
      `Adapter ${resolved.providerId} did not produce a complete dry-run plan for ${resolved.role}`,
      "invalid_dry_run_plan",
    );
  }
  for (const operation of plan.operations) {
    const transportMatchesSpec =
      (operation.transport === "cli" && operation.command !== undefined) ||
      (operation.transport === "http" && operation.http !== undefined) ||
      (operation.transport === "manual" && operation.manual !== undefined);
    if (
      operation.provider !== resolved.providerId ||
      operation.environment !== environment ||
      operation.id.trim() === "" ||
      operation.action.trim() === "" ||
      operation.title.trim() === "" ||
      operation.idempotencyKey.trim() === "" ||
      operation.verification.description.trim() === "" ||
      !Array.isArray(operation.dependsOn) ||
      !hasExactlyOneExecutionSpec(operation) ||
      !transportMatchesSpec ||
      !resolved.adapter.descriptor.capabilities.includes(operation.capability)
    ) {
      throw new StackProfileError(
        `Adapter ${resolved.providerId} emitted an incomplete operation for ${resolved.role}`,
        "invalid_dry_run_plan",
      );
    }
  }
}

/**
 * Resolve one role and build data only. This function always forces dry-run
 * planning and never calls doctor, apply, read-back, verify, or a transport.
 */
export function planStackCapabilityDryRun<Role extends StackCapabilityRole>(
  profile: ProviderStackProfile,
  role: Role,
  request: StackCapabilityDryRunRequest,
  registry: ProviderRegistry = providerRegistry,
): PlannedStackCapability<Role> {
  const resolved = resolveStackCapability(profile, role, registry);
  const plan = resolved.adapter.plan({
    environment: request.environment,
    credentialRef: request.credentialRef,
    capabilities: [resolved.capability],
    inputs: request.inputs,
    dryRun: true,
  });
  assertTypeCompleteDryRunPlan(resolved, request.environment, plan);
  return { ...resolved, plan };
}
