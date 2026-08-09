import type { HarnessLock } from "../config/harness-lock";

export type LaunchEffect =
  | "repository.create"
  | "company_stack.provision"
  | "source.push"
  | "preview.deploy"
  | "production.deploy"
  | "domain.configure"
  | "commerce.configure"
  | "loops.schedule";

export type SeedId = "agentic-web-saas" | "agentic-ios-subscription" | "hybrid-agentic-service";

export interface ProviderAccountDestination {
  capability: string;
  provider: string;
  externalAccountId: string;
  ownerOrganizationId: string;
  stackClass: "company";
  ownership: "company_owned" | "company_owned_dedicated_account";
}

export interface LaunchGrant {
  grantId: string;
  schemaVersion: 1;
  ownerOrganizationId: string;
  ventureName: string;
  ventureSlug: string;
  ideaDigest: string;
  seed: { id: SeedId; version: string };
  stackProfile: { id: string; version: string };
  repository: {
    owner: string;
    name: string;
    visibility: "private" | "public";
  };
  providerAccounts: readonly ProviderAccountDestination[];
  autonomyProfile: "plan_only" | "owner_preview" | "owner_live_launch";
  allowedExternalEffects: readonly LaunchEffect[];
  /** @deprecated Legacy hard-metered materialization-effect executor contract. */
  modelBudget?: { maxTokens: number; maxMinorUnits: number; currency: string };
  /** @deprecated Legacy hard-metered materialization-effect executor contract. */
  externalResourceBudget?: { maxResources: number; maxMinorUnits: number; currency: string };
  /**
   * Canonical founder-rail policy. It is mutually independent from the optional
   * legacy hard-metered budget used by the separate materialization executor.
   */
  modelExecutionPolicy?:
    | {
        mode: "chatgpt_subscription_non_metered";
        maxBuildAgentTasks: number;
        attestation: "codex_login_status_chatgpt_subscription";
        usageAccounting: "observational";
      }
    | {
        mode: "fixture_no_model_execution";
        maxBuildAgentTasks: number;
        attestation: "fixture_build_host";
        usageAccounting: "none";
      };
  /**
   * Canonical founder-rail operation contract. It covers reviewed direct
   * operation charges only; account-plan and ongoing usage are deliberately out
   * of scope and must stay visible in dry-runs and reports.
   */
  providerOperationBudget?: {
    maxOperations: number;
    maxDirectChargeMinorUnits: number;
    currency: string;
    estimateBasis: "reviewed_known_zero_direct_charge";
    ongoingAccountPlanUsageCovered: false;
  };
  permissions: {
    productionDeployment: boolean;
    domainConfiguration: boolean;
    liveCommerceConfiguration: boolean;
  };
  createdAt: string;
  expiresAt: string;
  grantedBy: { actorId: string; actorType: "founder" | "organization_owner" };
  approvalRef: string;
  revokedAt: string | null;
}

export interface SeedFileTemplate {
  path: string;
  ownership: "core_owned" | "merge_managed" | "venture_owned";
  content: string;
}

export interface SeedDefinition {
  id: SeedId;
  version: string;
  rail: "web" | "ios" | "hybrid";
  serviceRuntime: "none" | "recursive";
  coreCompatibility: string;
  runtimePackages: Readonly<Record<string, string>>;
  developmentPackages: Readonly<Record<string, string>>;
  packageScripts: Readonly<Record<string, string>>;
  generatorVersions: Readonly<Record<string, string>>;
  files: readonly SeedFileTemplate[];
}

export interface VentureManifest {
  schemaVersion: 1;
  ventureId: string;
  ventureName: string;
  ventureSlug: string;
  ownerOrganizationId: string;
  repository: LaunchGrant["repository"];
  seed: LaunchGrant["seed"];
  stackProfile: LaunchGrant["stackProfile"];
  rail: SeedDefinition["rail"];
  coreVersion: string;
  serviceBlueprints?: readonly string[];
  connectorManifest: string;
  agentSurface?: {
    cli: string;
    mcpPrefix: string;
    sdkPackage: string;
    restPrefix: string;
  };
  companyResourcesOwnedBy: string;
  advertisingSpendAuthorized: false;
}

export interface MaterializedFile {
  path: string;
  ownership: SeedFileTemplate["ownership"];
  content: string;
  sha256: string;
}

export interface VentureMaterializationPlan {
  grant: LaunchGrant;
  seed: SeedDefinition;
  manifest: VentureManifest;
  files: readonly MaterializedFile[];
  lock: Extract<HarnessLock, { lock_version: 2 }>;
  effects: readonly LaunchEffect[];
  planDigest: string;
}

export interface LaunchEffectEvidence {
  effect: LaunchEffect;
  provider: string;
  externalAccountId: string;
  externalResourceId: string;
  ownership: "company_owned" | "company_owned_dedicated_account";
  requestAccepted: boolean;
  readBackVerified: boolean;
  fixture: boolean;
  observedAt: string;
}

export interface LaunchEffectExecutor {
  apply(input: {
    effect: LaunchEffect;
    grant: LaunchGrant;
    manifest: VentureManifest;
    idempotencyKey: string;
  }): Promise<LaunchEffectEvidence>;
}

export interface MaterializationFileSystem {
  prepareEmpty(): Promise<void>;
  writeExclusive(path: string, content: string): Promise<void>;
  removeCreated(path: string): Promise<void>;
}

export interface PackManifest {
  id:
    | "validate-first"
    | "ship-to-users"
    | "distribution-pr"
    | "winner-loop"
    | "web-saas"
    | "ios-subscription";
  version: string;
  coreCompatibility: string;
  capabilities: readonly string[];
  serviceBlueprints: readonly string[];
  commands: readonly string[];
  events: readonly string[];
  migrations: readonly string[];
  providers: readonly string[];
  evaluations: readonly string[];
  loops: readonly string[];
  uiContributions: readonly string[];
  uninstall: "reversible_if_unused" | "preserve_evidence";
}

export interface PackInstallationState {
  installed: Readonly<Record<string, string>>;
  capabilities: readonly string[];
  serviceBlueprints: readonly string[];
  commands: readonly string[];
  events: readonly string[];
  migrations: readonly string[];
  providers: readonly string[];
  evaluations: readonly string[];
  loops: readonly string[];
  uiContributions: readonly string[];
}
