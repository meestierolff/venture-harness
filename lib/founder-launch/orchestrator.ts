import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import {
  compileLaunchDryRun,
  launchBuildAgentTaskCount,
  launchProviderByNode,
  launchProviderOperationCeiling,
  type FounderBrief,
  type LaunchDryRun,
} from "../launch";
import {
  NodeMaterializationFileSystem,
  compileVentureMaterialization,
  createLaunchGrant,
  materializeVenture,
  type LaunchEffect,
  type LaunchGrant,
  type ProviderAccountDestination,
  type SeedId,
  type VentureMaterializationPlan,
} from "../materialization";
import { OwnerPathLock } from "../security/owner-path-lock";
import { compileFounderIdea, type CompiledFounderIdea } from "./idea";
import { resolveVentureOutputWithinRoot } from "./founder-config";
import { launchContractDigest, launchDecisionFromContract } from "./launch-contract";
import {
  FOUNDER_STACK_PROFILE_ID,
  founderStackDnsDestinationId,
  parseFounderStackConnection,
  renderFounderStackProviderConfigOverrides,
  type FounderStackConnection,
  type FounderStackDoctorResult,
  type FounderStackRole,
} from "./stack";

const CORE_VERSION = "0.2.0" as const;
const STACK_VERSION = "0.2.0" as const;
const MAX_IDEA_BYTES = 100_000;

const ROLE_BY_PROVIDER = {
  github: "source.repository",
  vercel: "hosting.web",
  neon: "database.postgres",
  stripe: "commerce.web",
  revenuecat: "commerce.native",
  brevo: "email.transactional",
  google: "growth.google",
  bing: "search.bing",
  dns: "dns.records",
} as const satisfies Readonly<Record<string, FounderStackRole>>;

const ENVIRONMENT_BINDINGS = {
  "database.postgres": ["DATABASE_URL"],
  "commerce.web": ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  "email.transactional": ["BREVO_API_KEY"],
  "growth.google": ["NEXT_PUBLIC_GA_MEASUREMENT_ID"],
} as const satisfies Partial<Record<FounderStackRole, readonly string[]>>;

export type FounderLaunchExecutionMode = "dry-run" | "apply";

export interface FounderLaunchPreparationInput {
  readonly ideaSource: string;
  readonly ideaPath: string;
  readonly stack: FounderStackConnection;
  readonly stackDoctor?: FounderStackDoctorResult;
  readonly baseDir: string;
  readonly output?: string;
  readonly workflowRefSha: string;
  readonly workflowRepository: string;
  readonly executionMode: FounderLaunchExecutionMode;
  readonly production: boolean;
  readonly nonInteractive: boolean;
  readonly at: Date;
  readonly actorId?: string;
  /** Test-only escape hatch; production hosts must never accept fixture credential storage. */
  readonly allowFixtureStack?: boolean;
}

export interface FounderLaunchBlocker {
  readonly code:
    | "stack_role_not_ready"
    | "repository_owner_missing"
    | "exact_price_missing"
    | "provider_account_missing"
    | "custom_domain_deferred"
    | "optional_integration_deferred";
  readonly role?: FounderStackRole;
  readonly provider?: string;
  readonly message: string;
  readonly nextAction: string;
}

export interface FounderLaunchGap extends FounderLaunchBlocker {
  readonly state: "waiting_for_auth" | "waiting_for_external_action";
  readonly blocksLaunch: false;
}

export interface FounderLaunchPreparation {
  readonly schemaVersion: 1;
  readonly status: "ready" | "blocked";
  readonly executionMode: FounderLaunchExecutionMode;
  readonly production: boolean;
  readonly nonInteractive: boolean;
  readonly idea: CompiledFounderIdea;
  readonly selectedVentureType: {
    readonly mode: string;
    readonly rail: string;
    readonly seed: { readonly id: SeedId; readonly version: string };
    readonly commerce: string;
  };
  readonly stackProfile: typeof FOUNDER_STACK_PROFILE_ID;
  readonly selectedProviders: readonly {
    readonly role: FounderStackRole;
    readonly provider: string;
    readonly accountId: string | null;
    readonly teamId: string | null;
    readonly organizationId: string | null;
    readonly credentialRef: string | null;
    readonly verification: string;
  }[];
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly visibility: "private" | "public";
    readonly localDirectory: string;
  };
  readonly resources: LaunchDryRun["resources"];
  readonly environmentVariables: readonly {
    readonly name: string;
    readonly sourceRole: FounderStackRole;
    readonly valuePersisted: false;
  }[];
  readonly migrations: readonly string[];
  readonly domain: {
    readonly requested: string | null;
    readonly mode: "automatic_if_adapter_available" | "manual_consolidated_action" | "none";
    readonly expectedRecords: readonly string[];
    /**
     * What the venture treats as its public origin until DNS is authoritative.
     * The provider production URL is a truthful initial origin; a custom domain
     * is only claimed after read-back.
     */
    readonly canonicalOrigin: "provider_production_url" | "custom_domain_after_readback";
    readonly pendingAction: string | null;
  };
  readonly setup: {
    readonly analytics: "google_analytics" | "not_requested";
    readonly search: "google_search_console_and_bing" | "not_requested";
    readonly email: "brevo_transactional" | "not_requested";
    readonly commerce: "stripe_test_mode" | "revenuecat_test_mode" | "none";
  };
  readonly estimatedExternalEffects: readonly LaunchEffect[];
  readonly launchGrant: LaunchGrant;
  readonly grantDisposition: "proposed_not_issued" | "issued_for_apply" | "withheld_blocked";
  readonly materialization: VentureMaterializationPlan;
  readonly graphDryRun: LaunchDryRun;
  readonly blockers: readonly FounderLaunchBlocker[];
  readonly launchGaps: readonly FounderLaunchGap[];
  readonly exactFinalCommand: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function founderSeedFor(
  brief: FounderBrief,
  launchContract: CompiledFounderIdea["launchContract"],
): SeedId {
  if (
    launchContract?.agentNative.customerAgentSurfaceRequired ||
    launchContract?.agentNative.serviceBlueprintRequired
  ) {
    return "hybrid-agentic-service";
  }
  if (brief.app_kind === "web") return "agentic-web-saas";
  if (brief.app_kind === "mobile_ios" || brief.app_kind === "mobile_cross_platform") {
    return "agentic-ios-subscription";
  }
  return "hybrid-agentic-service";
}

function requiredRoles(
  brief: FounderBrief,
  paymentProvider: LaunchDryRun["decision"]["payment"]["provider"],
): readonly FounderStackRole[] {
  const roles = new Set<FounderStackRole>(["source.repository"]);
  if (brief.app_kind === "web" || brief.app_kind === "hybrid") roles.add("hosting.web");
  if (brief.needs.database) roles.add("database.postgres");
  if (paymentProvider === "stripe") roles.add("commerce.web");
  if (paymentProvider === "revenuecat") roles.add("commerce.native");
  if (brief.needs.transactional_email) roles.add("email.transactional");
  if (brief.needs.analytics || brief.needs.search_discovery) roles.add("growth.google");
  if (brief.needs.search_discovery) roles.add("search.bing");
  if (brief.domain) roles.add("dns.records");
  return [...roles];
}

function accountIdFor(connection: FounderStackConnection, role: FounderStackRole): string | null {
  const selected = connection.roles[role];
  if (role === "source.repository" || role === "hosting.web") {
    return selected.teamId ?? selected.accountId ?? selected.organizationId ?? null;
  }
  if (role === "database.postgres" || role === "commerce.native") {
    return selected.organizationId ?? selected.accountId ?? selected.teamId ?? null;
  }
  if (role === "growth.google") {
    return (
      connection.launchDefaults.google.analyticsAccountId ??
      selected.accountId ??
      selected.organizationId ??
      null
    );
  }
  if (role === "dns.records") {
    return founderStackDnsDestinationId(connection);
  }
  return selected.accountId ?? selected.teamId ?? selected.organizationId ?? null;
}

function providerAccounts(
  connection: FounderStackConnection,
  graph: LaunchDryRun["graph"],
): ProviderAccountDestination[] {
  const accounts: ProviderAccountDestination[] = [];
  const seen = new Set<string>();
  for (const node of graph.nodes.filter(
    ({ id, kind }) => kind === "provider" || id === "dns-records",
  )) {
    const provider = launchProviderByNode[node.id as keyof typeof launchProviderByNode];
    const role = provider ? ROLE_BY_PROVIDER[provider as keyof typeof ROLE_BY_PROVIDER] : undefined;
    if (!provider || !role) continue;
    for (const capability of node.authorization.scopes) {
      const selected = connection.roles[role];
      const externalAccountId =
        provider === "google" && !capability.startsWith("analytics_")
          ? (selected.accountId ?? selected.organizationId ?? null)
          : accountIdFor(connection, role);
      if (!externalAccountId) continue;
      const key = `${provider}\u0000${capability}\u0000${externalAccountId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      accounts.push({
        capability,
        provider,
        externalAccountId,
        ownerOrganizationId: connection.ownerOrganizationId,
        stackClass: "company",
        ownership: "company_owned",
      });
    }
  }
  return accounts;
}

function effectsFor(
  brief: FounderBrief,
  paymentProvider: LaunchDryRun["decision"]["payment"]["provider"],
): readonly LaunchEffect[] {
  const effects = new Set<LaunchEffect>([
    "repository.create",
    "company_stack.provision",
    "source.push",
    "preview.deploy",
    "production.deploy",
  ]);
  if (paymentProvider !== "none") effects.add("commerce.configure");
  if (brief.needs.scheduled_learning) effects.add("loops.schedule");
  return [...effects];
}

function containedOutput(baseDir: string, requested: string | undefined, slug: string): string {
  const root = resolve(baseDir);
  // baseDir is already the explicitly configured ventures root. Nesting a
  // second `ventures/` directory made the public default surprising and broke
  // the promised one-sibling-per-venture layout.
  const relativeOutput = requested ?? slug;
  if (!relativeOutput || isAbsolute(relativeOutput)) {
    throw new Error("Founder launch --output must be a non-empty project-relative path");
  }
  return resolveVentureOutputWithinRoot(root, relativeOutput);
}

export function loadFounderIdeaFile(file: string, baseDir = process.cwd()): string {
  if (!file) throw new Error("Founder launch --idea requires a file path");
  const boundary = new OwnerPathLock(resolve(baseDir), {
    label: "Founder launch idea read",
    lockName: ".founder-launch-idea.lock",
  });
  try {
    return boundary.readRegularFile(resolve(boundary.root.path, file), {
      label: "Founder launch --idea",
      maxBytes: MAX_IDEA_BYTES,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("escapes the locked")) {
      throw new Error("Founder launch --idea escapes the selected workspace", { cause: error });
    }
    throw error;
  } finally {
    boundary.release();
  }
}

const WORKFLOW_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** Read owner/repository out of an HTTPS or SSH GitHub remote URL. */
function gitHubSlug(remoteUrl: string): string | undefined {
  const match =
    /^https?:\/\/[^/]+\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/u.exec(remoteUrl) ??
    /^(?:ssh:\/\/)?git@[^:/]+[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/u.exec(remoteUrl);
  const owner = match?.groups?.owner;
  const repo = match?.groups?.repo;
  if (!owner || !repo) return undefined;
  const slug = `${owner}/${repo}`;
  return WORKFLOW_REPOSITORY.test(slug) ? slug : undefined;
}

/**
 * Resolve the Core repository whose reusable workflow a venture calls.
 *
 * A generated venture must reference the Venture Harness checkout it was
 * actually launched from. Hardcoding one author's repository would make every
 * venture produced by every fork depend on that person's account staying
 * public, and would put their identity into other people's products.
 */
export function resolveFounderWorkflowRepository(baseDir: string, explicit?: string): string {
  const candidate = explicit ?? process.env.VH_WORKFLOW_REPOSITORY;
  if (candidate) {
    if (!WORKFLOW_REPOSITORY.test(candidate)) {
      throw new Error("VH_WORKFLOW_REPOSITORY must be exactly owner/repository");
    }
    return candidate;
  }
  try {
    const origin = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: resolve(baseDir),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const slug = gitHubSlug(origin);
    if (slug) return slug;
  } catch {
    // The exact remediation below is safe for packed consumers without Git.
  }
  throw new Error(
    "Founder launch cannot resolve the Core repository for the venture reusable workflow. Set VH_WORKFLOW_REPOSITORY to the owner/repository of this Venture Harness checkout.",
  );
}

export function resolveFounderWorkflowRefSha(baseDir: string, explicit?: string): string {
  const candidate = explicit ?? process.env.VH_WORKFLOW_REF_SHA;
  if (candidate) {
    if (!/^[a-f0-9]{40}$/u.test(candidate)) {
      throw new Error("VH_WORKFLOW_REF_SHA must be an immutable lowercase 40-character Git SHA");
    }
    return candidate;
  }
  try {
    const resolved = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: resolve(baseDir),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^[a-f0-9]{40}$/u.test(resolved)) return resolved;
  } catch {
    // The exact remediation below is safe for packed consumers without a Git checkout.
  }
  throw new Error(
    "Founder launch cannot resolve an immutable workflow revision. Set VH_WORKFLOW_REF_SHA to the reviewed Venture Harness commit SHA.",
  );
}

function quoteCli(value: string): string {
  return /^[A-Za-z0-9_./-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function providerForRole(role: FounderStackRole): string {
  return role === "source.repository"
    ? "github"
    : role === "hosting.web"
      ? "vercel"
      : role === "database.postgres"
        ? "neon"
        : role === "commerce.web"
          ? "stripe"
          : role === "commerce.native"
            ? "revenuecat"
            : role === "email.transactional"
              ? "brevo"
              : role === "growth.google"
                ? "google"
                : role === "search.bing"
                  ? "bing"
                  : "dns";
}

function readinessFor(
  compiled: CompiledFounderIdea,
  paymentProvider: LaunchDryRun["decision"]["payment"]["provider"],
  connection: FounderStackConnection,
  roles: readonly FounderStackRole[],
  doctor: FounderStackDoctorResult | undefined,
  allowFixtureStack: boolean,
): { blockers: FounderLaunchBlocker[]; launchGaps: FounderLaunchGap[] } {
  const blockers: FounderLaunchBlocker[] = [];
  const launchGaps: FounderLaunchGap[] = [];
  const blockingRoles = new Set<FounderStackRole>(["source.repository"]);
  if (roles.includes("hosting.web")) blockingRoles.add("hosting.web");
  if (roles.includes("database.postgres")) blockingRoles.add("database.postgres");
  if (paymentProvider === "stripe") blockingRoles.add("commerce.web");
  const addRoleIssue = (
    issue: FounderLaunchBlocker,
    state: FounderLaunchGap["state"],
    forceBlock = false,
  ) => {
    if (forceBlock || (issue.role !== undefined && blockingRoles.has(issue.role))) {
      blockers.push(issue);
    } else {
      launchGaps.push({ ...issue, state, blocksLaunch: false });
    }
  };
  if (doctor?.writableCredentialTargets.fixtureOnly && !allowFixtureStack) {
    blockers.push({
      code: "stack_role_not_ready",
      message:
        "The Founder Stack uses fixture-only credential storage and cannot authorize production.",
      nextAction:
        "Create founder-default with a writable macos_keychain or onepassword backend, then rerun stack doctor.",
    });
  }
  const repositoryOwner = accountIdFor(connection, "source.repository");
  if (!repositoryOwner) {
    blockers.push({
      code: "repository_owner_missing",
      role: "source.repository",
      provider: "github",
      message: "The Founder Stack does not identify the exact GitHub owner for the new repository.",
      nextAction:
        "Update founder-default source.repository with an accountId, teamId, or organizationId, then rerun stack doctor.",
    });
  }
  const expectedStripePrices =
    compiled.brief.monetization_model === "subscription"
      ? Number(compiled.commercialTerms.monthlyPrice !== null) +
        Number(compiled.commercialTerms.annualPrice !== null)
      : compiled.brief.monetization_model === "one_time" ||
          compiled.brief.monetization_model === "services"
        ? Number(compiled.commercialTerms.oneTimePrice !== null)
        : 0;
  if (paymentProvider === "stripe" && expectedStripePrices !== 1) {
    blockers.push({
      code: "exact_price_missing",
      role: "commerce.web",
      provider: "stripe",
      message:
        compiled.brief.monetization_model === "subscription"
          ? "Stripe planning requires exactly one reviewed monthly or annual displayed price."
          : "Stripe planning requires exactly one reviewed one-time displayed price.",
      nextAction:
        compiled.brief.monetization_model === "subscription"
          ? "Add exactly one of `Monthly price:` or `Annual price:` to the founder idea and rerun dry-run."
          : "Add one reviewed one-time price to the Launch Contract and rerun dry-run.",
    });
  }
  // A custom domain is not a precondition for being live. Vercel issues a
  // stable production URL that commerce, email, analytics and search can all
  // be configured against, so a missing domain is a deferred action rather than
  // a blocker. Treating it as a blocker meant a founder could not ship a first
  // app at all until DNS existed.
  for (const role of roles) {
    const definitionProvider = providerForRole(role);
    const accountId = accountIdFor(connection, role);
    const credentialReady = role === "dns.records" || Boolean(connection.roles[role].credentialRef);
    const dnsAdapterReady =
      role !== "dns.records" || connection.launchDefaults.dns.adapter !== null;
    if (!accountId) {
      addRoleIssue(
        {
          code: "provider_account_missing",
          role,
          provider: definitionProvider,
          message: `The Founder Stack does not bind ${role} to an exact external account.`,
          nextAction: `Update founder-default ${role} account metadata and rerun stack doctor.`,
        },
        "waiting_for_auth",
      );
    }
    if (!credentialReady) {
      addRoleIssue(
        {
          code: "stack_role_not_ready",
          role,
          provider: definitionProvider,
          message: `The Founder Stack does not bind ${role} to a registered credential reference.`,
          nextAction: `Run vh auth login ${definitionProvider}, update founder-default ${role}, then rerun stack doctor.`,
        },
        "waiting_for_auth",
      );
    }
    if (!dnsAdapterReady) {
      addRoleIssue(
        {
          code: "stack_role_not_ready",
          role,
          provider: definitionProvider,
          message:
            "The Founder Stack does not select an exact supported manual DNS adapter for this domain.",
          nextAction:
            "Set founder-default launchDefaults.dns.adapter to manual_generic or mijndomein_manual, then rerun stack doctor.",
        },
        "waiting_for_external_action",
      );
    }
    const diagnostic = doctor?.roles.find((candidate) => candidate.role === role);
    if (!diagnostic) {
      addRoleIssue(
        {
          code: "stack_role_not_ready",
          role,
          provider: definitionProvider,
          message: `Founder Stack role ${role} has not been checked by the read-only doctor.`,
          nextAction: "Run vh stack doctor founder-default, then rerun the launch dry-run.",
        },
        "waiting_for_auth",
      );
    } else if (
      accountId &&
      credentialReady &&
      dnsAdapterReady &&
      diagnostic.status !== "ready" &&
      !(role === "dns.records" && diagnostic.status === "manual_only")
    ) {
      addRoleIssue(
        {
          code: "stack_role_not_ready",
          role,
          provider: definitionProvider,
          message: `Founder Stack role ${role} is ${diagnostic.status}; no provider effect is authorized.`,
          nextAction: diagnostic.nextCommand,
        },
        "waiting_for_auth",
        diagnostic.blocksLaunch && blockingRoles.has(role),
      );
    }
  }
  if (compiled.brief.domain) {
    launchGaps.push({
      code: "custom_domain_deferred",
      role: "dns.records",
      provider: "dns",
      message: `The requested custom domain ${compiled.brief.domain} is deferred until Vercel attachment and authoritative DNS can be verified in a separately authorized action.`,
      nextAction: `Attach ${compiled.brief.domain}, apply the consolidated additive DNS records, and verify authoritative DNS before selecting it as canonical.`,
      state: "waiting_for_external_action",
      blocksLaunch: false,
    });
  }
  if (compiled.brief.needs.transactional_email || compiled.brief.needs.lifecycle_email) {
    launchGaps.push({
      code: "optional_integration_deferred",
      role: "email.transactional",
      provider: "brevo",
      message: "Transactional email is selected but deferred from the initial provider-URL launch.",
      nextAction:
        "Authorize a separate Brevo action, verify the sending domain and sender, bind the credential reference, and redeploy before claiming email readiness.",
      state: "waiting_for_external_action",
      blocksLaunch: false,
    });
  }
  if (compiled.brief.needs.analytics) {
    launchGaps.push({
      code: "optional_integration_deferred",
      role: "growth.google",
      provider: "google",
      message: "Google Analytics is selected but deferred from the initial provider-URL launch.",
      nextAction:
        "Authorize a separate Google Analytics action, read the property and stream back, bind the public measurement identifier, and redeploy before claiming analytics readiness.",
      state: "waiting_for_external_action",
      blocksLaunch: false,
    });
  }
  if (compiled.brief.needs.search_discovery) {
    launchGaps.push(
      {
        code: "optional_integration_deferred",
        role: "growth.google",
        provider: "google",
        message:
          "Google Search Console verification is selected but deferred from the initial provider-URL launch.",
        nextAction:
          "After the custom domain is authoritative, authorize Google ownership verification and read the property and sitemap submission back without inferring indexation.",
        state: "waiting_for_external_action",
        blocksLaunch: false,
      },
      {
        code: "optional_integration_deferred",
        role: "search.bing",
        provider: "bing",
        message:
          "Bing Webmaster discovery is selected but deferred from the initial provider-URL launch.",
        nextAction:
          "After the public origin is final, authorize Bing site and sitemap setup and read acceptance back without inferring indexation.",
        state: "waiting_for_external_action",
        blocksLaunch: false,
      },
    );
  }
  const unique = <T extends FounderLaunchBlocker>(items: readonly T[]): T[] =>
    items.filter(
      (item, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.code === item.code &&
            candidate.role === item.role &&
            candidate.message === item.message,
        ) === index,
    );
  return { blockers: unique(blockers), launchGaps: unique(launchGaps) };
}

export function compileFounderLaunchPreparation(
  input: FounderLaunchPreparationInput,
): FounderLaunchPreparation {
  if (input.executionMode === "apply" && (!input.production || !input.nonInteractive)) {
    throw new Error("Founder launch apply requires --production and --non-interactive");
  }
  if (!/^[a-f0-9]{40}$/u.test(input.workflowRefSha)) {
    throw new Error("Founder launch requires an immutable 40-character workflow reference SHA");
  }
  const connection = parseFounderStackConnection(input.stack);
  const idea = compileFounderIdea(input.ideaSource);
  const decision = idea.launchContract
    ? launchDecisionFromContract(idea.launchContract)
    : undefined;
  const dryRun = compileLaunchDryRun(idea.brief, decision, {
    initialOrigin: "provider_url",
  });
  const activeProviders = new Set<string>(
    dryRun.graph.nodes.flatMap((node) => {
      const provider = launchProviderByNode[node.id as keyof typeof launchProviderByNode];
      return provider ? [provider] : [];
    }),
  );
  const roles = requiredRoles(idea.brief, dryRun.decision.payment.provider).filter((role) =>
    activeProviders.has(providerForRole(role)),
  );
  const outputDirectory = containedOutput(input.baseDir, input.output, idea.brief.id);
  const repositoryOwner =
    accountIdFor(connection, "source.repository") ?? connection.ownerOrganizationId;
  const allowedExternalEffects = effectsFor(idea.brief, dryRun.decision.payment.provider);
  const maxBuildAgentTasks = launchBuildAgentTaskCount(dryRun.graph);
  const maxProviderOperations = Math.max(1, launchProviderOperationCeiling(dryRun.graph));
  const grant = createLaunchGrant({
    ownerOrganizationId: connection.ownerOrganizationId,
    ventureName: idea.brief.name,
    ventureSlug: idea.brief.id,
    ideaDigest: idea.launchContract ? launchContractDigest(idea.launchContract) : idea.sourceHash,
    seed: { id: founderSeedFor(idea.brief, idea.launchContract), version: CORE_VERSION },
    stackProfile: { id: connection.profileId, version: STACK_VERSION },
    repository: {
      owner: repositoryOwner,
      name: idea.brief.id,
      visibility: idea.brief.repository_visibility ?? "private",
    },
    providerAccounts: providerAccounts(connection, dryRun.graph),
    autonomyProfile: input.executionMode === "apply" ? "owner_live_launch" : "plan_only",
    allowedExternalEffects: [...allowedExternalEffects],
    modelExecutionPolicy: idea.brief.synthetic
      ? {
          mode: "fixture_no_model_execution",
          maxBuildAgentTasks,
          attestation: "fixture_build_host",
          usageAccounting: "none",
        }
      : {
          mode: "chatgpt_subscription_non_metered",
          maxBuildAgentTasks,
          attestation: "codex_login_status_chatgpt_subscription",
          usageAccounting: "observational",
        },
    providerOperationBudget: {
      maxOperations: maxProviderOperations,
      maxDirectChargeMinorUnits: 0,
      currency: idea.commercialTerms.currency,
      estimateBasis: "reviewed_known_zero_direct_charge",
      ongoingAccountPlanUsageCovered: false,
    },
    permissions: {
      productionDeployment: input.production,
      domainConfiguration: false,
      liveCommerceConfiguration: input.production && dryRun.decision.payment.provider !== "none",
    },
    createdAt: input.at.toISOString(),
    expiresAt: new Date(input.at.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
    grantedBy: { actorId: input.actorId ?? "local-founder", actorType: "founder" },
    approvalRef: `cli:founder-one-prompt:${sha256(`${idea.sourceHash}\u0000${connection.profileId}`).slice(0, 20)}`,
    revokedAt: null,
  });
  const materialization = compileVentureMaterialization({
    grant,
    at: input.at,
    coreVersion: CORE_VERSION,
    workflowRefSha: input.workflowRefSha,
    workflowRepository: input.workflowRepository,
    effects: [],
  });
  const stackOverrides = renderFounderStackProviderConfigOverrides(connection, {
    ventureSlug: idea.brief.id,
    domain: idea.brief.domain,
  });
  const { blockers, launchGaps } = readinessFor(
    idea,
    dryRun.decision.payment.provider,
    connection,
    roles,
    input.stackDoctor,
    input.allowFixtureStack ?? false,
  );
  const selectedProviders = roles.map((role) => {
    const selected = connection.roles[role];
    const renderedProvider = Object.entries(stackOverrides.providers).find(
      ([, candidate]) => candidate.credential_ref === selected.credentialRef,
    )?.[0];
    return {
      role,
      provider:
        renderedProvider ??
        (role === "source.repository"
          ? "github"
          : role === "hosting.web"
            ? "vercel"
            : role === "database.postgres"
              ? "neon"
              : role === "commerce.web"
                ? "stripe"
                : role === "commerce.native"
                  ? "revenuecat"
                  : role === "email.transactional"
                    ? "brevo"
                    : role === "growth.google"
                      ? "google"
                      : role === "search.bing"
                        ? "bing"
                        : "dns"),
      accountId: selected.accountId ?? null,
      teamId: selected.teamId ?? null,
      organizationId: selected.organizationId ?? null,
      credentialRef: selected.credentialRef ?? null,
      verification: selected.verification.status,
    };
  });
  const environmentVariables = roles.flatMap((role) =>
    (
      (ENVIRONMENT_BINDINGS as Partial<Record<FounderStackRole, readonly string[]>>)[role] ?? []
    ).map((name: string) => ({
      name,
      sourceRole: role,
      valuePersisted: false as const,
    })),
  );
  const migrations = materialization.files
    .filter(({ path }) => path.startsWith("migrations/") && path.endsWith(".up.sql"))
    .map(({ path }) => path);
  const ideaArgument = quoteCli(input.ideaPath);
  const domainMode: FounderLaunchPreparation["domain"]["mode"] = !idea.brief.domain
    ? "none"
    : connection.roles["dns.records"].credentialRef
      ? "automatic_if_adapter_available"
      : "manual_consolidated_action";
  const setup: FounderLaunchPreparation["setup"] = {
    analytics: idea.brief.needs.analytics ? "google_analytics" : "not_requested",
    search: idea.brief.needs.search_discovery ? "google_search_console_and_bing" : "not_requested",
    email: idea.brief.needs.transactional_email ? "brevo_transactional" : "not_requested",
    commerce:
      dryRun.decision.payment.provider === "stripe"
        ? "stripe_test_mode"
        : dryRun.decision.payment.provider === "revenuecat"
          ? "revenuecat_test_mode"
          : "none",
  };
  return Object.freeze({
    schemaVersion: 1,
    status: blockers.length === 0 ? "ready" : "blocked",
    executionMode: input.executionMode,
    production: input.production,
    nonInteractive: input.nonInteractive,
    idea,
    selectedVentureType: {
      mode: dryRun.decision.mode.selectedMode,
      rail: dryRun.decision.rail.appKind,
      seed: materialization.grant.seed,
      commerce: dryRun.decision.payment.provider,
    },
    stackProfile: connection.profileId,
    selectedProviders,
    repository: {
      owner: repositoryOwner,
      name: idea.brief.id,
      visibility: idea.brief.repository_visibility ?? "private",
      localDirectory: outputDirectory,
    },
    resources: dryRun.resources,
    environmentVariables,
    migrations,
    domain: {
      requested: idea.brief.domain ?? null,
      mode: domainMode,
      expectedRecords: idea.brief.domain
        ? ["Vercel attachment records", "Google site-verification TXT", "Brevo mail records"]
        : [],
      canonicalOrigin:
        "provider_production_url" as FounderLaunchPreparation["domain"]["canonicalOrigin"],
      pendingAction: idea.brief.domain
        ? domainMode === "automatic_if_adapter_available"
          ? "Attach the domain through the installed DNS adapter, then read authoritative DNS back before treating it as canonical."
          : "Apply the consolidated DNS action for this domain, then read authoritative DNS back before treating it as canonical."
        : null,
    },
    setup,
    estimatedExternalEffects: allowedExternalEffects,
    launchGrant: grant,
    grantDisposition:
      blockers.length > 0
        ? "withheld_blocked"
        : input.executionMode === "apply"
          ? "issued_for_apply"
          : "proposed_not_issued",
    materialization,
    graphDryRun: dryRun,
    blockers,
    launchGaps,
    exactFinalCommand: `vh launch --idea ${ideaArgument} --stack founder-default --production --apply --non-interactive`,
  });
}

export async function materializeFounderVenture(
  preparation: FounderLaunchPreparation,
  targetDirectory = preparation.repository.localDirectory,
): Promise<{ status: "materialized"; files: readonly string[]; planDigest: string }> {
  if (preparation.executionMode !== "apply") {
    throw new Error("A founder dry-run cannot materialize a venture directory");
  }
  if (preparation.status !== "ready" || preparation.grantDisposition !== "issued_for_apply") {
    throw new Error("A blocked founder launch cannot materialize or issue its Launch Grant");
  }
  return materializeVenture(
    preparation.materialization,
    new NodeMaterializationFileSystem(targetDirectory),
    new Date(preparation.launchGrant.createdAt),
  );
}
